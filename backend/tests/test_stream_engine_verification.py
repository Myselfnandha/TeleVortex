import os
import sys
import asyncio
import pytest
from pathlib import Path
from unittest.mock import MagicMock, AsyncMock, patch

TEST_DIR = Path(__file__).resolve().parent
BACKEND_DIR = TEST_DIR.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services.stream_engine import StreamEngine, stream_buffer
from app.services.stream_cache import stream_cache_service
from telethon.tl.types import Document


@pytest.mark.asyncio
async def test_stream_engine_full_delivery_without_data_loss():
    """
    Verifies that StreamEngine delivers 100% of requested bytes without early truncation
    or data corruption when streaming without cancellation.
    """
    engine = StreamEngine()
    chat_id = "test_full_delivery_chat"
    msg_id = 9911
    chunk_size = 1024 * 1024
    total_chunks = 2
    length = total_chunks * chunk_size
    file_size = 20 * 1024 * 1024  # 20MB file, streaming first 2MB

    stream_buffer.clear()
    stream_cache_service.clear_cache()

    mock_client = MagicMock(loop=asyncio.get_running_loop())
    mock_client.session = MagicMock(dc_id=5)

    fake_doc = Document(
        id=msg_id,
        access_hash=998877,
        file_reference=b"ref_verify",
        date=None,
        mime_type="video/mp4",
        size=file_size,
        dc_id=5,
        thumbs=None,
        video_thumbs=None,
        attributes=[],
    )
    fake_msg = MagicMock(media=fake_doc, file=MagicMock(size=file_size, name="test_full.mp4"))

    expected_payload = b""
    chunk_dict = {}
    for i in range(total_chunks):
        pattern = f"CHUNK_{i:02d}_".encode("ascii")
        repeats = (chunk_size // len(pattern)) + 1
        c_bytes = (pattern * repeats)[:chunk_size]
        assert len(c_bytes) == chunk_size
        chunk_dict[i * chunk_size] = c_bytes
        expected_payload += c_bytes

    async def mock_call(s, req, flood_sleep_threshold=0):
        await asyncio.sleep(0.005)
        res = MagicMock()
        offset = getattr(req, "offset", 0)
        limit = getattr(req, "limit", chunk_size)
        data = chunk_dict.get(offset, b"X" * limit)
        res.bytes = data[:limit]
        return res

    mock_client._call = mock_call

    with patch("app.services.stream_engine.sender_pool.borrow") as mock_borrow, \
         patch("app.services.rust_bridge.rust_bridge.is_healthy", AsyncMock(return_value=False)), \
         patch("app.telegram_client.TelegramClientManager.get_active_streaming_clients", AsyncMock(return_value=[mock_client])):
        
        mock_borrow.return_value.__aenter__ = AsyncMock(return_value=MagicMock())
        mock_borrow.return_value.__aexit__ = AsyncMock(return_value=None)

        gen = engine.stream_media(
            client=mock_client,
            chat_id=chat_id,
            message_id=msg_id,
            start=0,
            length=length,
            file_size=file_size,
            is_media_player=False,
            clean_name="test_full.mp4",
            message=fake_msg
        )

        delivered_bytes = bytearray()
        async for chunk in gen:
            delivered_bytes.extend(chunk)

        assert len(delivered_bytes) == length, f"Expected {length} bytes, got {len(delivered_bytes)}"
        assert bytes(delivered_bytes) == expected_payload, "Delivered byte stream does not match expected payload"


@pytest.mark.asyncio
async def test_website_probe_and_subtitles_use_ram_buffer_and_clean_fallback():
    import httpx
    from app.main import app
    from app.services.stream_buffer import _SLIDING_STREAM_BUFFER
    from app.routes.proxy_streaming import _STREAM_PROBE_CACHE
    from app.routes.proxy_subtitles import _SUBTITLE_CACHE

    _STREAM_PROBE_CACHE.clear()
    _SUBTITLE_CACHE.clear()
    _SLIDING_STREAM_BUFFER.clear()

    chat_id = "9876543"
    msg_id = 4455
    _SLIDING_STREAM_BUFFER.push(chat_id, msg_id, 0, b"FAKE_MP4_BYTES" * 100)

    mock_client = MagicMock()
    mock_client.is_connected.return_value = True
    mock_client.iter_download = MagicMock(side_effect=AssertionError("iter_download should not be called when RAM buffer hits"))
    fake_msg = MagicMock(media=MagicMock(), file=MagicMock(size=1400, name="movie.mkv"))

    fake_probe_stdout = (
        b'{"streams": ['
        b'{"index": 0, "codec_type": "video", "codec_name": "h264"},'
        b'{"index": 1, "codec_type": "audio", "codec_name": "aac", "channels": 2, "tags": {"language": "eng"}},'
        b'{"index": 2, "codec_type": "subtitle", "codec_name": "subrip", "tags": {"language": "tam"}}'
        b']}'
    )

    mock_probe_proc = AsyncMock()
    mock_probe_proc.communicate = AsyncMock(return_value=(fake_probe_stdout, b""))

    mock_sub_proc = AsyncMock()
    mock_sub_proc.communicate = AsyncMock(return_value=(b"", b""))

    async def fake_exec(*cmd, **kwargs):
        if cmd[0] == "ffprobe":
            return mock_probe_proc
        return mock_sub_proc

    with patch("app.routes.proxy_streaming.TelegramClientManager.get_client", AsyncMock(return_value=mock_client)), \
         patch("app.routes.proxy_subtitles.TelegramClientManager.get_client", AsyncMock(return_value=mock_client)), \
         patch("app.routes.proxy_streaming.get_streamable_message", AsyncMock(return_value=fake_msg)), \
         patch("app.routes.proxy_subtitles.get_streamable_message", AsyncMock(return_value=fake_msg)), \
         patch("app.routes.proxy_streaming.stream_cache_service.get_cached_file", return_value=None), \
         patch("app.routes.proxy_subtitles.stream_cache_service.get_cached_file", return_value=None), \
         patch("app.routes.proxy_subtitles.subtitle_service.get_cached_subtitle", return_value=None), \
         patch("asyncio.create_subprocess_exec", side_effect=fake_exec):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1") as ac:
            probe_res = await ac.get(f"/api/media/streams/{chat_id}/{msg_id}")
            assert probe_res.status_code == 200
            pdata = probe_res.json()
            assert pdata["audio_tracks"][0]["language"] == "eng"
            assert pdata["subtitle_tracks"][0]["language"] == "tam"

            sub_res = await ac.get(f"/api/media/subtitles/{chat_id}/{msg_id}/0.vtt")
            assert sub_res.status_code == 200
            assert sub_res.text == "WEBVTT\n\n"
            assert "[Subtitles Active]" not in sub_res.text


def test_video_player_modal_website_streaming_contract():
    root = Path(__file__).resolve().parent.parent.parent
    player_src = (root / "frontend-reui" / "src" / "components" / "VideoPlayerModal.tsx").read_text(encoding="utf-8")
    assert "probeMediaStreams" in player_src
    assert "transmuxSeekSec" in player_src
    assert "handleWaitingOrStalled" in player_src
    assert "requestPictureInPicture" in player_src
    assert "PLAYBACK_RATES" in player_src
