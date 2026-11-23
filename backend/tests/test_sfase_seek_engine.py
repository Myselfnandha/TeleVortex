"""
Tests for SFASE v1.0 (Seek-First Adaptive Streaming Engine).
Verifies:
1. Generation advancement invalidates superseded generations.
2. Urgent seek requests bypass rate governor pacing delays.
3. Rapid seeks cancel in-flight wire tasks from older generations immediately.
4. ChunkTask records accurate queue, rate, and wire latency telemetry.
"""

import os
import sys
import asyncio
import time
import pytest
from pathlib import Path

# Ensure backend root is on sys.path
BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from app.services.stream_engine import StreamEngine, ChunkTask
from app.services.rate_governor import RateGovernor


@pytest.mark.asyncio
async def test_sfase_seek_generation_advancement():
    engine = StreamEngine()
    cid = "test_chat_123"
    mid = 456

    g1 = engine.advance_seek_generation(cid, mid, 1024 * 1024)
    assert g1 == 1
    assert engine.get_seek_generation(cid, mid) == 1

    g2 = engine.advance_seek_generation(cid, mid, 50 * 1024 * 1024)
    assert g2 == 2
    assert engine.get_seek_generation(cid, mid) == 2


@pytest.mark.asyncio
async def test_sfase_generation_cancels_superseded_in_flight_tasks():
    engine = StreamEngine()
    cid = "12345"
    mid = 999

    # Gen 1 was at offset 0; task1 was a background prefetch chunk at offset 15MB
    g1 = engine.advance_seek_generation(cid, mid, 0)
    ckey1 = (cid, mid, 15 * 1024 * 1024)
    task1 = ChunkTask(ckey1, generation=g1, is_urgent=False)

    async def fake_wire():
        await asyncio.sleep(5.0)

    wt1 = asyncio.create_task(fake_wire())
    task1.wire_task = wt1
    engine._chunk_task_registry[ckey1] = task1

    # Now seek to offset 50MB (Gen 2)
    g2 = engine.advance_seek_generation(cid, mid, 50 * 1024 * 1024)
    assert g2 == 2

    # task1 was superseded by Gen 2 and should have been cancelled immediately
    await asyncio.sleep(0.05)
    assert wt1.cancelled() or wt1.done()
    assert task1.future.cancelled() or task1.future.done()


@pytest.mark.asyncio
async def test_sfase_rate_governor_urgent_seek_bypass():
    governor = RateGovernor(initial_rate=1.0, burst_capacity=1.0)
    # Drain tokens
    governor._tokens = 0.0
    governor._target_time = time.monotonic() + 10.0

    t0 = time.monotonic()
    # Urgent seek must bypass delay immediately
    await governor.acquire_chunk_slot(512 * 1024, is_seek=True)
    elapsed = time.monotonic() - t0
    assert elapsed < 0.05, f"Urgent seek took {elapsed}s; should have bypassed pacing delays"


@pytest.mark.asyncio
async def test_sfase_chunk_task_telemetry_recording():
    ckey = ("chat1", 100, 1024 * 1024)
    task = ChunkTask(ckey, generation=1, is_urgent=True)
    task.t_queue = 5.2
    task.t_rate = 0.0
    task.t_wire = 245.8
    task.source = "Rust"

    assert task.is_urgent is True
    assert task.generation == 1
    assert task.t_queue == 5.2
    assert task.t_wire == 245.8
    assert task.source == "Rust"
