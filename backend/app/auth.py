import os
import hmac
from fastapi import Request, HTTPException
from typing import Optional

from app.config import (
    MULTI_TENANT_STREAMING_ENABLED,
    ENABLE_LEGACY_LOOPBACK,
)

API_AUTH_TOKEN = os.getenv("API_AUTH_TOKEN", "").strip()
ENABLE_API_AUTH = os.getenv("ENABLE_API_AUTH", "false").lower() in ("1", "true", "yes")


def is_loopback_request(request: Request) -> bool:
    """
    Checks if the request is strictly from local loopback (127.0.0.1 / ::1 / localhost / testserver)
    and did NOT arrive through an external proxy, tunnel, or forwarded header.
    When ENABLE_LEGACY_LOOPBACK is False or MULTI_TENANT_STREAMING_ENABLED is True,
    loopback bypass is disabled to enforce strict tenant authentication.
    """
    from app.config import ENABLE_LEGACY_LOOPBACK, MULTI_TENANT_STREAMING_ENABLED
    if not ENABLE_LEGACY_LOOPBACK or MULTI_TENANT_STREAMING_ENABLED:
        return False

    # Any forwarding proxy headers indicate external routing (e.g. Cloudflare Tunnel, ngrok, reverse proxy)
    for header in ("cf-connecting-ip", "x-forwarded-for", "x-real-ip"):
        if header in request.headers:
            return False

    client_host = getattr(request.client, "host", None) if request.client else None
    return client_host in ("127.0.0.1", "::1", "localhost", "testserver", "testclient")


def is_authenticated(request: Request) -> bool:
    """
    Validates whether the incoming request contains a valid API authentication token.
    Token can be supplied via:
    1. Authorization: Bearer <token>
    2. Header X-API-Key: <token>
    3. Query parameter ?token=<token>
    """
    token_to_check = API_AUTH_TOKEN
    is_loopback = is_loopback_request(request)

    # VLC and native mobile players cannot reliably attach custom auth headers. Accept a
    # short-lived capability only for GET/HEAD requests to one exact /dl/{chat}/{message}
    # resource. It cannot authorize API routes, transmux endpoints, or another media item.
    req_method = request.scope.get("method", "GET") if hasattr(request, "scope") else getattr(request, "method", "GET")
    grant_token = request.query_params.get("grant") or request.query_params.get("playback_token", "")

    if req_method in ("GET", "HEAD"):
        path = request.scope.get("path", "") if hasattr(request, "scope") else getattr(request, "path", "")
        parts = path.split("/")
        media_identity = None
        if (path.startswith("/dl/") or path.startswith("/stream/")) and len(parts) >= 4 and parts[2] and parts[3].isdigit():
            media_identity = (parts[2], int(parts[3]))
        elif path.startswith("/api/media/subtitles/download/") and len(parts) >= 7 and parts[5] and parts[6].isdigit():
            media_identity = (parts[5], int(parts[6]))

        if grant_token:
            # When an explicit grant token is supplied, it MUST be valid for this media identity.
            # Never bypass validation on loopback if an invalid/revoked grant token was provided.
            if media_identity:
                tenant_id = None
                if hasattr(request.state, "principal") and request.state.principal:
                    tenant_id = request.state.principal.user_id
                try:
                    from app.services.playback_grants import playback_grant_service
                    grant = playback_grant_service.verify_grant(
                        grant_token, media_identity[0], media_identity[1]
                    )
                    if grant:
                        request.state.grant = grant
                        return True
                except Exception:
                    pass

                try:
                    from app.services.vlc_playback import playback_grants
                    if playback_grants.allows(
                        grant_token, media_identity[0], media_identity[1], tenant_id=tenant_id
                    ):
                        return True
                except Exception:
                    pass
            return False

        if not token_to_check and not ENABLE_API_AUTH and is_loopback and path.startswith(("/dl/", "/stream/")):
            return True

    if grant_token:
        # A grant token was supplied but did not validate as a media capability
        return False

    if not token_to_check and not ENABLE_API_AUTH and is_loopback:
        return True

    if not token_to_check:
        # Non-loopback request or auth enabled, but server has no secret token configured
        return False

    # 1. Bearer Header (constant-time check against character-by-character timing leak)
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        client_token = auth_header[7:].strip()
        if hmac.compare_digest(client_token, token_to_check):
            return True

    # 2. X-API-Key Header
    api_key_header = request.headers.get("X-API-Key", "").strip()
    if api_key_header and hmac.compare_digest(api_key_header, token_to_check):
        return True

    # 3. Query Parameter
    query_token = request.query_params.get("token", "").strip()
    if query_token and hmac.compare_digest(query_token, token_to_check):
        return True

    # 4. Cookie tg_api_token or tg_device_token
    cookie_token = request.cookies.get("tg_api_token", "").strip()
    if cookie_token and hmac.compare_digest(cookie_token, token_to_check):
        return True

    cookie_dev = request.cookies.get("tg_device_token", "").strip()
    if cookie_dev and hmac.compare_digest(cookie_dev, token_to_check):
        return True

    # 5. Multi-Tenant v3 Session cookie
    if "tg_session" in request.cookies and len(request.cookies["tg_session"].strip()) >= 32:
        return True

    return False


async def verify_auth(request: Request):
    """
    FastAPI dependency for private APIs, playback controls, cache mutations, and system actions.
    Authentication is required if:
    1. API_AUTH_TOKEN is configured, OR
    2. ENABLE_API_AUTH is true, OR
    3. The request is non-loopback (LAN, Cloudflare tunnel, remote proxy)
    """
    # 1. Attempt to resolve v3 multi-tenant session token
    raw_v3_token = None
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        raw_v3_token = auth_header[7:].strip()
    elif "tg_session" in request.cookies:
        raw_v3_token = request.cookies["tg_session"]
    elif "session_token" in request.query_params:
        raw_v3_token = request.query_params["session_token"]

    if raw_v3_token:
        try:
            from app.auth_v3.session_service import SessionService
            from app.db.session import get_sessionmaker
            session_maker = get_sessionmaker()
            async with session_maker() as db_session:
                principal = await SessionService.validate_session(db_session, raw_v3_token)
                if principal:
                    request.state.principal = principal
                    return
        except Exception:
            pass

    grant_token = request.query_params.get("grant") or request.query_params.get("playback_token", "")
    is_loopback = is_loopback_request(request)
    must_authenticate = bool(API_AUTH_TOKEN) or ENABLE_API_AUTH or not is_loopback or bool(grant_token)

    if must_authenticate:
        # A valid media-scoped playback capability is also an authentication credential
        # for its single media resource, including when the permanent API token is unset.
        if is_authenticated(request):
            return
        if grant_token:
            raise HTTPException(
                status_code=403,
                detail="Forbidden: Playback token is invalid, expired, or revoked."
            )
        if not API_AUTH_TOKEN:
            # Non-loopback / remote access attempted without configured API_AUTH_TOKEN
            raise HTTPException(
                status_code=403,
                detail="Forbidden: Non-loopback or remote requests require API_AUTH_TOKEN to be configured on the server or a valid media playback link."
            )
        raise HTTPException(
            status_code=401,
            detail="Unauthorized: Valid API authentication token required."
        )
