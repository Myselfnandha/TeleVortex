"""
Playback Progress & Continue Watching Tracker.
Maintains persistent watch history in SQLite for seamless browser and VLC resume.
"""

import time
import sqlite3
import aiosqlite
import logging
from typing import Optional, Dict, Any, List, Tuple

from app.config import DATA_DIR
from app.services.subtitle_service import subtitle_service

logger = logging.getLogger("playback_tracker")

DB_PATH = DATA_DIR / "tg_power_suite.db"


def _strip_chat_prefix(chat_id: str) -> str:
    """Strips Telegram channel/group prefixes (-100 / -) without corrupting IDs containing '100'."""
    s = str(chat_id).strip()
    if s.startswith("-100") and len(s) > 4:
        return s[4:]
    if s.startswith("-") and len(s) > 1:
        return s[1:]
    return s


def _canonicalize_chat_id(chat_id: str) -> str:
    """Resolves a chat ID into a canonical storage key ('me' for Saved Messages, digits for numeric chats)."""
    s = str(chat_id).strip()
    if s.lower() in ("me", "self"):
        return "me"
    try:
        from app.telegram_client import TelegramClientManager
        me = TelegramClientManager.get_cached_me() or {}
        my_id = me.get("id")
        if my_id and _strip_chat_prefix(s) == str(my_id):
            return "me"
    except Exception:
        pass
    stripped = _strip_chat_prefix(s)
    if stripped.isdigit():
        return stripped
    return s


def _candidate_chat_ids(chat_id: str) -> List[str]:
    """Generates all possible stored chat_id aliases for lookup or cleanup."""
    s = str(chat_id).strip()
    norm = _strip_chat_prefix(s)
    canonical = _canonicalize_chat_id(s)
    candidates = {s, norm, canonical}
    if norm.isdigit():
        candidates.update({f"-100{norm}", f"-{norm}"})
    try:
        from app.services.telegram_sync import canonicalize_chat_id
        from app.telegram_client import TelegramClientManager
        me = TelegramClientManager.get_cached_me() or {}
        my_id = me.get("id")
        tg_canon, aliases = canonicalize_chat_id(s, my_id)
        candidates.add(tg_canon)
        candidates.update(aliases)
    except Exception:
        pass
    return [c for c in candidates if c]


def _parse_media_metadata(filename: str) -> Tuple[str, int, Optional[str], Optional[int], Optional[int]]:
    parsed = subtitle_service.parse_media_title(filename)
    is_series = 1 if parsed.get("is_series") else 0
    series_title = parsed.get("title") if is_series else None
    season_num = parsed.get("season")
    episode_num = parsed.get("episode")
    display_title = parsed.get("title", filename)
    if is_series and season_num and episode_num:
        display_title = f"{series_title} S{season_num:02d}E{episode_num:02d}"
    elif parsed.get("year"):
        display_title = f"{display_title} ({parsed.get('year')})"
    return display_title, is_series, series_title, season_num, episode_num


def _format_record(row_dict: Dict[str, Any]) -> Dict[str, Any]:
    d = dict(row_dict)
    d["playback_seconds"] = d.get("last_position_seconds", 0.0)
    d["total_seconds"] = d.get("duration_seconds", 0.0)
    d["percent"] = round(d.get("progress_percent", 0.0), 1)
    d["thumb_url"] = d.get("thumbnail_url") or f"/dl/{d.get('chat_id')}/{d.get('message_id')}/thumb"
    d["last_watched"] = d.get("last_watched_at")
    return d


class PlaybackTracker:
    def __init__(self):
        self._player_heartbeats: Dict[Tuple[str, int], float] = {}
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(DB_PATH), timeout=10.0)
        conn.row_factory = sqlite3.Row
        return conn

    def mark_player_heartbeat(self, chat_id: str, message_id: int) -> None:
        """Records an active exact-time player heartbeat so background byte-inference does not clobber it."""
        key = (_canonicalize_chat_id(chat_id), int(message_id))
        self._player_heartbeats[key] = time.monotonic()

    def has_recent_player_heartbeat(self, chat_id: str, message_id: int, ttl: float = 15.0) -> bool:
        key = (_canonicalize_chat_id(chat_id), int(message_id))
        ts = self._player_heartbeats.get(key)
        if ts is None:
            return False
        if (time.monotonic() - ts) > ttl:
            self._player_heartbeats.pop(key, None)
            return False
        return True

    def _init_db(self):
        """Initializes the playback_history SQLite table with chunk/byte offsets and WAL mode."""
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with self._get_connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute("PRAGMA journal_mode=WAL")
                cursor.execute("PRAGMA synchronous=NORMAL")
            except sqlite3.OperationalError:
                pass
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS playback_history (
                    id TEXT PRIMARY KEY,
                    chat_id TEXT NOT NULL,
                    message_id INTEGER NOT NULL,
                    filename TEXT NOT NULL,
                    display_title TEXT,
                    file_size INTEGER DEFAULT 0,
                    duration_seconds REAL DEFAULT 0,
                    last_position_seconds REAL DEFAULT 0,
                    progress_percent REAL DEFAULT 0,
                    last_watched_at REAL NOT NULL,
                    is_series INTEGER DEFAULT 0,
                    series_title TEXT,
                    season_num INTEGER,
                    episode_num INTEGER,
                    thumbnail_url TEXT,
                    last_chunk_index INTEGER DEFAULT 0,
                    last_byte_offset INTEGER DEFAULT 0
                )
            """)
            for col, col_type in [("last_chunk_index", "INTEGER DEFAULT 0"), ("last_byte_offset", "INTEGER DEFAULT 0")]:
                try:
                    cursor.execute(f"ALTER TABLE playback_history ADD COLUMN {col} {col_type}")
                except sqlite3.OperationalError:
                    pass
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_playback_last_watched ON playback_history(last_watched_at DESC)")
            conn.commit()

    def update_progress(
        self,
        chat_id: str,
        message_id: int,
        filename: str,
        last_position_seconds: float = 0.0,
        duration_seconds: float = 0.0,
        file_size: int = 0,
        thumbnail_url: Optional[str] = None,
        last_chunk_index: int = 0,
        last_byte_offset: int = 0,
        is_reset: bool = False
    ):
        """Updates playback position, chunk index, and calculates progress percentage."""
        if not filename or filename == "thumb":
            return

        canonical_cid = _canonicalize_chat_id(chat_id)
        record_id = f"{canonical_cid}_{message_id}"
        now = time.time()

        display_title, is_series, series_title, season_num, episode_num = _parse_media_metadata(filename)

        if duration_seconds <= 0 and file_size > 0:
            duration_seconds = max(60.0, file_size / (350 * 1024))

        if is_reset:
            last_position_seconds = 0.0
            progress_percent = 0.0
        elif duration_seconds > 0 and last_position_seconds > 0:
            progress_percent = min(100.0, (last_position_seconds / duration_seconds) * 100.0)
        else:
            progress_percent = 0.0

        if not is_reset and progress_percent >= 98.0:
            self.remove_progress(chat_id, message_id)
            return

        alias_ids = [f"{cid}_{message_id}" for cid in _candidate_chat_ids(chat_id) if f"{cid}_{message_id}" != record_id]

        with self._get_connection() as conn:
            cursor = conn.cursor()
            if alias_ids:
                placeholders = ",".join("?" for _ in alias_ids)
                cursor.execute(f"DELETE FROM playback_history WHERE id IN ({placeholders})", alias_ids)
            cursor.execute("""
                INSERT INTO playback_history (
                    id, chat_id, message_id, filename, display_title,
                    file_size, duration_seconds, last_position_seconds,
                    progress_percent, last_watched_at, is_series,
                    series_title, season_num, episode_num, thumbnail_url,
                    last_chunk_index, last_byte_offset
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    chat_id = excluded.chat_id,
                    filename = CASE WHEN excluded.filename NOT LIKE 'tg_media_%' AND excluded.filename != 'thumb' THEN excluded.filename ELSE playback_history.filename END,
                    display_title = CASE WHEN excluded.filename NOT LIKE 'tg_media_%' AND excluded.filename != 'thumb' THEN excluded.display_title ELSE playback_history.display_title END,
                    file_size = CASE WHEN excluded.file_size > 0 THEN excluded.file_size ELSE playback_history.file_size END,
                    last_position_seconds = CASE
                        WHEN ? THEN 0.0
                        WHEN excluded.last_position_seconds > 0 AND NOT (excluded.last_position_seconds <= 10.0 AND playback_history.last_position_seconds >= 30.0) THEN excluded.last_position_seconds
                        ELSE playback_history.last_position_seconds
                    END,
                    duration_seconds = CASE WHEN excluded.duration_seconds > 0 THEN excluded.duration_seconds ELSE playback_history.duration_seconds END,
                    progress_percent = CASE
                        WHEN ? THEN 0.0
                        WHEN excluded.progress_percent > 0 AND NOT (excluded.last_position_seconds <= 10.0 AND playback_history.last_position_seconds >= 30.0) THEN excluded.progress_percent
                        ELSE playback_history.progress_percent
                    END,
                    last_watched_at = excluded.last_watched_at,
                    thumbnail_url = COALESCE(excluded.thumbnail_url, playback_history.thumbnail_url),
                    last_chunk_index = CASE WHEN excluded.last_chunk_index > 0 THEN excluded.last_chunk_index ELSE playback_history.last_chunk_index END,
                    last_byte_offset = CASE WHEN excluded.last_byte_offset > 0 THEN excluded.last_byte_offset ELSE playback_history.last_byte_offset END
            """, (
                record_id, str(chat_id), message_id, filename, display_title,
                file_size, duration_seconds, last_position_seconds,
                progress_percent, now, is_series,
                series_title, season_num, episode_num, thumbnail_url,
                last_chunk_index, last_byte_offset,
                1 if is_reset else 0,
                1 if is_reset else 0
            ))
            conn.commit()

    def update_byte_progress(
        self,
        chat_id: str,
        message_id: int,
        filename: str,
        streamed_byte_offset: int,
        total_file_size: int,
        chunk_size: int = 512 * 1024
    ):
        """
        Updates chunk-aligned progress derived from VLC/browser byte-range streaming requests.
        Protects existing progress from initial header/tail probes and live player heartbeats.
        """
        if not filename or filename == "thumb" or total_file_size <= 0:
            return

        tail_guard = max(32 * 1024 * 1024, int(total_file_size * 0.05))
        if streamed_byte_offset <= 1024 * 1024 or streamed_byte_offset >= (total_file_size - tail_guard):
            return

        if self.has_recent_player_heartbeat(chat_id, message_id):
            return

        canonical_cid = _canonicalize_chat_id(chat_id)
        record_id = f"{canonical_cid}_{message_id}"
        now = time.time()
        chunk_index = streamed_byte_offset // chunk_size

        existing = self.get_playback_progress(chat_id, message_id)
        duration_seconds = (existing.get("duration_seconds") or 0.0) if existing else 0.0
        if duration_seconds <= 0:
            duration_seconds = max(60.0, total_file_size / (350 * 1024))

        ratio = min(1.0, max(0.0, streamed_byte_offset / total_file_size))
        inferred_position_seconds = round(ratio * duration_seconds, 1) if duration_seconds > 0 else 0.0
        inferred_percent = round(min(100.0, ratio * 100.0), 1)

        is_finished = (
            inferred_percent >= 98.0
            or (duration_seconds > 300.0 and inferred_position_seconds >= (duration_seconds - 90.0))
            or (0 < duration_seconds <= 300.0 and inferred_position_seconds >= (duration_seconds - 15.0))
        )
        if is_finished:
            self.remove_progress(chat_id, message_id)
            return

        display_title, is_series, series_title, season_num, episode_num = _parse_media_metadata(filename)
        thumb_url = f"/dl/{chat_id}/{message_id}/thumb"
        alias_ids = [f"{cid}_{message_id}" for cid in _candidate_chat_ids(chat_id) if f"{cid}_{message_id}" != record_id]

        with self._get_connection() as conn:
            cursor = conn.cursor()
            if alias_ids:
                placeholders = ",".join("?" for _ in alias_ids)
                cursor.execute(f"DELETE FROM playback_history WHERE id IN ({placeholders})", alias_ids)
            cursor.execute("""
                INSERT INTO playback_history (
                    id, chat_id, message_id, filename, display_title,
                    file_size, duration_seconds, last_position_seconds,
                    progress_percent, last_watched_at, is_series,
                    series_title, season_num, episode_num, thumbnail_url,
                    last_chunk_index, last_byte_offset
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    last_chunk_index = excluded.last_chunk_index,
                    last_byte_offset = excluded.last_byte_offset,
                    last_watched_at = excluded.last_watched_at,
                    file_size = CASE WHEN excluded.file_size > 0 THEN excluded.file_size ELSE playback_history.file_size END,
                    duration_seconds = CASE WHEN playback_history.duration_seconds > 0 THEN playback_history.duration_seconds ELSE excluded.duration_seconds END,
                    last_position_seconds = CASE
                        WHEN excluded.last_position_seconds > 0 AND NOT (excluded.last_position_seconds <= 10.0 AND playback_history.last_position_seconds >= 30.0) THEN excluded.last_position_seconds
                        ELSE playback_history.last_position_seconds
                    END,
                    progress_percent = CASE
                        WHEN excluded.progress_percent > 0 AND NOT (excluded.last_position_seconds <= 10.0 AND playback_history.last_position_seconds >= 30.0) THEN excluded.progress_percent
                        ELSE playback_history.progress_percent
                    END,
                    thumbnail_url = COALESCE(playback_history.thumbnail_url, excluded.thumbnail_url)
            """, (
                record_id, str(chat_id), message_id, filename, display_title,
                total_file_size, duration_seconds, inferred_position_seconds,
                inferred_percent, now, is_series,
                series_title, season_num, episode_num, thumb_url,
                chunk_index, streamed_byte_offset
            ))
            conn.commit()

    def get_playback_progress(self, chat_id: str, message_id: int) -> Optional[Dict[str, Any]]:
        candidate_ids = _candidate_chat_ids(chat_id)
        placeholders = ",".join("?" for _ in candidate_ids)
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(f"""
                SELECT * FROM playback_history
                WHERE (chat_id IN ({placeholders}) AND message_id = ?)
                   OR id IN ({placeholders})
                ORDER BY last_watched_at DESC
                LIMIT 1
            """, (*candidate_ids, message_id, *[f"{cid}_{message_id}" for cid in candidate_ids]))
            row = cursor.fetchone()
            if row:
                return _format_record(dict(row))
        return None

    def get_continue_watching(self, limit: int = 12) -> List[Dict[str, Any]]:
        """
        Returns actively watched, deduplicated videos (progress >= 1% or position >= 10s, and < 98%)
        ordered by most recently watched.
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM playback_history
                WHERE (progress_percent >= 1.0 OR last_position_seconds >= 10.0)
                  AND progress_percent < 98.0
                  AND filename != 'thumb'
                ORDER BY last_watched_at DESC
                LIMIT ?
            """, (limit * 2,))
            rows = cursor.fetchall()
            seen = set()
            results = []
            for r in rows:
                d = _format_record(dict(r))
                dedup_key = (_canonicalize_chat_id(str(d["chat_id"])), int(d["message_id"]))
                if dedup_key in seen:
                    continue
                seen.add(dedup_key)
                results.append(d)
                if len(results) >= limit:
                    break
            return results

    def remove_progress(self, chat_id: str, message_id: int):
        candidates = [f"{cid}_{message_id}" for cid in _candidate_chat_ids(chat_id)]
        with self._get_connection() as conn:
            cursor = conn.cursor()
            placeholders = ",".join("?" for _ in candidates)
            cursor.execute(f"DELETE FROM playback_history WHERE id IN ({placeholders})", candidates)
            conn.commit()

    async def ainit_db(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(str(DB_PATH), timeout=10.0) as db:
            try:
                await db.execute("PRAGMA journal_mode=WAL")
                await db.execute("PRAGMA synchronous=NORMAL")
            except Exception:
                pass
            await db.execute("""
                CREATE TABLE IF NOT EXISTS playback_history (
                    id TEXT PRIMARY KEY,
                    chat_id TEXT NOT NULL,
                    message_id INTEGER NOT NULL,
                    filename TEXT NOT NULL,
                    display_title TEXT,
                    file_size INTEGER DEFAULT 0,
                    duration_seconds REAL DEFAULT 0,
                    last_position_seconds REAL DEFAULT 0,
                    progress_percent REAL DEFAULT 0,
                    last_watched_at REAL NOT NULL,
                    is_series INTEGER DEFAULT 0,
                    series_title TEXT,
                    season_num INTEGER,
                    episode_num INTEGER,
                    thumbnail_url TEXT,
                    last_chunk_index INTEGER DEFAULT 0,
                    last_byte_offset INTEGER DEFAULT 0
                )
            """)
            for col, col_type in [("last_chunk_index", "INTEGER DEFAULT 0"), ("last_byte_offset", "INTEGER DEFAULT 0")]:
                try:
                    await db.execute(f"ALTER TABLE playback_history ADD COLUMN {col} {col_type}")
                except Exception:
                    pass
            await db.execute("CREATE INDEX IF NOT EXISTS idx_playback_last_watched ON playback_history(last_watched_at DESC)")
            await db.commit()

    async def aupdate_progress(
        self,
        chat_id: str,
        message_id: int,
        filename: str,
        last_position_seconds: float = 0.0,
        duration_seconds: float = 0.0,
        file_size: int = 0,
        thumbnail_url: Optional[str] = None,
        last_chunk_index: int = 0,
        last_byte_offset: int = 0,
        is_reset: bool = False
    ):
        if not filename or filename == "thumb":
            return

        canonical_cid = _canonicalize_chat_id(chat_id)
        record_id = f"{canonical_cid}_{message_id}"
        now = time.time()

        display_title, is_series, series_title, season_num, episode_num = _parse_media_metadata(filename)

        if duration_seconds <= 0 and file_size > 0:
            duration_seconds = max(60.0, file_size / (350 * 1024))

        if is_reset:
            last_position_seconds = 0.0
            progress_percent = 0.0
        elif duration_seconds > 0 and last_position_seconds > 0:
            progress_percent = min(100.0, (last_position_seconds / duration_seconds) * 100.0)
        else:
            progress_percent = 0.0

        if not is_reset and progress_percent >= 98.0:
            await self.aremove_progress(chat_id, message_id)
            return

        alias_ids = [f"{cid}_{message_id}" for cid in _candidate_chat_ids(chat_id) if f"{cid}_{message_id}" != record_id]

        async with aiosqlite.connect(str(DB_PATH), timeout=10.0) as db:
            if alias_ids:
                placeholders = ",".join("?" for _ in alias_ids)
                await db.execute(f"DELETE FROM playback_history WHERE id IN ({placeholders})", alias_ids)
            await db.execute("""
                INSERT INTO playback_history (
                    id, chat_id, message_id, filename, display_title,
                    file_size, duration_seconds, last_position_seconds,
                    progress_percent, last_watched_at, is_series,
                    series_title, season_num, episode_num, thumbnail_url,
                    last_chunk_index, last_byte_offset
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    chat_id = excluded.chat_id,
                    filename = CASE WHEN excluded.filename NOT LIKE 'tg_media_%' AND excluded.filename != 'thumb' THEN excluded.filename ELSE playback_history.filename END,
                    display_title = CASE WHEN excluded.filename NOT LIKE 'tg_media_%' AND excluded.filename != 'thumb' THEN excluded.display_title ELSE playback_history.display_title END,
                    file_size = CASE WHEN excluded.file_size > 0 THEN excluded.file_size ELSE playback_history.file_size END,
                    last_position_seconds = CASE
                        WHEN ? THEN 0.0
                        WHEN excluded.last_position_seconds > 0 AND NOT (excluded.last_position_seconds <= 10.0 AND playback_history.last_position_seconds >= 30.0) THEN excluded.last_position_seconds
                        ELSE playback_history.last_position_seconds
                    END,
                    duration_seconds = CASE WHEN excluded.duration_seconds > 0 THEN excluded.duration_seconds ELSE playback_history.duration_seconds END,
                    progress_percent = CASE
                        WHEN ? THEN 0.0
                        WHEN excluded.progress_percent > 0 AND NOT (excluded.last_position_seconds <= 10.0 AND playback_history.last_position_seconds >= 30.0) THEN excluded.progress_percent
                        ELSE playback_history.progress_percent
                    END,
                    last_watched_at = excluded.last_watched_at,
                    thumbnail_url = COALESCE(excluded.thumbnail_url, playback_history.thumbnail_url),
                    last_chunk_index = CASE WHEN excluded.last_chunk_index > 0 THEN excluded.last_chunk_index ELSE playback_history.last_chunk_index END,
                    last_byte_offset = CASE WHEN excluded.last_byte_offset > 0 THEN excluded.last_byte_offset ELSE playback_history.last_byte_offset END
            """, (
                record_id, str(chat_id), message_id, filename, display_title,
                file_size, duration_seconds, last_position_seconds,
                progress_percent, now, is_series,
                series_title, season_num, episode_num, thumbnail_url,
                last_chunk_index, last_byte_offset,
                1 if is_reset else 0,
                1 if is_reset else 0
            ))
            await db.commit()

    async def aupdate_byte_progress(
        self,
        chat_id: str,
        message_id: int,
        filename: str,
        streamed_byte_offset: int,
        total_file_size: int,
        chunk_size: int = 512 * 1024
    ):
        if not filename or filename == "thumb" or total_file_size <= 0:
            return

        tail_guard = max(32 * 1024 * 1024, int(total_file_size * 0.05))
        if streamed_byte_offset <= 1024 * 1024 or streamed_byte_offset >= (total_file_size - tail_guard):
            return

        if self.has_recent_player_heartbeat(chat_id, message_id):
            return

        canonical_cid = _canonicalize_chat_id(chat_id)
        record_id = f"{canonical_cid}_{message_id}"
        now = time.time()
        chunk_index = streamed_byte_offset // chunk_size

        existing = await self.aget_playback_progress(chat_id, message_id)
        duration_seconds = (existing.get("duration_seconds") or 0.0) if existing else 0.0
        if duration_seconds <= 0:
            duration_seconds = max(60.0, total_file_size / (350 * 1024))

        ratio = min(1.0, max(0.0, streamed_byte_offset / total_file_size))
        inferred_position_seconds = round(ratio * duration_seconds, 1) if duration_seconds > 0 else 0.0
        inferred_percent = round(min(100.0, ratio * 100.0), 1)

        is_finished = (
            inferred_percent >= 98.0
            or (duration_seconds > 300.0 and inferred_position_seconds >= (duration_seconds - 90.0))
            or (0 < duration_seconds <= 300.0 and inferred_position_seconds >= (duration_seconds - 15.0))
        )
        if is_finished:
            await self.aremove_progress(chat_id, message_id)
            return

        display_title, is_series, series_title, season_num, episode_num = _parse_media_metadata(filename)
        thumb_url = f"/dl/{chat_id}/{message_id}/thumb"
        alias_ids = [f"{cid}_{message_id}" for cid in _candidate_chat_ids(chat_id) if f"{cid}_{message_id}" != record_id]

        async with aiosqlite.connect(str(DB_PATH), timeout=10.0) as db:
            if alias_ids:
                placeholders = ",".join("?" for _ in alias_ids)
                await db.execute(f"DELETE FROM playback_history WHERE id IN ({placeholders})", alias_ids)
            await db.execute("""
                INSERT INTO playback_history (
                    id, chat_id, message_id, filename, display_title,
                    file_size, duration_seconds, last_position_seconds,
                    progress_percent, last_watched_at, is_series,
                    series_title, season_num, episode_num, thumbnail_url,
                    last_chunk_index, last_byte_offset
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    last_chunk_index = excluded.last_chunk_index,
                    last_byte_offset = excluded.last_byte_offset,
                    last_watched_at = excluded.last_watched_at,
                    file_size = CASE WHEN excluded.file_size > 0 THEN excluded.file_size ELSE playback_history.file_size END,
                    duration_seconds = CASE WHEN playback_history.duration_seconds > 0 THEN playback_history.duration_seconds ELSE excluded.duration_seconds END,
                    last_position_seconds = CASE
                        WHEN excluded.last_position_seconds > 0 AND NOT (excluded.last_position_seconds <= 10.0 AND playback_history.last_position_seconds >= 30.0) THEN excluded.last_position_seconds
                        ELSE playback_history.last_position_seconds
                    END,
                    progress_percent = CASE
                        WHEN excluded.progress_percent > 0 AND NOT (excluded.last_position_seconds <= 10.0 AND playback_history.last_position_seconds >= 30.0) THEN excluded.progress_percent
                        ELSE playback_history.progress_percent
                    END,
                    thumbnail_url = COALESCE(playback_history.thumbnail_url, excluded.thumbnail_url)
            """, (
                record_id, str(chat_id), message_id, filename, display_title,
                total_file_size, duration_seconds, inferred_position_seconds,
                inferred_percent, now, is_series,
                series_title, season_num, episode_num, thumb_url,
                chunk_index, streamed_byte_offset
            ))
            await db.commit()

    async def aget_playback_progress(self, chat_id: str, message_id: int) -> Optional[Dict[str, Any]]:
        candidate_ids = _candidate_chat_ids(chat_id)
        placeholders = ",".join("?" for _ in candidate_ids)

        async with aiosqlite.connect(str(DB_PATH), timeout=10.0) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(f"""
                SELECT * FROM playback_history
                WHERE (chat_id IN ({placeholders}) AND message_id = ?)
                   OR id IN ({placeholders})
                ORDER BY last_watched_at DESC
                LIMIT 1
            """, (*candidate_ids, message_id, *[f"{cid}_{message_id}" for cid in candidate_ids])) as cursor:
                row = await cursor.fetchone()
                if row:
                    return _format_record(dict(row))
        return None

    async def aget_continue_watching(self, limit: int = 12) -> List[Dict[str, Any]]:
        async with aiosqlite.connect(str(DB_PATH), timeout=10.0) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute("""
                SELECT * FROM playback_history
                WHERE (progress_percent >= 1.0 OR last_position_seconds >= 10.0)
                  AND progress_percent < 98.0
                  AND filename != 'thumb'
                ORDER BY last_watched_at DESC
                LIMIT ?
            """, (limit * 2,)) as cursor:
                rows = await cursor.fetchall()
                seen = set()
                results = []
                for r in rows:
                    d = _format_record(dict(r))
                    dedup_key = (_canonicalize_chat_id(str(d["chat_id"])), int(d["message_id"]))
                    if dedup_key in seen:
                        continue
                    seen.add(dedup_key)
                    results.append(d)
                    if len(results) >= limit:
                        break
                return results

    async def aremove_progress(self, chat_id: str, message_id: int):
        candidates = [f"{cid}_{message_id}" for cid in _candidate_chat_ids(chat_id)]
        async with aiosqlite.connect(str(DB_PATH), timeout=10.0) as db:
            placeholders = ",".join("?" for _ in candidates)
            await db.execute(f"DELETE FROM playback_history WHERE id IN ({placeholders})", candidates)
            await db.commit()


playback_tracker = PlaybackTracker()
