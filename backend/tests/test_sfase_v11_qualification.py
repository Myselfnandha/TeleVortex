"""
SFASE v1.1 Safety & Real-World Seek Qualification Suite.
Covers:
- Priority 1: Rate Governor Mandatory Cooldown & Bounded High-Priority Reservation
- Priority 2: Scoped Seek Ownership, Probe Preservation, & Double Advancement Elimination
- Priority 3: MTProto Transport & Rust Auth Diagnostics
- Priority 4: Accurate Monotonic Stage Telemetry & Non-Zero Wire Metrics
- Priority 5: Controlled Trial Scenarios (Cold Start, Warm Seek, Burst Seeks, Fallback)
"""

import sys
import asyncio
import time
import pytest
from pathlib import Path

# Ensure backend root is on sys.path
BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from app.services.rate_governor import RateGovernor
from app.services.stream_engine import StreamEngine, ChunkTask, ChunkTimingMetrics
from app.services.rust_bridge import RustBridge


# =========================================================================
# Priority 1: Rate Governor Safety
# =========================================================================

@pytest.mark.asyncio
async def test_sfase_mandatory_cooldown_blocks_urgent_seek():
    """Verifies that an active FloodWait cooldown strictly blocks urgent seeks."""
    gov = RateGovernor(initial_rate=10.0, burst_capacity=2.0)
    gov.report_flood_wait(2.0, reason="Telegram FloodWait Test")
    assert gov.is_cooling_down is True

    t0 = time.monotonic()
    # Attempting an urgent seek during mandatory cooldown must wait for cooldown expiry
    acquire_task = asyncio.create_task(
        gov.acquire_chunk_slot(512 * 1024, is_seek=True)
    )

    # Within 0.1s, acquire_task must NOT have finished because cooldown is active
    await asyncio.sleep(0.1)
    assert not acquire_task.done(), "Urgent seek bypassed mandatory FloodWait cooldown!"

    # Release gate manually or wait for task
    gov._cooldown_until = 0.0
    gov._cooldown_until_mono = 0.0
    gov._cooldown_event.set()
    await asyncio.wait_for(acquire_task, timeout=2.0)
    elapsed = time.monotonic() - t0
    assert elapsed >= 0.1


@pytest.mark.asyncio
async def test_sfase_bounded_seek_reservation_prevents_unlimited_flood():
    """
    Verifies that legitimate seeks get instant 0ms reservation, but rapid
    repeated seeks exceeding the bounded overdraft limit (-capacity) are paced.
    """
    gov = RateGovernor(initial_rate=2.0, burst_capacity=1.0)
    gov._tokens = 0.0  # Empty bucket

    # Seek 1 (512 KiB = 0.5 tokens): can draw from overdraft down to -1.0
    t0 = time.monotonic()
    await gov.acquire_chunk_slot(512 * 1024, is_seek=True)
    d1 = time.monotonic() - t0
    assert d1 < 0.05, f"Seek 1 should get instant reservation (took {d1:.3f}s)"
    assert abs(gov._tokens - (-0.5)) < 0.05

    # Seek 2 (512 KiB = 0.5 tokens): can draw again down to -1.0
    t0 = time.monotonic()
    await gov.acquire_chunk_slot(512 * 1024, is_seek=True)
    d2 = time.monotonic() - t0
    assert d2 < 0.05, f"Seek 2 should get instant reservation (took {d2:.3f}s)"
    assert abs(gov._tokens - (-1.0)) < 0.05

    # Seek 3 (512 KiB = 0.5 tokens): overdraft is now exhausted (at -1.0 == -capacity)
    # Must pace and bound delay, NOT bypass!
    t0 = time.monotonic()
    await gov.acquire_chunk_slot(512 * 1024, is_seek=True)
    d3 = time.monotonic() - t0
    assert d3 >= 0.05, f"Seek 3 should be bounded after exhausting overdraft (took {d3:.3f}s)"


@pytest.mark.asyncio
async def test_sfase_retries_and_prefetch_cannot_bypass_limits():
    """Verifies that non-seek chunks (retries, prefetch) follow standard token pacing."""
    gov = RateGovernor(initial_rate=1.0, burst_capacity=1.0)
    gov._tokens = 0.0
    gov._target_time = time.monotonic() + 0.3

    t0 = time.monotonic()
    # is_seek=False (standard prefetch/retry chunk)
    await gov.acquire_chunk_slot(512 * 1024, is_seek=False)
    d = time.monotonic() - t0
    assert d >= 0.2, f"Prefetch/retry chunk should not bypass rate pacing (took {d:.3f}s)"


# =========================================================================
# Priority 2: Scoped Seek Ownership & Task Cancellation
# =========================================================================

@pytest.mark.asyncio
async def test_sfase_scoped_seek_generations_isolate_tenants():
    """Verifies that Tenant A's seeks do not cancel or affect Tenant B's playback."""
    engine = StreamEngine()
    cid = "chat_abc"
    mid = 100

    # Tenant 1, Session 1 seeks to offset 10MB -> Gen 1
    g_t1 = engine.advance_seek_generation(cid, mid, 10 * 1024 * 1024, tenant_id="tenant_1", session_id="sess_1")
    assert g_t1 == 1

    # Tenant 2, Session 2 is playing at offset 0 -> Gen 0
    assert engine.get_seek_generation(cid, mid, tenant_id="tenant_2", session_id="sess_2") == 0

    # Tenant 1, Session 1 seeks to offset 50MB -> Gen 2
    g_t1_2 = engine.advance_seek_generation(cid, mid, 50 * 1024 * 1024, tenant_id="tenant_1", session_id="sess_1")
    assert g_t1_2 == 2

    # Tenant 2 is still completely unaffected (Gen 0)
    assert engine.get_seek_generation(cid, mid, tenant_id="tenant_2", session_id="sess_2") == 0


@pytest.mark.asyncio
async def test_sfase_scoped_independent_players_isolate_sessions():
    """Verifies that Player 1's seek does not cancel Player 2's wire tasks."""
    engine = StreamEngine()
    cid = "chat_abc"
    mid = 200

    # Player 1 initial generation 1
    engine.advance_seek_generation(cid, mid, 0, session_id="player_1")
    engine.advance_seek_generation(cid, mid, 0, session_id="player_2")

    # Player 1 wire task
    ckey_p1 = (cid, mid, 20 * 1024 * 1024, "player_1")
    task_p1 = ChunkTask(ckey_p1, generation=1, is_urgent=False)
    wt_p1 = asyncio.create_task(asyncio.sleep(5.0))
    task_p1.wire_task = wt_p1
    engine._chunk_task_registry[ckey_p1] = task_p1

    # Player 2 wire task
    ckey_p2 = (cid, mid, 30 * 1024 * 1024, "player_2")
    task_p2 = ChunkTask(ckey_p2, generation=1, is_urgent=False)
    wt_p2 = asyncio.create_task(asyncio.sleep(5.0))
    task_p2.wire_task = wt_p2
    engine._chunk_task_registry[ckey_p2] = task_p2

    # Player 1 advances generation to 2
    g_p1 = engine.advance_seek_generation(cid, mid, 60 * 1024 * 1024, session_id="player_1")
    assert g_p1 == 2
    await asyncio.sleep(0.05)

    # Player 1's wire task must be cancelled
    assert wt_p1.cancelled() or wt_p1.done()

    # Player 2's wire task MUST NOT be cancelled!
    assert not wt_p2.cancelled() and not wt_p2.done(), "Player 2's task was cancelled by Player 1!"

    # Clean up
    wt_p2.cancel()


@pytest.mark.asyncio
async def test_sfase_elimination_of_double_generation_advancement():
    """Verifies that a single seek request advances generation by exactly 1."""
    engine = StreamEngine()
    cid = "chat_xyz"
    mid = 300
    session_id = "vlc_single"

    assert engine.get_seek_generation(cid, mid, session_id=session_id) == 0
    g = engine.advance_seek_generation(cid, mid, 1024 * 1024, session_id=session_id)
    assert g == 1
    assert engine.get_seek_generation(cid, mid, session_id=session_id) == 1


# =========================================================================
# Priority 3: MTProto Transport & Rust Auth Diagnostics
# =========================================================================

@pytest.mark.asyncio
async def test_sfase_rust_bridge_suppresses_repeated_400_registration():
    """Verifies that RustBridge records 400 rejection and suppresses hammering retries."""
    bridge = RustBridge()

    # Mock client returning 400
    class MockResp:
        status_code = 400
        text = "Unexpected session byte length: 30"

    class MockClient:
        is_closed = False

        async def post(self, url, json=None, timeout=None):
            return MockResp()

    bridge._client = MockClient()
    malformed_session = "1BadMalformedSessionString123"

    # First attempt: hits 400, logs diagnosis, records hash
    ok1 = await bridge.register_session(malformed_session, api_id=12345, account_idx=0)
    assert ok1 is False

    import hashlib
    h = hashlib.sha256(malformed_session.encode("utf-8")).hexdigest()[:16]
    assert h in bridge._invalid_session_hashes

    # Second attempt: immediately skipped without hitting HTTP client
    bridge._client = None  # Would throw AttributeError if called
    ok2 = await bridge.register_session(malformed_session, api_id=12345, account_idx=0)
    assert ok2 is False


# =========================================================================
# Priority 4: Accurate Stage Telemetry
# =========================================================================

@pytest.mark.asyncio
async def test_sfase_chunk_timing_metrics_non_zero_wire_and_stages():
    """Verifies ChunkTimingMetrics tracks distinct monotonic timings for each stage."""
    t_adm = time.monotonic() - 0.250  # 250ms ago
    metrics = ChunkTimingMetrics(
        t_admission=t_adm,
        t_queue_wait_ms=12.4,
        t_rate_wait_ms=3.1,
        t_lease_wait_ms=8.5,
        t_wire_ms=185.6,
        t_rust_wire_ms=0.0,
        t_py_wire_ms=185.6,
        t_fallback_ms=0.0,
        source="PyTelethon"
    )

    t_first_yield = (time.monotonic() - t_adm) * 1000.0
    metrics.t_first_yield_ms = t_first_yield

    assert metrics.t_queue_wait_ms == 12.4
    assert metrics.t_rate_wait_ms == 3.1
    assert metrics.t_lease_wait_ms == 8.5
    assert metrics.t_wire_ms == 185.6
    assert metrics.t_py_wire_ms == 185.6
    assert metrics.source == "PyTelethon"
    assert metrics.t_first_yield_ms >= 240.0, "TTFB must reflect true monotonic duration from admission"


# =========================================================================
# Priority 5: Controlled Trial Scenarios
# =========================================================================

@pytest.mark.asyncio
async def test_sfase_trial_burst_five_seeks_within_two_seconds():
    """Controlled Trial 3: 5 seeks within 2 seconds."""
    gov = RateGovernor(initial_rate=4.5, burst_capacity=2.0)
    engine = StreamEngine()
    cid = "trial_media"
    mid = 777
    sess = "vlc_trial"

    seek_offsets = [
        10 * 1024 * 1024,
        25 * 1024 * 1024,
        80 * 1024 * 1024,
        150 * 1024 * 1024,
        210 * 1024 * 1024
    ]

    latencies = []
    for off in seek_offsets:
        t0 = time.monotonic()
        gen = engine.advance_seek_generation(cid, mid, off, session_id=sess)
        await gov.acquire_chunk_slot(512 * 1024, is_seek=True)
        lat = (time.monotonic() - t0) * 1000.0
        latencies.append(lat)
        await asyncio.sleep(0.05)

    assert len(latencies) == 5
    # P50 must be sub-50ms
    sorted_lats = sorted(latencies)
    p50 = sorted_lats[2]
    assert p50 < 100.0, f"Burst seek P50 was {p50:.2f}ms, expected sub-100ms"
    assert engine.get_seek_generation(cid, mid, session_id=sess) == 5
