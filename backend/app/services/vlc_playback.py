from __future__ import annotations

import hmac
import hashlib
import json
import logging
import os
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional, Set, Tuple, Union

logger = logging.getLogger("vlc_playback")

DEFAULT_PLAYBACK_TTL_SECONDS = int(os.getenv("PLAYBACK_GRANT_TTL_SECONDS", "86400"))  # 24 hours


def _is_production() -> bool:
    env = os.getenv("ENVIRONMENT", "").lower()
    profile = os.getenv("DEPLOYMENT_PROFILE", "").lower()
    return env in ("production", "prod") or profile == "production"


def _get_signing_secret() -> bytes:
    """
    Obtains dedicated playback signing secret.
    Prioritizes PLAYBACK_SIGNING_SECRET from environment.
    Falls back to a persistent secret file in DATA_DIR with 0o600 permissions.
    Fails closed in production if secret cannot be securely verified.
    Never derives from or couples with Telegram API credentials.
    """
    env_secret = os.getenv("PLAYBACK_SIGNING_SECRET", "").strip()
    if env_secret:
        return env_secret.encode("utf-8")

    try:
        from app.config import DATA_DIR
        secret_file = DATA_DIR / ".playback_signing_secret"
        if secret_file.exists():
            content = secret_file.read_text(encoding="utf-8").strip()
            if content:
                return content.encode("utf-8")

        if _is_production():
            raise RuntimeError(
                "CRITICAL: PLAYBACK_SIGNING_SECRET environment variable is required in production. "
                "Failing closed to prevent insecure ephemeral tokens."
            )

        new_secret = secrets.token_hex(32)
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            secret_file.write_text(new_secret, encoding="utf-8")
            try:
                os.chmod(secret_file, 0o600)
            except Exception:
                pass
        except Exception:
            pass
        return new_secret.encode("utf-8")
    except RuntimeError:
        raise
    except Exception as e:
        if _is_production():
            raise RuntimeError(f"CRITICAL: Failed to load playback secret in production: {e}")
        return secrets.token_hex(32).encode("utf-8")


@dataclass(frozen=True)
class PlaybackGrant:
    chat_id: str
    message_id: int
    expires_at: Optional[float]
    grant_id: str = ""
    created_at: float = 0.0
    revoked: bool = False
    tenant_id: Optional[str] = None


class PlaybackGrantStore:
    def __init__(
        self,
        ttl_seconds: Optional[int] = DEFAULT_PLAYBACK_TTL_SECONDS,
        max_grants: int = 8192,
        secret: Optional[bytes] = None,
        persistence_file: Optional[Path] = None,
    ):
        self.ttl_seconds = ttl_seconds
        self.max_grants = max_grants
        self.secret = secret if secret is not None else _get_signing_secret()
        self.persistence_file = persistence_file
        self._grants: Dict[str, PlaybackGrant] = {}
        self._revoked_tokens: Set[str] = set()
        self._revoked_media: Dict[Tuple[str, int], float] = {}
        self._revocations_mtime: float = 0.0
        self._lock = threading.Lock()
        if self.persistence_file:
            self._load_durable_revocations()

    def _norm_chat(self, chat_id: Union[str, int]) -> str:
        s = str(chat_id).strip()
        if s.startswith("-100"):
            return s[4:]
        if s.startswith("-"):
            return s[1:]
        return s

    def _load_durable_revocations(self) -> None:
        f = self.persistence_file
        if not f or not f.exists():
            return
        try:
            mtime = f.stat().st_mtime
            if mtime <= self._revocations_mtime:
                return
            data = json.loads(f.read_text(encoding="utf-8"))
            toks = set(data.get("tokens", []))
            media_raw = data.get("media", {})
            media = {}
            for k, ts in media_raw.items():
                if ":" in k:
                    c, m = k.split(":", 1)
                    if m.isdigit():
                        media[(c, int(m))] = float(ts)
            with self._lock:
                self._revoked_tokens.update(toks)
                self._revoked_media.update(media)
                self._revocations_mtime = mtime
        except Exception as e:
            logger.debug(f"Could not load durable revocations: {e}")

    def _save_durable_revocations(self) -> None:
        f = self.persistence_file
        if not f:
            return
        try:
            f.parent.mkdir(parents=True, exist_ok=True)
            media_dict = {f"{c}:{m}": ts for (c, m), ts in self._revoked_media.items()}
            payload = {
                "tokens": list(self._revoked_tokens)[-self.max_grants:],
                "media": media_dict,
                "updated_at": time.time(),
            }
            tmp = f.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            try:
                os.chmod(tmp, 0o600)
            except Exception:
                pass
            tmp.replace(f)
            self._revocations_mtime = f.stat().st_mtime
        except Exception as e:
            logger.debug(f"Could not save durable revocations: {e}")

    def issue(
        self,
        chat_id: Union[str, int],
        message_id: int,
        ttl_seconds: Optional[int] = None,
        tenant_id: Optional[str] = None,
    ) -> str:
        now = time.time()
        effective_ttl = ttl_seconds if ttl_seconds is not None else self.ttl_seconds
        if effective_ttl is None:
            effective_ttl = DEFAULT_PLAYBACK_TTL_SECONDS

        expires_at = (now + effective_ttl) if (effective_ttl is not None) else (now + DEFAULT_PLAYBACK_TTL_SECONDS)
        norm_chat = self._norm_chat(chat_id)
        grant_id = secrets.token_hex(16)
        tid_str = str(tenant_id).strip() if tenant_id else ""

        # Cryptographically signed capability token binding media + optional tenant
        if tid_str:
            payload = f"{norm_chat}:{int(message_id)}:{int(expires_at)}:{grant_id}:{tid_str}"
        else:
            payload = f"{norm_chat}:{int(message_id)}:{int(expires_at)}:{grant_id}"
        sig = hmac.new(self.secret, payload.encode("utf-8"), hashlib.sha256).hexdigest()[:32]
        token = f"{norm_chat}.{int(message_id)}.{int(expires_at)}.{grant_id}.{sig}"
        if tid_str:
            token = f"{token}.{tid_str}"

        grant = PlaybackGrant(
            chat_id=str(chat_id),
            message_id=int(message_id),
            expires_at=expires_at,
            grant_id=grant_id,
            created_at=now,
            revoked=False,
            tenant_id=tenant_id,
        )

        with self._lock:
            self._prune(now)
            if len(self._grants) >= self.max_grants:
                oldest = min(self._grants, key=lambda k: self._grants[k].expires_at or float("inf"))
                self._grants.pop(oldest, None)
            self._grants[token] = grant

        return token

    def allows(
        self,
        token: str,
        chat_id: Union[str, int],
        message_id: int,
        tenant_id: Optional[str] = None
    ) -> bool:
        if not token or not isinstance(token, str):
            return False
        if self.ttl_seconds == 0:
            return False

        if self.persistence_file:
            self._load_durable_revocations()

        now = time.time()
        norm_target = self._norm_chat(chat_id)
        target_mid = int(message_id)
        expected_tid = str(tenant_id).strip() if tenant_id else ""

        # 1. In-memory registry lookup
        with self._lock:
            if token in self._revoked_tokens:
                return False
            revoked_at = self._revoked_media.get((norm_target, target_mid))

            grant = self._grants.get(token)
            if grant:
                if grant.revoked:
                    return False
                if revoked_at is not None and grant.created_at <= revoked_at:
                    return False
                if grant.expires_at is not None and grant.expires_at <= now:
                    self._grants.pop(token, None)
                    return False
                norm_grant = self._norm_chat(grant.chat_id)
                if norm_grant == norm_target and grant.message_id == target_mid:
                    # Enforce tenant isolation if grant is bound to a specific tenant
                    if grant.tenant_id and expected_tid and grant.tenant_id != expected_tid:
                        return False
                    return True
                return False

        # 2. Cryptographic capability token verification (handles post-restart active tokens)
        parts = token.split(".")
        if len(parts) in (5, 6):
            t_chat = parts[0]
            t_mid_str = parts[1]
            t_exp_str = parts[2]
            t_gid = parts[3]
            t_sig = parts[4]
            t_tid = parts[5] if len(parts) == 6 else ""

            try:
                t_mid = int(t_mid_str)
                t_exp = int(t_exp_str)
            except ValueError:
                return False

            if t_exp <= now:
                return False
            if t_chat != norm_target or t_mid != target_mid:
                return False
            if t_tid and expected_tid and t_tid != expected_tid:
                return False

            if t_tid:
                expected_payload = f"{t_chat}:{t_mid}:{t_exp}:{t_gid}:{t_tid}".encode("utf-8")
            else:
                expected_payload = f"{t_chat}:{t_mid}:{t_exp}:{t_gid}".encode("utf-8")

            expected_sig = hmac.new(self.secret, expected_payload, hashlib.sha256).hexdigest()[:32]
            if not hmac.compare_digest(t_sig, expected_sig):
                return False

            with self._lock:
                if t_gid in self._revoked_tokens or token in self._revoked_tokens:
                    return False
                revoked_at = self._revoked_media.get((norm_target, target_mid))
                if revoked_at is not None:
                    # Token was issued prior to media revocation
                    token_issued_at = float(t_exp) - float(self.ttl_seconds or DEFAULT_PLAYBACK_TTL_SECONDS)
                    if token_issued_at <= (revoked_at + 1.0):
                        return False
            return True

        return False

    def revoke(self, token: str) -> bool:
        """Explicitly revoke an active grant token with durable persistence."""
        if not token:
            return False
        with self._lock:
            self._revoked_tokens.add(token)
            parts = token.split(".")
            if len(parts) >= 5:
                self._revoked_tokens.add(parts[3])  # grant_id
            self._grants.pop(token, None)
            self._save_durable_revocations()
            return True

    def revoke_media(self, chat_id: Union[str, int], message_id: int) -> int:
        """Revoke all issued grants for a specific media item with durable persistence."""
        norm_chat = self._norm_chat(chat_id)
        mid = int(message_id)
        now = time.time()
        revoked_count = 0
        with self._lock:
            self._revoked_media[(norm_chat, mid)] = now
            to_remove = [
                tok for tok, grant in self._grants.items()
                if self._norm_chat(grant.chat_id) == norm_chat and grant.message_id == mid
            ]
            for tok in to_remove:
                self._revoked_tokens.add(tok)
                self._grants.pop(tok, None)
                revoked_count += 1
            self._save_durable_revocations()
        return revoked_count

    def _prune(self, now: float) -> None:
        expired = [k for k, g in self._grants.items() if g.expires_at is not None and g.expires_at <= now]
        for k in expired:
            self._grants.pop(k, None)
        if len(self._revoked_tokens) > self.max_grants:
            self._revoked_tokens = set(list(self._revoked_tokens)[-self.max_grants // 2:])


def _get_default_revocations_file() -> Optional[Path]:
    try:
        from app.config import DATA_DIR
        return DATA_DIR / "revoked_playback_grants.json"
    except Exception:
        return None


playback_grants = PlaybackGrantStore(
    ttl_seconds=DEFAULT_PLAYBACK_TTL_SECONDS,
    persistence_file=_get_default_revocations_file()
)
