import asyncio
import time
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.services.connection_recovery import (
    AdaptiveConnectionRecoveryManager,
    ConnectionState,
    RecoveryReason,
    RecoveryScope,
    RecoveryConfig,
)
from app.services.rate_governor import RateGovernor


@pytest.fixture
def acrm():
    config = RecoveryConfig(
        connection_timeout=2.0,
        min_backoff=0.05,
        max_backoff=0.2,
        max_recovery_attempts=3,
        idle_disconnect=10.0,
        health_interval=5.0,
        initial_chunk_timeout=2.0,
    )
    return AdaptiveConnectionRecoveryManager(config=config)


@pytest.mark.asyncio
async def test_acrm_initial_state_connected(acrm):
    scope = RecoveryScope(tenant_id="t1", account_id="acc1", dc_id=2, transport="telethon")
    assert acrm.get_state(scope) == ConnectionState.CONNECTED


@pytest.mark.asyncio
async def test_acrm_single_flight_ten_concurrent_requests(acrm):
    """
    Acceptance Criteria 4:
    Trigger 10 simultaneous failed chunk requests and verify ONE coordinated reconnect
    per affected connection scope.
    """
    scope = RecoveryScope(tenant_id="t1", account_id="acc1", dc_id=2, transport="telethon")
    reconnect_mock = AsyncMock(return_value=True)
    verify_mock = AsyncMock(return_value=True)

    # Launch 10 simultaneous recovery attempts
    async def caller():
        return await acrm.recover_connection(
            scope=scope,
            reason=RecoveryReason.SOCKET_RESET,
            on_reconnect_coro=reconnect_mock,
            verify_coro=verify_mock,
        )

    results = await asyncio.gather(*[caller() for _ in range(10)])

    # All 10 callers must succeed with CONNECTED
    assert len(results) == 10
    assert all(r == ConnectionState.CONNECTED for r in results)

    # Exactly ONE single-flight reconnect and verify must have executed!
    assert reconnect_mock.call_count == 1
    assert verify_mock.call_count == 1
    assert acrm.get_state(scope) == ConnectionState.CONNECTED


@pytest.mark.asyncio
async def test_acrm_caller_cancellation_preserves_shared_recovery(acrm):
    """
    Cancellation safety:
    Cancelling one or more waiting requests must NOT cancel the shared single-flight
    recovery task for remaining callers.
    """
    scope = RecoveryScope(tenant_id="t1", account_id="acc1", dc_id=2, transport="telethon")

    async def slow_reconnect():
        await asyncio.sleep(0.1)
        return True

    task1 = asyncio.create_task(
        acrm.recover_connection(
            scope=scope,
            reason=RecoveryReason.SOCKET_RESET,
            on_reconnect_coro=slow_reconnect,
        )
    )
    task2 = asyncio.create_task(
        acrm.recover_connection(
            scope=scope,
            reason=RecoveryReason.SOCKET_RESET,
            on_reconnect_coro=slow_reconnect,
        )
    )

    await asyncio.sleep(0.02)
    # Cancel caller 1
    task1.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task1

    # Caller 2 must still complete successfully!
    res2 = await task2
    assert res2 == ConnectionState.CONNECTED
    assert acrm.get_state(scope) == ConnectionState.CONNECTED


@pytest.mark.asyncio
async def test_acrm_mandatory_flood_wait_cooldown_no_reconnect_attempts(acrm):
    """
    Acceptance Criteria 5:
    Simulate a Telegram FloodWait and verify no network retries bypass it.
    FloodWait state is COOLDOWN, not network disconnection.
    """
    scope = RecoveryScope(tenant_id="t1", account_id="acc1", dc_id=2, transport="telethon")
    reconnect_mock = AsyncMock(return_value=True)

    from app.services.rate_governor import rate_governor
    rate_governor.report_flood_wait(5, reason="Simulated FloodWait")
    try:
        state = await acrm.recover_connection(
            scope=scope,
            reason=RecoveryReason.FLOOD_WAIT,
            on_reconnect_coro=reconnect_mock,
        )

        assert state == ConnectionState.COOLDOWN
        assert acrm.get_state(scope) == ConnectionState.COOLDOWN
        # Zero network reconnect calls must be dispatched!
        assert reconnect_mock.call_count == 0
    finally:
        rate_governor.reset()


@pytest.mark.asyncio
async def test_acrm_quarantine_revoked_session(acrm):
    """
    Acceptance Criteria 3 & 7:
    AUTH_KEY_UNREGISTERED / SESSION_REVOKED quarantines the scope as AUTH_REQUIRED
    without infinite reconnect loops.
    """
    scope = RecoveryScope(tenant_id="t1", account_id="acc1", dc_id=2, transport="telethon")

    async def revoked_reconnect():
        raise RuntimeError("AUTH_KEY_UNREGISTERED")

    state = await acrm.recover_connection(
        scope=scope,
        reason=RecoveryReason.SESSION_REVOKED,
        on_reconnect_coro=revoked_reconnect,
    )

    assert state == ConnectionState.AUTH_REQUIRED
    assert acrm.is_quarantined(scope)
    assert acrm.get_state(scope) == ConnectionState.AUTH_REQUIRED

    # Subsequent calls must immediately fail closed as AUTH_REQUIRED
    reconnect_dummy = AsyncMock()
    state2 = await acrm.recover_connection(
        scope=scope,
        reason=RecoveryReason.SOCKET_RESET,
        on_reconnect_coro=reconnect_dummy,
    )
    assert state2 == ConnectionState.AUTH_REQUIRED
    assert reconnect_dummy.call_count == 0


@pytest.mark.asyncio
async def test_acrm_multi_tenant_scope_isolation(acrm):
    """
    Acceptance Criteria 9:
    Verify no tenant can cancel or reconnect another tenant's client.
    """
    scope_a = RecoveryScope(tenant_id="tenant_A", account_id="acc_A", dc_id=2, transport="telethon")
    scope_b = RecoveryScope(tenant_id="tenant_B", account_id="acc_B", dc_id=2, transport="telethon")

    reconnect_a = AsyncMock(return_value=True)
    reconnect_b = AsyncMock(return_value=True)

    # Recover Tenant A
    res_a = await acrm.recover_connection(scope=scope_a, reason=RecoveryReason.SOCKET_RESET, on_reconnect_coro=reconnect_a)
    assert res_a == ConnectionState.CONNECTED
    assert reconnect_a.call_count == 1
    assert reconnect_b.call_count == 0

    # Tenant B state remains independent
    assert acrm.get_state(scope_b) == ConnectionState.CONNECTED

    # Quarantine Tenant A; Tenant B must remain unquarantined
    acrm.quarantine_session(scope_a, "Tenant A manual quarantine")
    assert acrm.is_quarantined(scope_a)
    assert not acrm.is_quarantined(scope_b)


@pytest.mark.asyncio
async def test_acrm_retry_budget_exhaustion_marks_degraded(acrm):
    """
    Transient failures exceeding max_recovery_attempts transition cleanly to DEGRADED
    without hanging or crashing.
    """
    scope = RecoveryScope(tenant_id="t1", account_id="acc1", dc_id=2, transport="telethon")
    failing_reconnect = AsyncMock(side_effect=ConnectionResetError("Connection reset by peer"))

    state = await acrm.recover_connection(
        scope=scope,
        reason=RecoveryReason.SOCKET_RESET,
        on_reconnect_coro=failing_reconnect,
    )

    assert state == ConnectionState.DEGRADED
    assert acrm.get_state(scope) == ConnectionState.DEGRADED
    assert failing_reconnect.call_count == acrm.config.max_recovery_attempts


@pytest.mark.asyncio
async def test_acrm_network_monitor_event_notification(acrm):
    """
    Acceptance Criteria 1 & 2:
    Network interface changes transition states without deleting sessions.
    """
    scope = RecoveryScope(tenant_id="t1", account_id="acc1", dc_id=2, transport="telethon")
    acrm.set_state(scope, ConnectionState.CONNECTED)

    # Carrier drops
    await acrm.notify_network_changed(online=False, reason="carrier_down")
    assert acrm.get_state(scope) == ConnectionState.DEGRADED

    # Carrier restores
    await acrm.notify_network_changed(online=True, reason="reconnected")
    assert acrm.get_state(scope) == ConnectionState.RECOVERING


def test_acrm_jittered_backoff_formula(acrm):
    """
    Verify capped exponential backoff with full randomized jitter:
    d_n = U(0, min(d_max, d_0 * 2^n))
    """
    config = RecoveryConfig(min_backoff=0.5, max_backoff=30.0)
    for attempt in range(6):
        delay = config.compute_backoff(attempt)
        cap = min(30.0, 0.5 * (2 ** attempt))
        assert 0.0 <= delay <= cap
