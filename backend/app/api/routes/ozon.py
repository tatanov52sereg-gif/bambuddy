"""Ozon Seller API integration: stock levels, read-only.

Bambuddy only ever *reads* from Ozon here. The page exists so an operator can
see what the marketplace still has on hand next to the printer farm, without
opening the Ozon Seller cabinet; stock is never pushed back, so no write path
and no extra failure mode.

Two things shape the implementation:

* Ozon's stock endpoint is cursor-paginated and rate-limited, so one refresh is
  several calls. We cache the merged result for a few minutes (per Client-Id)
  and let the page ask for a forced refresh when it really wants fresh data.
* Names are not in the stock response. Stocks carry ``product_id``/``offer_id``
  only, so the names and images come from ``/v3/product/info/list`` in chunks
  of 1000 (the API maximum).

Credentials (Client-Id + Api-Key) live in the settings table. The Api-Key is
write-only: ``GET /ozon/settings`` reports ``api_key_set`` and never the value,
and an update that leaves the key blank keeps the stored one.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.db_dialect import upsert_setting
from backend.app.core.permissions import Permission
from backend.app.models.settings import Settings
from backend.app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ozon", tags=["ozon"])

# Ozon's Seller API host. Fixed on purpose: the credentials are sent there and
# nowhere else, so no user-controlled URL can turn this into an SSRF primitive.
OZON_BASE_URL = "https://api-seller.ozon.ru"
STOCKS_PATH = "/v4/product/info/stocks"
PRODUCT_INFO_PATH = "/v3/product/info/list"
WAREHOUSE_LIST_PATH = "/v1/warehouse/list"

# Stocks and product info both cap a request at 1000 identifiers.
PAGE_LIMIT = 1000
# A farm-sized catalogue is a few hundred SKUs; the cap only exists so a
# pathological account cannot keep one refresh running forever.
MAX_PRODUCTS = 5000

# One refresh is 2-3 HTTP calls per 1000 products; five minutes keeps the page
# responsive while staying well inside Ozon's limits, which are per method and
# counted per minute. A manual refresh bypasses this.
CACHE_TTL_SECONDS = 300

_REQUEST_TIMEOUT_SECONDS = 30.0

# Ozon's product images live on its own CDN. The SPA's ``img-src`` CSP allows
# only ``'self' data: blob:``, so we proxy them instead of hotlinking (see the
# MakerWorld thumbnail endpoint for the same approach). This suffix allowlist is
# the SSRF guard: only Ozon's image CDN hosts are reachable through /thumbnail.
_IMAGE_HOST_SUFFIXES = (".ozon.ru", ".ozone.ru")
_MAX_IMAGE_BYTES = 10 * 1024 * 1024
_IMAGE_EXT_TO_MIME = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

# (client_id) -> (monotonic timestamp, response payload)
_stock_cache: dict[str, tuple[float, dict]] = {}


class OzonSettingsResponse(BaseModel):
    """Ozon connection settings, with the Api-Key replaced by a flag."""

    enabled: bool
    client_id: str
    api_key_set: bool
    low_stock_threshold_fbo: int
    low_stock_threshold_fbs: int


class OzonSettingsUpdate(BaseModel):
    """Settings form payload. An empty ``api_key`` keeps the stored key."""

    enabled: bool
    client_id: str = Field(default="", max_length=64)
    api_key: str | None = Field(default=None, max_length=256)
    low_stock_threshold_fbo: int = Field(default=0, ge=0)
    low_stock_threshold_fbs: int = Field(default=0, ge=0)


class OzonTestRequest(BaseModel):
    """Credentials to test before saving, falling back to the stored ones."""

    client_id: str | None = Field(default=None, max_length=64)
    api_key: str | None = Field(default=None, max_length=256)


class OzonWarehouseStock(BaseModel):
    """One stock row: a warehouse (and its scheme) and what it holds."""

    type: str
    warehouse_id: int | None = None
    warehouse_name: str
    present: int
    reserved: int


class OzonStockItem(BaseModel):
    """A product and its total stock across every warehouse."""

    product_id: int | None = None
    offer_id: str
    name: str
    sku: int | None = None
    image: str | None = None
    present: int
    reserved: int
    available: int
    warehouses: list[OzonWarehouseStock]


class OzonStocksResponse(BaseModel):
    """Everything the page needs in one response."""

    configured: bool
    enabled: bool
    cached: bool = False
    fetched_at: datetime | None = None
    total_products: int = 0
    total_present: int = 0
    total_reserved: int = 0
    items: list[OzonStockItem] = []
    low_stock_threshold_fbo: int = 0
    low_stock_threshold_fbs: int = 0


class OzonTestResponse(BaseModel):
    """Result of a credential check against the warehouse list."""

    ok: bool
    warehouses: int = 0


class OzonApiError(Exception):
    """An Ozon call failed, already mapped to a stable frontend code."""

    def __init__(self, code: str, message: str, status: int = 502):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


async def _get_setting(db: AsyncSession, key: str) -> str | None:
    result = await db.execute(select(Settings).where(Settings.key == key))
    setting = result.scalar_one_or_none()
    return setting.value if setting else None


async def _set_setting(db: AsyncSession, key: str, value: str) -> None:
    await upsert_setting(db, Settings, key, value)


async def _load_credentials(db: AsyncSession) -> tuple[str, str] | None:
    """The stored Client-Id and Api-Key, or None when either is missing."""
    client_id = (await _get_setting(db, "ozon_client_id") or "").strip()
    api_key = (await _get_setting(db, "ozon_api_key") or "").strip()
    if not client_id or not api_key:
        return None
    return client_id, api_key


async def _load_enabled(db: AsyncSession) -> bool:
    return (await _get_setting(db, "ozon_enabled") or "false").lower() in {"true", "1", "yes", "on"}


async def _load_threshold(db: AsyncSession, key: str) -> int:
    """A low-stock threshold setting, clamped to a non-negative integer."""
    raw = (await _get_setting(db, key) or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return 0
    return max(value, 0)


async def _load_thresholds(db: AsyncSession) -> tuple[int, int]:
    return (
        await _load_threshold(db, "ozon_low_stock_threshold_fbo"),
        await _load_threshold(db, "ozon_low_stock_threshold_fbs"),
    )


def _ozon_error(response: httpx.Response) -> OzonApiError:
    """Map an Ozon HTTP failure to the code the page knows how to explain."""
    if response.status_code in (401, 403):
        return OzonApiError(
            "ozon_invalid_credentials",
            "Ozon rejected the Client-Id or Api-Key.",
            400,
        )
    if response.status_code == 429:
        return OzonApiError(
            "ozon_rate_limited",
            "Ozon rate limit reached. Try again in a minute.",
            429,
        )
    message = "Ozon returned an error."
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        raw = body.get("message") or body.get("error")
        if isinstance(raw, str) and raw:
            message = raw
    return OzonApiError("ozon_api_error", f"{message} (HTTP {response.status_code})")


async def _ozon_post(path: str, payload: dict, client_id: str, api_key: str) -> dict:
    """One authenticated POST to the Seller API.

    A single client per call: refreshes are rare, and an app-scoped client
    would have to be torn down on config changes for no real gain.
    """
    headers = {
        "Client-Id": client_id,
        "Api-Key": api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS, follow_redirects=False) as client:
            response = await client.post(f"{OZON_BASE_URL}{path}", json=payload, headers=headers)
    except httpx.HTTPError as exc:
        logger.warning("Ozon request to %s failed: %s", path, exc)
        raise OzonApiError("ozon_unavailable", "Ozon is not reachable right now.") from exc

    if response.status_code >= 400:
        raise _ozon_error(response)

    try:
        body = response.json()
    except ValueError as exc:
        raise OzonApiError("ozon_api_error", "Ozon returned a malformed response.") from exc
    return body if isinstance(body, dict) else {}


def _extract_items(body: dict) -> list[dict]:
    """Items live at the top level in v4 and under ``result`` in older shapes."""
    items = body.get("items")
    if not isinstance(items, list):
        result = body.get("result")
        items = result.get("items") if isinstance(result, dict) else None
    return [item for item in items or [] if isinstance(item, dict)]


def _extract_cursor(body: dict) -> str:
    cursor = body.get("cursor")
    if not isinstance(cursor, str) or not cursor:
        result = body.get("result")
        cursor = result.get("cursor") if isinstance(result, dict) else ""
    return cursor if isinstance(cursor, str) else ""


async def _fetch_stock_rows(client_id: str, api_key: str) -> list[dict]:
    """Every product with its per-warehouse stock, following the cursor."""
    rows: list[dict] = []
    cursor = ""
    seen_cursors: set[str] = set()
    while len(rows) < MAX_PRODUCTS:
        payload: dict = {
            "filter": {"visibility": "ALL"},
            "limit": PAGE_LIMIT,
        }
        if cursor:
            payload["cursor"] = cursor
        body = await _ozon_post(STOCKS_PATH, payload, client_id, api_key)
        page = _extract_items(body)
        rows.extend(page)
        next_cursor = _extract_cursor(body)
        # No cursor means the last page. A repeated cursor would loop forever;
        # treat it as the end rather than spinning on Ozon's side.
        if not next_cursor or next_cursor in seen_cursors:
            break
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    return rows[:MAX_PRODUCTS]


async def _fetch_product_info(client_id: str, api_key: str, product_ids: list[int]) -> dict[int, dict]:
    """Names, images and SKUs for the ids the stock response listed."""
    info: dict[int, dict] = {}
    for start in range(0, len(product_ids), PAGE_LIMIT):
        chunk = product_ids[start : start + PAGE_LIMIT]
        body = await _ozon_post(
            PRODUCT_INFO_PATH,
            {"product_id": chunk},
            client_id,
            api_key,
        )
        for item in _extract_items(body):
            product_id = item.get("id")
            if isinstance(product_id, int):
                info[product_id] = item
    return info


def _first_image(item: dict) -> str | None:
    for field in ("primary_image", "images"):
        value = item.get(field)
        if isinstance(value, str) and value:
            return value
        if isinstance(value, list):
            for entry in value:
                if isinstance(entry, str) and entry:
                    return entry
    return None


def _merge_stock(rows: list[dict], info: dict[int, dict]) -> list[OzonStockItem]:
    """Combine the stock rows with the product info into the page's shape."""
    products: list[OzonStockItem] = []
    for row in rows:
        raw_id = row.get("product_id")
        product_id = raw_id if isinstance(raw_id, int) else None
        offer_id = row.get("offer_id") if isinstance(row.get("offer_id"), str) else ""
        details = info.get(product_id, {}) if product_id is not None else {}

        warehouses: list[OzonWarehouseStock] = []
        for stock in row.get("stocks") or []:
            if not isinstance(stock, dict):
                continue
            try:
                present = int(stock.get("present") or 0)
            except (TypeError, ValueError):
                present = 0
            try:
                reserved = int(stock.get("reserved") or 0)
            except (TypeError, ValueError):
                reserved = 0
            warehouses.append(
                OzonWarehouseStock(
                    type=str(stock.get("type") or ""),
                    warehouse_id=stock.get("warehouse_id") if isinstance(stock.get("warehouse_id"), int) else None,
                    warehouse_name=str(stock.get("warehouse_name") or ""),
                    present=present,
                    reserved=reserved,
                )
            )

        present_total = sum(w.present for w in warehouses)
        reserved_total = sum(w.reserved for w in warehouses)
        name = details.get("name") if isinstance(details.get("name"), str) else ""
        sku = details.get("sku") if isinstance(details.get("sku"), int) else None
        products.append(
            OzonStockItem(
                product_id=product_id,
                offer_id=offer_id,
                name=name or offer_id or (str(product_id) if product_id is not None else ""),
                sku=sku,
                image=_first_image(details),
                present=present_total,
                reserved=reserved_total,
                available=max(present_total - reserved_total, 0),
                warehouses=warehouses,
            )
        )
    return products


async def _fetch_and_merge(client_id: str, api_key: str) -> list[OzonStockItem]:
    rows = await _fetch_stock_rows(client_id, api_key)
    product_ids: list[int] = []
    seen: set[int] = set()
    for row in rows:
        raw_id = row.get("product_id")
        if isinstance(raw_id, int) and raw_id not in seen:
            seen.add(raw_id)
            product_ids.append(raw_id)
    info = await _fetch_product_info(client_id, api_key, product_ids) if product_ids else {}
    return _merge_stock(rows, info)


def _not_configured() -> HTTPException:
    return HTTPException(
        status_code=400,
        detail={
            "code": "ozon_not_configured",
            "message": "Ozon Client-Id and Api-Key are not configured.",
        },
    )


def _api_error(exc: OzonApiError) -> HTTPException:
    return HTTPException(
        status_code=exc.status,
        detail={"code": exc.code, "message": exc.message},
    )


@router.get("/settings", response_model=OzonSettingsResponse)
async def get_ozon_settings(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ),
):
    """Connection settings. The Api-Key itself is never returned."""
    client_id = (await _get_setting(db, "ozon_client_id") or "").strip()
    api_key = (await _get_setting(db, "ozon_api_key") or "").strip()
    threshold_fbo, threshold_fbs = await _load_thresholds(db)
    return OzonSettingsResponse(
        enabled=await _load_enabled(db),
        client_id=client_id,
        api_key_set=bool(api_key),
        low_stock_threshold_fbo=threshold_fbo,
        low_stock_threshold_fbs=threshold_fbs,
    )


@router.put("/settings", response_model=OzonSettingsResponse)
async def update_ozon_settings(
    data: OzonSettingsUpdate,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
):
    """Save the connection settings.

    An empty ``api_key`` is not a request to erase the key: the form shows a
    blank password field on purpose, so saving without retyping must keep the
    stored credential. Clearing it is not something the UI offers.
    """
    client_id = data.client_id.strip()
    await _set_setting(db, "ozon_enabled", "true" if data.enabled else "false")
    await _set_setting(db, "ozon_client_id", client_id)
    await _set_setting(db, "ozon_low_stock_threshold_fbo", str(data.low_stock_threshold_fbo))
    await _set_setting(db, "ozon_low_stock_threshold_fbs", str(data.low_stock_threshold_fbs))
    if data.api_key and data.api_key.strip():
        await _set_setting(db, "ozon_api_key", data.api_key.strip())
    await db.commit()

    # The cached payload belongs to the old credentials; a new Client-Id or key
    # could point at a different seller account. Thresholds live in the payload
    # too, so any settings change invalidates the cached snapshot.
    _stock_cache.clear()

    api_key = (await _get_setting(db, "ozon_api_key") or "").strip()
    return OzonSettingsResponse(
        enabled=data.enabled,
        client_id=client_id,
        api_key_set=bool(api_key),
        low_stock_threshold_fbo=data.low_stock_threshold_fbo,
        low_stock_threshold_fbs=data.low_stock_threshold_fbs,
    )


@router.post("/test", response_model=OzonTestResponse)
async def test_ozon_connection(
    data: OzonTestRequest,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
):
    """Check credentials against the warehouse list, before or after saving."""
    stored = await _load_credentials(db)
    client_id = (data.client_id or "").strip() or (stored[0] if stored else "")
    api_key = (data.api_key or "").strip() or (stored[1] if stored else "")
    if not client_id or not api_key:
        raise _not_configured()

    try:
        body = await _ozon_post(WAREHOUSE_LIST_PATH, {}, client_id, api_key)
    except OzonApiError as exc:
        raise _api_error(exc) from exc

    result = body.get("result")
    warehouses = result if isinstance(result, list) else []
    return OzonTestResponse(ok=True, warehouses=len(warehouses))


@router.get("/stocks", response_model=OzonStocksResponse)
async def get_ozon_stocks(
    refresh: bool = False,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.INVENTORY_READ),
):
    """Current stock levels, served from the short-lived cache by default."""
    credentials = await _load_credentials(db)
    if credentials is None:
        return OzonStocksResponse(configured=False, enabled=False)

    enabled = await _load_enabled(db)
    if not enabled:
        return OzonStocksResponse(configured=True, enabled=False)

    client_id, api_key = credentials
    threshold_fbo, threshold_fbs = await _load_thresholds(db)
    now = time.monotonic()
    if not refresh:
        cached = _stock_cache.get(client_id)
        if cached and now - cached[0] < CACHE_TTL_SECONDS:
            # The stored payload already carries cached=False; override it so
            # the page knows it is looking at an older snapshot. Thresholds are
            # read fresh so a settings change takes effect without a refresh.
            return OzonStocksResponse(
                **{
                    **cached[1],
                    "cached": True,
                    "low_stock_threshold_fbo": threshold_fbo,
                    "low_stock_threshold_fbs": threshold_fbs,
                }
            )

    try:
        items = await _fetch_and_merge(client_id, api_key)
    except OzonApiError as exc:
        raise _api_error(exc) from exc

    payload = {
        "configured": True,
        "enabled": True,
        "cached": False,
        "fetched_at": datetime.now(timezone.utc),
        "total_products": len(items),
        "total_present": sum(item.present for item in items),
        "total_reserved": sum(item.reserved for item in items),
        "items": [item.model_dump() for item in items],
        "low_stock_threshold_fbo": threshold_fbo,
        "low_stock_threshold_fbs": threshold_fbs,
    }
    _stock_cache[client_id] = (now, payload)
    return OzonStocksResponse(**payload)


async def _fetch_image(url: str) -> tuple[bytes, str]:
    """Fetch one Ozon CDN image, returning ``(bytes, content_type)``.

    The host must be an Ozon image host (SSRF guard) and the payload is capped;
    content type is taken from the upstream header when it is an image, else
    derived from the file extension. Non-image responses are refused so an
    upstream error page can't slip through as an image.
    """
    try:
        parsed = urlparse(url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid image URL") from exc

    host = (parsed.hostname or "").lower()
    if not any(host.endswith(suffix) for suffix in _IMAGE_HOST_SUFFIXES):
        raise HTTPException(status_code=400, detail="Refusing to proxy a non-Ozon image host")

    try:
        async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS, follow_redirects=False) as client:
            response = await client.get(url)
    except httpx.HTTPError as exc:
        logger.warning("Ozon image request failed: %s", exc)
        raise HTTPException(status_code=502, detail="Ozon image is not reachable") from exc

    if response.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Ozon image returned HTTP {response.status_code}")

    upstream_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
    if upstream_type.startswith("text/") or upstream_type == "application/json":
        raise HTTPException(status_code=502, detail="Ozon image returned a non-image response")

    path_lower = parsed.path.lower()
    ext_mime: str | None = None
    for ext, mime in _IMAGE_EXT_TO_MIME.items():
        if path_lower.endswith(ext):
            ext_mime = mime
            break

    if upstream_type.startswith("image/"):
        content_type = upstream_type
    elif ext_mime is not None:
        content_type = ext_mime
    else:
        raise HTTPException(status_code=502, detail="Ozon image has an unknown content type")

    if len(response.content) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=502, detail="Ozon image is too large")

    return response.content, content_type


@router.get("/thumbnail")
async def get_thumbnail(url: str = Query(..., description="Ozon CDN image URL to proxy")):
    """Proxy a product image from Ozon's CDN.

    Unauthenticated on purpose: ``<img>`` tags cannot send Authorization
    headers, so requiring a token would break every thumbnail. The images are
    Ozon's public product photos, and the host allowlist in ``_fetch_image``
    keeps this endpoint from acting as a generic open proxy.
    """
    payload, content_type = await _fetch_image(url)
    return Response(
        content=payload,
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )
