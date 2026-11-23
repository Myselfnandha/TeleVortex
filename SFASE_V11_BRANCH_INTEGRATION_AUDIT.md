# SFASE v1.1 — Branch Integration & Compatibility Audit

**Target Version:** TG Power Suite v3.0 + SFASE v1.1  
**Integration Branch:** `feat/sfase-v1.1-v3-integration` (Commit: `0fa9b52`)  
**Base Release Candidate:** `feature/multi-tenant-persistent-turbo` (Commit: `99ba3e0`)  
**Source Safety Qualification:** `feat/sfase-v1.1-safety-qualification` (Commit: `8e67255`)  
**Mainline Production Branch:** `main` (Commit: `87b6fd4`)

---

## 1. Branch Ancestry & Common Ancestor Analysis

| Branch Comparison | Common Ancestor Commit | Commits Ahead / Behind | Architectural Scope |
|:---|:---|:---|:---|
| `feat/sfase-v1.1-safety-qualification` vs `main` | `87b6fd4` | +1 ahead, 0 behind | SFASE v1.1 safety hardening on top of SFASE v1.0 |
| `feature/multi-tenant-persistent-turbo` vs `main` | `653670f` | +16 ahead, +3 behind | v3.0 Multi-Tenant, PostgreSQL, Encrypted Vault, TurboPool |
| `feat/sfase-v1.1-safety-qualification` vs `feature/multi-tenant-persistent-turbo` | `653670f` | +4 ahead, +16 behind | Merge conflict point where multi-tenant features were pruned in `b654f33` |

### History Reconciliation
* On `main`, commits `b654f33` and `4d41001` pruned PostgreSQL and multi-tenant authentication gates to create a local-first single-tenant distribution, followed by `87b6fd4` which built SFASE v1.0.
* On `feature/multi-tenant-persistent-turbo`, commits `0736e9e` through `99ba3e0` developed the complete TG Power Suite v3.0 enterprise architecture:
  - Multi-user authentication with Argon2 password hashing and JWT/device sessions.
  - PostgreSQL persistence with SQLAlchemy asyncpg, advisory lock migration protection, and Alembic sync.
  - Encrypted Telegram session vault (`encrypted_sessions`).
  - `MultiTenantTelegramManager` providing tenant-scoped Telegram clients.
  - `TurboPool` providing multi-account streaming concurrency.
  - Time-limited HMAC playback grants (`/dl/{chat_id}/{message_id}?grant=...`).
  - Tenant-aware disk media caching (`user_id` directory scoping).
* **Integration Strategy:** Created dedicated branch `feat/sfase-v1.1-v3-integration` branched directly from `feature/multi-tenant-persistent-turbo` (`99ba3e0`). Ported SFASE v1.1 seek acceleration, generation scoping, rate governor bounded overdraft, and Rust session enhancements without altering v3.0 security or multi-tenant database models.

---

## 2. Integrated File Architecture & Conflict Resolutions

### 1. `backend/app/routes/proxy_streaming.py`
* **v3.0 Multi-Tenant Gate Intact:** Preserved `principal = getattr(request.state, "principal", None)`, `grant = getattr(request.state, "grant", None)`, `MULTI_TENANT_STREAMING_ENABLED` checks, and `stream_cache_service.get_cached_file(..., user_id=tenant_user_id)`.
* **SFASE v1.1 Integration:**
  - Injected `t_admission = time.monotonic()` for precise end-to-end timing.
  - Scoped active stream handles by `session_key = (tenant_id, account_id, norm_chat_id, message_id, playback_session_id, req_id)`.
  - Consolidated seek generation advancement to a single call scoped by tenant, account, and session.
  - Implemented `_safe_drain_task()` in `StreamIteratorHandle.close()` to cleanly terminate superseded background streaming loops without task leaks.
  - Forwarded `tenant_id`, `account_id`, `session_id`, and `t_admission` into `stream_engine.stream_media()`.

### 2. `backend/app/services/stream_engine.py`
* **ChunkTimingMetrics:** Added sub-millisecond stage telemetry (`t_admission`, `t_queue_wait_ms`, `t_rate_wait_ms`, `t_lease_wait_ms`, `t_wire_ms`, `t_rust_wire_ms`, `t_py_wire_ms`, `t_fallback_ms`, `t_first_yield_ms`).
* **Seek Generation Scoping:** Scoped `_seek_generations` by `_scope_key(chat_id, message_id, tenant_id, account_id, session_id)`, preventing cross-tenant and cross-player playback cancellations.
* **Pipeline Telemetry Fix:** Pipelined queue yields `(data, metrics)` tuples directly, eliminating the zero-default wire timing bug.

### 3. `backend/app/services/rate_governor.py`
* **Tier Deduplication:** Preserved v3.0 `_current_tier_state` auto-tuning deduplication.
* **Bounded Overdraft:** Replaced unconditional seek bypass with bounded deficit capacity (`-self._capacity`). Seeks draw immediate 0ms reservation while debiting tokens; rapid repeated seeks beyond overdraft are paced safely.
* **Client-Level Cooldown:** Added `is_client_cooling_down`, `client_cooldown_remaining`, and `wait_if_cooling_down(client=...)`.

### 4. `backend/app/services/rust_bridge.py`
* **Loop & Directory Resilience:** Preserved v3.0 `_client_loop` re-binding and dynamic `TG_DATA_DIR` / `DATA_DIR` path passing.
* **Registration Quarantine:** Added `_invalid_session_hashes` to trap and quarantine HTTP 400 session rejection, eliminating repeated IPC retries without altering user credentials.
* **Circuit Tripping:** Implemented 60s circuit breaker trip on `SESSION_REVOKED` / `AUTH_KEY_UNREGISTERED` errors.

### 5. `backend/app/telegram_client.py`
* **Multi-Tenant Client Resolution:** Preserved `TelegramClientManager.get_client(principal=...)` routing through `multi_tenant_manager`.
* **Sender Pool Cancellation Safety:** Wrapped `sender_pool.acquire()` in clean cancellation handling to disconnect orphaned senders and prevent semaphore leaks.

### 6. `rust_core/src/session.rs`
* **275-Byte StringSession Support:** Added decoding for IPv6 275-byte Telethon sessions alongside standard 263-byte IPv4 sessions.
* **Foreign DC Key Purge:** Added `session_reauthenticated` check to purge stale foreign DC auth keys from SQLite when the home DC auth key changes, preventing `SESSION_REVOKED` crashes on foreign DCs.

---

## 3. Compatibility Verification Summary

```text
Component                     v3.0 Status     SFASE v1.1 Status    Integration Status
---------------------------------------------------------------------------------------
Authentication (Argon2/JWT)   Intact          Compatible           PASS
Encrypted Session Vault       Intact          Compatible           PASS
MultiTenantTelegramManager    Intact          Compatible           PASS
TurboPool Multi-Account       Intact          Compatible           PASS
Playback Grants (HMAC)        Intact          Compatible           PASS
Tenant Media Cache Scoping    Intact          Compatible           PASS
Seek Acceleration (SFASE)     N/A             Active               PASS
Rate Governor Overdraft       N/A             Active               PASS
Rust Core 275-byte Session    N/A             Active               PASS
```

**Verdict:** SFASE v1.1 is 100% compatible with TG Power Suite v3.0. No regressions, no schema alterations, and all enterprise security gates remain fully enforced.
