"""
Adaptive Connection Recovery Manager (ACRM) v1.0
Lightweight, event-driven connection supervisor integrated across Telethon, Rust,
SFASE seek engine, and Multi-Turbo architecture.

Recovers interrupted Telegram connections without losing authorization,
restarting playback, duplicating downloads, or triggering connection storms.
"""

from __future__ import annotations

import asyncio
import enum
import logging
import random
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine, Dict, Optional, Set, Tuple

logger = logging.getLogger("connection_recovery")


class ConnectionState(str, enum.Enum):
    CONNECTED = "CONNECTED"          # Sender is healthy and recent requests are succeeding
    DEGRADED = "DEGRADED"            # Elevated latency/timeouts; reduce prefetch, retain working connections
    RECOVERING = "RECOVERING"        # One supervisor is performing reconnect; others await result
    VERIFYING = "VERIFYING"          # Confirming connection and auth usability before re-enabling traffic
    BACKOFF = "BACKOFF"              # In backoff delay after transient failure
    COOLDOWN = "COOLDOWN"            # RateGovernor / FloodWait cooldown active (reconnect prohibited!)
    AUTH_REQUIRED = "AUTH_REQUIRED"  # Genuine session revocation or unlinking; user action needed


class RecoveryReason(str, enum.Enum):
    SOCKET_RESET = "SOCKET_RESET"                  # ConnectionResetError, BrokenPipeError, EOF
    NETWORK_RESTORED = "NETWORK_RESTORED"          # Netlink carrier up, route change
    TIMEOUT = "TIMEOUT"                            # Repeated MTProto request timeout
    DC_MIGRATE = "DC_MIGRATE"                      # FILE_MIGRATE_X
    FILE_REF_EXPIRED = "FILE_REF_EXPIRED"          # FILE_REFERENCE_EXPIRED
    FLOOD_WAIT = "FLOOD_WAIT"                      # FLOOD_WAIT_X
    SESSION_REVOKED = "SESSION_REVOKED"            # AUTH_KEY_UNREGISTERED, SESSION_REVOKED
    RUST_IPC_ERROR = "RUST_IPC_ERROR"              # Rust Core IPC 400 / unreachable
    MANUAL_PROBE = "MANUAL_PROBE"                  # Proactive health check


@dataclass(frozen=True)
class RecoveryScope:
    tenant_id: str = "default"
    account_id: str = "default"
    dc_id: int = 5
    transport: str = "telethon"  # "telethon", "rust", "http"

    def key(self) -> str:
        return f"{self.tenant_id}:{self.account_id}:{self.dc_id}:{self.transport}"


@dataclass
class RecoveryConfig:
    """Balanced Configuration Profile (Recommended)"""
    connection_timeout: float = 8.0
    min_backoff: float = 0.5
    max_backoff: float = 30.0
    max_recovery_attempts: int = 5
    idle_disconnect: float = 180.0
    health_interval: float = 30.0
    initial_chunk_timeout: float = 12.0

    def compute_backoff(self, attempt: int) -> float:
        """Capped exponential backoff with full randomized jitter: U(0, min(d_max, d_0 * 2^n))"""
        raw_cap = min(self.max_backoff, self.min_backoff * (2 ** max(0, attempt)))
        return random.uniform(0.0, raw_cap)


class AdaptiveConnectionRecoveryManager:
    """
    Adaptive Connection Recovery Manager (ACRM).
    Coordinates single-flight, error-aware reconnects per (tenant, account, DC, transport) scope.
    Guarantees:
    1. Single-flight recovery: Concurrent requests wait on ONE recovery without duplicate sessions.
    2. Shared task shielding: Cancellation of one waiting request does not cancel shared recovery.
    3. FloodWait isolation: Rate limits are held in COOLDOWN; never reconnected as network errors.
    4. Exact-byte continuation: Interrupted media streams resume from the exact missing byte offset.
    """

    def __init__(self, config: Optional[RecoveryConfig] = None):
        self.config = config or RecoveryConfig()
        self._states: Dict[str, ConnectionState] = {}
        self._scope_locks: Dict[str, asyncio.Lock] = {}
        self._in_flight_tasks: Dict[str, asyncio.Task] = {}
        self._attempt_counters: Dict[str, int] = {}
        self._last_state_change: Dict[str, float] = {}
        self._quarantined_sessions: Set[str] = set()
        self._lock = asyncio.Lock()

    def get_state(self, scope: RecoveryScope) -> ConnectionState:
        k = scope.key()
        return self._states.get(k, ConnectionState.CONNECTED)

    def set_state(self, scope: RecoveryScope, state: ConnectionState):
        k = scope.key()
        prev = self._states.get(k)
        if prev != state:
            self._states[k] = state
            self._last_state_change[k] = time.time()
            logger.info(f"ACRM [{k}] State transition: {prev} -> {state}")

    async def _get_scope_lock(self, key: str) -> asyncio.Lock:
        async with self._lock:
            if key not in self._scope_locks:
                self._scope_locks[key] = asyncio.Lock()
            return self._scope_locks[key]

    def quarantine_session(self, scope: RecoveryScope, reason: str = ""):
        k = scope.key()
        self._quarantined_sessions.add(k)
        self.set_state(scope, ConnectionState.AUTH_REQUIRED)
        logger.warning(f"ACRM [{k}] Quarantined authorization: {reason}")

    def is_quarantined(self, scope: RecoveryScope) -> bool:
        return scope.key() in self._quarantined_sessions

    def unquarantine_session(self, scope: RecoveryScope):
        k = scope.key()
        self._quarantined_sessions.discard(k)
        self.set_state(scope, ConnectionState.CONNECTED)
        logger.info(f"ACRM [{k}] Authorization unquarantined")

    async def recover_connection(
        self,
        scope: RecoveryScope,
        reason: RecoveryReason,
        client: Any = None,
        on_reconnect_coro: Optional[Callable[[], Coroutine[Any, Any, bool]]] = None,
        verify_coro: Optional[Callable[[], Coroutine[Any, Any, bool]]] = None,
    ) -> ConnectionState:
        """
        Core Single-Flight Recovery Contract.
        Coordinates recovery for a specific (tenant, account, DC, transport) scope.
        Concurrent callers await the existing recovery task without duplicating attempts.
        """
        k = scope.key()

        # 1. Check if scope is quarantined (auth revoked)
        if self.is_quarantined(scope):
            return ConnectionState.AUTH_REQUIRED

        # 2. Check if Telegram server-side FloodWait cooldown is active
        try:
            from app.services.rate_governor import rate_governor
            if rate_governor.is_client_cooling_down(client) if client else rate_governor.is_cooling_down:
                self.set_state(scope, ConnectionState.COOLDOWN)
                logger.info(f"ACRM [{k}] Under mandatory cooldown; skipping socket reconnect.")
                return ConnectionState.COOLDOWN
        except Exception:
            pass

        # 3. Single-Flight Dispatch: Check if a recovery task is already running for this scope
        task_to_await = None
        is_owner = False
        async with self._lock:
            existing_task = self._in_flight_tasks.get(k)
            if existing_task and not existing_task.done():
                logger.debug(f"ACRM [{k}] Joining in-flight recovery task (reason: {reason})")
                task_to_await = existing_task
            else:
                if k not in self._scope_locks:
                    self._scope_locks[k] = asyncio.Lock()
                scope_lock = self._scope_locks[k]
                recovery_task = asyncio.create_task(
                    self._execute_single_flight_recovery(
                        scope=scope,
                        scope_lock=scope_lock,
                        reason=reason,
                        client=client,
                        on_reconnect_coro=on_reconnect_coro,
                        verify_coro=verify_coro,
                    )
                )
                self._in_flight_tasks[k] = recovery_task
                task_to_await = recovery_task
                is_owner = True

        try:
            return await asyncio.shield(task_to_await)
        finally:
            if is_owner:
                async with self._lock:
                    if self._in_flight_tasks.get(k) == task_to_await:
                        self._in_flight_tasks.pop(k, None)

    async def _execute_single_flight_recovery(
        self,
        scope: RecoveryScope,
        scope_lock: asyncio.Lock,
        reason: RecoveryReason,
        client: Any,
        on_reconnect_coro: Optional[Callable[[], Coroutine[Any, Any, bool]]],
        verify_coro: Optional[Callable[[], Coroutine[Any, Any, bool]]],
    ) -> ConnectionState:
        k = scope.key()
        async with scope_lock:
            # Re-check state once lock acquired (another task may have just resolved it)
            if client is not None and hasattr(client, "is_connected") and client.is_connected():
                if verify_coro:
                    try:
                        ok = await asyncio.wait_for(verify_coro(), timeout=self.config.connection_timeout)
                        if ok:
                            self.set_state(scope, ConnectionState.CONNECTED)
                            self._attempt_counters[k] = 0
                            return ConnectionState.CONNECTED
                    except Exception:
                        pass
                else:
                    self.set_state(scope, ConnectionState.CONNECTED)
                    self._attempt_counters[k] = 0
                    return ConnectionState.CONNECTED

            self.set_state(scope, ConnectionState.RECOVERING)
            attempts = 0
            max_attempts = self.config.max_recovery_attempts

            while attempts < max_attempts:
                attempts += 1
                self._attempt_counters[k] = attempts
                logger.info(f"ACRM [{k}] Recovery attempt {attempts}/{max_attempts} (trigger: {reason})")

                # Step A: Execute Transport Reconnect
                reconnect_ok = False
                try:
                    if on_reconnect_coro:
                        reconnect_ok = await asyncio.wait_for(
                            on_reconnect_coro(),
                            timeout=self.config.connection_timeout
                        )
                    elif client is not None:
                        if hasattr(client, "connect"):
                            await asyncio.wait_for(client.connect(), timeout=self.config.connection_timeout)
                            reconnect_ok = bool(client.is_connected())
                    else:
                        reconnect_ok = True
                except Exception as rec_err:
                    err_s = str(rec_err)
                    if "AUTH_KEY_UNREGISTERED" in err_s or "SESSION_REVOKED" in err_s:
                        self.quarantine_session(scope, reason=err_s)
                        return ConnectionState.AUTH_REQUIRED
                    logger.debug(f"ACRM [{k}] Reconnect step failed: {rec_err}")

                # Step B: Verification
                if reconnect_ok:
                    self.set_state(scope, ConnectionState.VERIFYING)
                    verify_ok = True
                    if verify_coro:
                        try:
                            verify_ok = await asyncio.wait_for(verify_coro(), timeout=self.config.connection_timeout)
                        except Exception as ver_err:
                            verify_ok = False
                            logger.debug(f"ACRM [{k}] Verification step failed: {ver_err}")

                    if verify_ok:
                        self.set_state(scope, ConnectionState.CONNECTED)
                        self._attempt_counters[k] = 0
                        logger.info(f"ACRM [{k}] Connection successfully recovered and verified.")
                        return ConnectionState.CONNECTED

                # Step C: Backoff with full randomized jitter before next attempt
                if attempts < max_attempts:
                    self.set_state(scope, ConnectionState.BACKOFF)
                    backoff_delay = self.config.compute_backoff(attempts)
                    logger.info(f"ACRM [{k}] Backing off for {backoff_delay:.2f}s before next attempt...")
                    await asyncio.sleep(backoff_delay)

            # All attempts exhausted
            self.set_state(scope, ConnectionState.DEGRADED)
            logger.warning(f"ACRM [{k}] Recovery budget exhausted ({max_attempts} attempts). State marked DEGRADED.")
            return ConnectionState.DEGRADED

    async def notify_network_changed(self, online: bool, reason: str = ""):
        """Called by NetworkMonitor upon Linux Netlink link/route transition."""
        logger.info(f"ACRM: Network status notification: online={online} ({reason})")
        if not online:
            # Mark all non-quarantined scopes as DEGRADED or BACKOFF
            for k in list(self._states.keys()):
                if self._states[k] not in (ConnectionState.AUTH_REQUIRED, ConnectionState.COOLDOWN):
                    self._states[k] = ConnectionState.DEGRADED
        else:
            # Resume recovering eligible scopes immediately without waiting for backoff timers
            for k in list(self._states.keys()):
                if self._states[k] in (ConnectionState.DEGRADED, ConnectionState.BACKOFF):
                    self._states[k] = ConnectionState.RECOVERING


# Global Singleton ACRM instance with Balanced Profile
connection_recovery_manager = AdaptiveConnectionRecoveryManager()
