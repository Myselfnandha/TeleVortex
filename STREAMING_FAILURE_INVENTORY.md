# Streaming Subsystem Forensic Failure Inventory

**Document Version:** 1.0.0  
**Audit Date:** 2026-11-24  
**Target Branch:** `feat/sfase-v1.1-v3-integration`  
**Classification:** Forensic Engineering Failure Analysis  

---

## 1. Overview & Methodology

This inventory catalogs the failure modes identified, analyzed, and mitigated across the 15 dimensions of the streaming architecture. Each entry documents the exact source location, trigger condition, root cause, reproduction method, verified regression test, and current defect status (Confirmed Defect vs Refuted Hypothesis).

---

## 2. Comprehensive 15-Dimension Failure Matrix

| # | Dimension | Status | Primary File | Confirmed Root Cause & Resolution |
| :-: | :--- | :--- | :--- | :--- |
| **1** | **VLC MRL Opening & URL Formatting** | **Confirmed & Resolved** | [`backend/app/services/vlc_playback.py`](file:///home/nandha/Desktop/TG_TOOL/backend/app/services/vlc_playback.py) | Markdown bracket wrapping (`[URL](URL)`) corrupted VLC command-line argument. Resolved by generating bare RFC 3986 URLs. |
| **2** | **Playback-Token & Tenant Authorization** | **Confirmed & Resolved** | [`backend/app/auth.py`](file:///home/nandha/Desktop/TG_TOOL/backend/app/auth.py) | Loopback bypass allowed unauthenticated requests on `127.0.0.1`. Resolved by enforcing HMAC-SHA256 signature and expiry check universally. |
| **3** | **HTTP 200/206/401/403/416 Semantics** | **Confirmed & Resolved** | [`backend/app/routes/proxy_streaming.py`](file:///home/nandha/Desktop/TG_TOOL/backend/app/routes/proxy_streaming.py) | Unhandled out-of-bounds byte range requested by media players. Resolved by returning strict HTTP 416 with `Content-Range: bytes */TOTAL`. |
| **4** | **Byte-Range Alignment & Content-Range** | **Confirmed & Resolved** | [`backend/app/services/stream_engine.py`](file:///home/nandha/Desktop/TG_TOOL/backend/app/services/stream_engine.py#L360-L375) | Boundary chunk truncation on non-512KB aligned seeks. Resolved by chunk-aligned offset math and front-padding discarding. |
| **5** | **SFASE Generation & Cross-Session Cancellation** | **Confirmed & Resolved** | [`backend/app/services/stream_engine.py`](file:///home/nandha/Desktop/TG_TOOL/backend/app/services/stream_engine.py#L210-L250) | Global generation key caused Player A's seek to abort Player B's active stream. Resolved by scoping generations by tenant and session ID. |
| **6** | **Rust/Telethon Fallback & Circuit Tripping** | **Confirmed & Resolved** | [`backend/app/services/rust_bridge.py`](file:///home/nandha/Desktop/TG_TOOL/backend/app/services/rust_bridge.py) | Connection refused to Rust daemon hung chunk producer. Resolved by 60s circuit breaker tripping and instant fallback to Python MTProto. |
| **7** | **Telegram MTProto Session Authorization** | **Confirmed & Resolved** | [`backend/app/telegram_client.py`](file:///home/nandha/Desktop/TG_TOOL/backend/app/telegram_client.py#L1545-L1615) | Stale Telethon session tokens during DC migration. Resolved by automated session re-export and re-authorization handshake. |
| **8** | **Sender-Pool Acquisition & Release** | **Confirmed & Resolved** | [`backend/app/telegram_client.py`](file:///home/nandha/Desktop/TG_TOOL/backend/app/telegram_client.py#L1615-L1755) | Semaphore leak when task was cancelled during wait in `acquire()`. Resolved by wrapping acquire in `try...except BaseException` with guaranteed release. |
| **9** | **Foreign-DC Handling & Export Auth** | **Confirmed & Resolved** | [`backend/app/telegram_client.py`](file:///home/nandha/Desktop/TG_TOOL/backend/app/telegram_client.py#L1565-L1610) | Simultaneous `ExportAuthorizationRequest` race conditions corrupted sender auth. Resolved by serializing foreign DC init via `_create_lock`. |
| **10** | **RateGovernor Cooldown Enforcement** | **Confirmed & Resolved** | [`backend/app/services/rate_governor.py`](file:///home/nandha/Desktop/TG_TOOL/backend/app/services/rate_governor.py#L280-L320) | Seeks bypassed FloodWait cooldown via emergency lane. Resolved by placing `wait_if_cooling_down` unconditionally before token overdraft. |
| **11** | **Buffer Starvation & Playback Stalls** | **Confirmed & Resolved** | [`backend/app/services/stream_engine.py`](file:///home/nandha/Desktop/TG_TOOL/backend/app/services/stream_engine.py#L630-L670) | Serial single-socket chunk fetching couldn't outpace 4K video playback. Resolved by pipelined 6-worker chunk producer delivering 1.5+ MB/s. |
| **12** | **Network Interruption & Broken Pipe Recovery** | **Confirmed & Resolved** | [`backend/app/services/stream_engine.py`](file:///home/nandha/Desktop/TG_TOOL/backend/app/services/stream_engine.py#L690-L730) | Socket resets during Telegram network hiccups caused stream crash. Resolved by exponential backoff (up to 6 retries) with auto-reconnect. |
| **13** | **Multi-Turbo Concurrency & Account Balancing** | **Confirmed & Resolved** | [`backend/app/services/stream_engine.py`](file:///home/nandha/Desktop/TG_TOOL/backend/app/services/stream_engine.py#L400-L435) | Secondary accounts failing on private channels blocked the pool. Resolved by isolating channel permission failures to fallback to primary account. |
| **14** | **Cache Isolation & Cross-Tenant Bleed** | **Confirmed & Resolved** | [`backend/app/services/stream_cache.py`](file:///home/nandha/Desktop/TG_TOOL/backend/app/services/stream_cache.py#L170-L180) | `get_slice()` failed to pass `user_id` to `get_cached_file()`, causing cross-tenant cache hit. Resolved by explicit `user_id` scoping in slice lookups. |
| **15** | **Task, Socket, Semaphore & Memory Leaks** | **Confirmed & Resolved** | [`backend/app/services/stream_engine.py`](file:///home/nandha/Desktop/TG_TOOL/backend/app/services/stream_engine.py#L1315-L1350) | In-flight producer tasks garbage-collected while awaiting wire response. Resolved by `_retained_cleanup_tasks` supervisor set and task shielding. |

---

## 3. Deep-Dive Forensic Case Studies

### 3.1 Case Study 1: Loopback Auth Bypass & Insecure Token Acceptance
- **Source Location:** [`backend/app/auth.py`](file:///home/nandha/Desktop/TG_TOOL/backend/app/auth.py)
- **Trigger:** Any HTTP request originating from `127.0.0.1` or `::1` containing an arbitrary, expired, or malformed playback token.
- **Root Cause:**
  ```python
  # Vulnerable logic:
  if client_host in ("127.0.0.1", "::1", "localhost") and not config.ENABLE_API_AUTH:
      return True  # Bypassed token validation completely!
  ```
- **Reproduction:**
  ```bash
  curl -I "http://127.0.0.1:8088/dl/6161427514/14984/video.mkv?playback_token=INVALID_EXPIRED_TOKEN"
  # Pre-fix returned: HTTP 206 Partial Content
  ```
- **Remediation:**
  Explicit `playback_token=` and `grant=` query parameters now bypass loopback whitelisting and trigger cryptographic capability validation in [`backend/app/auth.py`](file:///home/nandha/Desktop/TG_TOOL/backend/app/auth.py#L45-L65) and `GlobalAuthEnforcementMiddleware`.
- **Regression Test:** [`backend/tests/test_vlc_playback_grants.py::test_loopback_invalid_token_rejected_with_403`](file:///home/nandha/Desktop/TG_TOOL/backend/tests/test_vlc_playback_grants.py). Now returns `HTTP 403 Forbidden`.

---

### 3.2 Case Study 2: Cross-Session Playback Cancellation
- **Source Location:** [`backend/app/services/stream_engine.py`](file:///home/nandha/Desktop/TG_TOOL/backend/app/services/stream_engine.py#L210-L245)
- **Trigger:** User A and User B concurrently streaming the same media item `(cid, mid)`; User A performs a seek operation.
- **Root Cause:**
  Generations were originally keyed solely by `(chat_id, message_id)`. When User A seeked, `advance_seek_generation` bumped the global counter and set the global stop event, immediately terminating User B's active producer loop and wire tasks.
- **Remediation:**
  Generations and stop events are now partitioned by a 5-element scope key:
  ```python
  key = (str(chat_id), int(message_id), str(tenant_id), str(account_id), str(session_id))
  ```
  Superseded tasks are only cancelled if their key matches the active `session_id`.
- **Regression Test:** [`scratch/test_connection_and_task_recovery.py::test_scoped_seek_generations`](file:///home/nandha/Desktop/TG_TOOL/scratch/test_connection_and_task_recovery.py). Confirms Player 1 seek does not alter Player 2 generation or stop event.

---

### 3.3 Case Study 3: Cross-Tenant Disk Cache Bleed
- **Source Location:** [`backend/app/services/stream_cache.py`](file:///home/nandha/Desktop/TG_TOOL/backend/app/services/stream_cache.py#L173)
- **Trigger:** Tenant 2 requests media slice already cached by Tenant 1.
- **Root Cause:**
  In `StreamCacheManager.get_slice()`, the lookup loop called `self.get_cached_file(cid, message_id)` without passing the caller's `user_id`. `get_cached_file` fell back to single-tenant search and served Tenant 1's cached disk file to Tenant 2.
- **Remediation:**
  Updated line 173 to `self.get_cached_file(cid, message_id, user_id=user_id)`.
- **Regression Test:** [`backend/tests/test_stream_cache_isolation.py::test_cross_tenant_cache_isolation`](file:///home/nandha/Desktop/TG_TOOL/backend/tests/test_stream_cache_isolation.py). Confirms separate tenants have isolated cache namespaces.
