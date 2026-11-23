# SFASE v1.1 — MTProto Transport, Safety & Session Qualification

**Audit Date:** 2026-11-23 19:35:00 IST  
**Target:** MTProto Transport Layer, Rust Core IPC, Telethon Sender Pool, Rate Governor Safety

---

## 1. Cancellation & Resource Safety Audit (Task 3)

### Verification Matrix

| Vulnerability Risk | Mitigation in SFASE v1.1 | Verification Evidence | Status |
|:---|:---|:---|:---:|
| **Cross-Session Cancellation** | Scoped `_seek_generations` and `_ACTIVE_STREAM_ITERS` by `(tenant_id, account_id, norm_cid, message_id, session_id)` | Player Alpha seek to 10MB did not abort concurrent Player Beta stream at 800MB (gathered 262,144 bytes simultaneously) | **PASS** |
| **MTProto Semaphore Leaks** | `sender_pool.acquire()` wrapped in `except BaseException: sem.release()` | 10 rapid scrubs completed in 11.72s with zero semaphore exhaustion or pool blockages | **PASS** |
| **Orphaned Sockets on Cancel** | Freshly created senders in `acquire()` disconnected asynchronously on cancellation (`sender.disconnect()`) | Zero open socket file descriptor leaks during rapid scrub or client drop trials | **PASS** |
| **Unhandled Task Exceptions** | Implemented `_safe_drain_task()` to shield and await cancelled background streaming tasks | No unhandled `CancelledError` warnings in server log during 154-test regression run | **PASS** |
| **Double Generation Advancement** | Consolidated generation increment to single scoped call in `proxy_streaming.py` | Unit test `test_sfase_eliminated_double_generation_advancement` confirmed exactly 1 generation step per seek | **PASS** |
| **Obsolete Chunks Overwriting State** | `(scope_key, seek_generation)` attached to `ChunkTask` and validated in `_background_wire_runner` | Old wire tasks from superseded seeks are discarded upon completion and not pushed to active stream queues | **PASS** |

---

## 2. FloodWait Correctness & Overdraft Bounds (Task 4)

### Rate Governor Architecture
* **Global & Per-Client Cooldown Checks:**
  - `RateGovernor.wait_if_cooling_down(client=...)` is enforced before slot acquisition.
  - Urgent seeks and emergency recovery chunks **cannot bypass** active Telegram FloodWait cooldowns.
* **Bounded Overdraft Model:**
  - Standard token bucket refills continuously at `self._rate` (MB/s) up to `self._capacity`.
  - When a playback seek occurs (`is_seek=True`), tokens are allowed to go into a bounded deficit down to `-self._capacity`.
  - Legitimate seek keyframe chunks (512 KiB – 1 MiB) are admitted immediately (0ms delay), but the account token balance is debited.
  - When rapid repeated seeks deplete the overdraft allowance below `-self._capacity`, requests are paced with `delay = max(0.05, min(raw_delay, 0.5))`.

### Verification Evidence
1. **Mandatory Cooldown Enforcement:**
   - Simulated 2s FloodWait cooldown via `report_flood_wait(2)`.
   - Dispatched urgent seek request during cooldown.
   - Result: Request was held at the gate for **3.22 seconds** before release. **Zero MTProto requests dispatched** during the cooldown.
2. **Overdraft Ceiling Protection:**
   - Seek 1 (512 KiB): Admitted in 0.00ms (`_tokens` = -0.5).
   - Seek 2 (512 KiB): Admitted in 0.00ms (`_tokens` = -1.0, limit reached).
   - Seek 3 (512 KiB): Overdraft exhausted; paced and delayed by **101ms** (`d_paced >= 0.05s`).

---

## 3. Rust Core Session & IPC Safety (Task 5)

### StringSession Format Support
* **263-Byte IPv4 Sessions:**
  - Header: 1-byte DC ID (`>B`)
  - IPv4 Address: 4-bytes (`>4s`)
  - Port: 2-bytes (`>H`)
  - Auth Key: 256-bytes (`>256s`)
  - Total: 263 bytes. Decoded directly into `SocketAddrV4`.
* **275-Byte IPv6 Sessions:**
  - Header: 1-byte DC ID (`>B`)
  - IPv6 Address: 16-bytes (`>16s`)
  - Port: 2-bytes (`>H`)
  - Auth Key: 256-bytes (`>256s`)
  - Total: 275 bytes. Decodes port and auth key; maps to canonical datacenter IPv4 address for Grammers TCP transport.

### Security & Quarantine Controls
* **Malformed Session Trap:**
  - Malformed or truncated sessions passed to `register_session()` receive HTTP 400 from Rust core (`Unsupported session version`).
  - Python `RustBridge` caches the session hash in `_invalid_session_hashes`, suppressing repeated retries.
  - **Zero credential corruption:** Stored session strings in SQLite/PostgreSQL are never deleted or modified.
* **Foreign DC Key Revocation Detection:**
  - `rust_core/src/session.rs` detects if `home_auth != info.auth_key`.
  - When a primary session re-authenticates with a new auth key, foreign DC auth keys in SQLite are cleared (`auth_key = None`).
  - Grammers automatically initiates a fresh `ExportAuth` handshake to foreign DCs, eliminating `SESSION_REVOKED` crashes.

---

## 4. Multi-Tenant Acceleration Isolation

* Multi-tenant acceleration in Rust Core is currently partitioned strictly by authenticated Telegram session hash and account index (`account_idx: 0` vs `account_idx: 1`).
* Each session operates in an independent SQLite session database (`rust_session_{account_idx}.db`).
* Multi-tenant acceleration remains strictly isolated to permitted accounts; requests without validated user or grant credentials are rejected with HTTP 401 Unauthorized before reaching Rust IPC.
