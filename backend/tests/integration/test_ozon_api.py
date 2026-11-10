"""Integration tests for the read-only Ozon stock integration.

The Seller API itself is never contacted: ``_ozon_post`` is the single choke
point for every Ozon call, so patching it covers paging, merging and error
mapping without a network or a fake transport.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.api.routes import ozon as ozon_module
from backend.app.models.settings import Settings

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


@pytest.fixture(autouse=True)
def _clean_cache():
    ozon_module._stock_cache.clear()
    yield
    ozon_module._stock_cache.clear()


async def _configure(
    client: AsyncClient,
    *,
    enabled: bool = True,
    client_id: str = "123456",
    api_key: str = "secret-key",
) -> httpx.Response:
    return await client.put(
        "/api/v1/ozon/settings",
        json={"enabled": enabled, "client_id": client_id, "api_key": api_key},
    )


async def _stored(db_session, key: str) -> str | None:
    db_session.expire_all()
    row = await db_session.scalar(select(Settings).where(Settings.key == key))
    return row.value if row else None


async def _fake_ozon(path: str, payload: dict, client_id: str, api_key: str) -> dict:
    if path == ozon_module.STOCKS_PATH:
        return {
            "items": [
                {
                    "product_id": 10,
                    "offer_id": "BRACKET-01",
                    "stocks": [
                        {
                            "type": "fbo",
                            "warehouse_id": 1,
                            "warehouse_name": "Main",
                            "present": 7,
                            "reserved": 2,
                        },
                        {
                            "type": "fbs",
                            "warehouse_id": 2,
                            "warehouse_name": "Overflow",
                            "present": 3,
                            "reserved": 1,
                        },
                    ],
                },
                {
                    "product_id": 11,
                    "offer_id": "SPOOL-02",
                    "stocks": [
                        {
                            "type": "fbs",
                            "warehouse_id": 2,
                            "warehouse_name": "Overflow",
                            "present": 5,
                            "reserved": 0,
                        }
                    ],
                },
            ],
            "cursor": "",
        }
    if path == ozon_module.PRODUCT_INFO_PATH:
        return {
            "items": [
                {
                    "id": 10,
                    "name": "Steel bracket",
                    "sku": 900001,
                    "primary_image": "https://cdn.example/bracket.jpg",
                },
                {"id": 11, "name": "Spool holder", "sku": 900002, "images": []},
            ]
        }
    if path == ozon_module.WAREHOUSE_LIST_PATH:
        return {"result": [{"name": "Main"}, {"name": "Overflow"}]}
    raise AssertionError(f"unexpected Ozon path {path}")


class TestSettings:
    async def test_api_key_is_write_only(self, async_client: AsyncClient, db_session):
        response = await _configure(async_client)
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["enabled"] is True
        assert body["client_id"] == "123456"
        assert body["api_key_set"] is True
        assert "api_key" not in body

        fetched = await async_client.get("/api/v1/ozon/settings")
        assert fetched.status_code == 200, fetched.text
        assert fetched.json()["api_key_set"] is True
        assert "api_key" not in fetched.json()

        assert await _stored(db_session, "ozon_api_key") == "secret-key"

    async def test_blank_key_keeps_the_stored_one(self, async_client: AsyncClient, db_session):
        await _configure(async_client)

        response = await async_client.put(
            "/api/v1/ozon/settings",
            json={"enabled": True, "client_id": "654321", "api_key": ""},
        )
        assert response.status_code == 200, response.text
        assert response.json()["client_id"] == "654321"
        assert response.json()["api_key_set"] is True

        assert await _stored(db_session, "ozon_api_key") == "secret-key"
        assert await _stored(db_session, "ozon_client_id") == "654321"

    async def test_omitted_key_keeps_the_stored_one(self, async_client: AsyncClient, db_session):
        await _configure(async_client)

        response = await async_client.put(
            "/api/v1/ozon/settings",
            json={"enabled": True, "client_id": "123456"},
        )
        assert response.status_code == 200, response.text
        assert response.json()["api_key_set"] is True
        assert await _stored(db_session, "ozon_api_key") == "secret-key"


class TestStocks:
    async def test_reports_not_configured(self, async_client: AsyncClient):
        response = await async_client.get("/api/v1/ozon/stocks")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["configured"] is False
        assert body["items"] == []

    async def test_reports_disabled(self, async_client: AsyncClient):
        await _configure(async_client, enabled=False)

        response = await async_client.get("/api/v1/ozon/stocks")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["configured"] is True
        assert body["enabled"] is False

    async def test_merges_stock_and_product_info(self, async_client: AsyncClient):
        await _configure(async_client)

        with patch.object(ozon_module, "_ozon_post", AsyncMock(side_effect=_fake_ozon)):
            response = await async_client.get("/api/v1/ozon/stocks")

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["configured"] is True
        assert body["enabled"] is True
        assert body["total_products"] == 2
        assert body["total_present"] == 15
        assert body["total_reserved"] == 3
        assert body["fetched_at"] is not None

        bracket = next(item for item in body["items"] if item["offer_id"] == "BRACKET-01")
        assert bracket["name"] == "Steel bracket"
        assert bracket["sku"] == 900001
        assert bracket["image"] == "https://cdn.example/bracket.jpg"
        assert bracket["present"] == 10
        assert bracket["reserved"] == 3
        assert bracket["available"] == 7
        assert len(bracket["warehouses"]) == 2

        spool = next(item for item in body["items"] if item["offer_id"] == "SPOOL-02")
        assert spool["available"] == 5

    async def test_cache_is_reused_and_refresh_bypasses_it(self, async_client: AsyncClient):
        await _configure(async_client)
        mock = AsyncMock(side_effect=_fake_ozon)

        with patch.object(ozon_module, "_ozon_post", mock):
            first = await async_client.get("/api/v1/ozon/stocks")
            second = await async_client.get("/api/v1/ozon/stocks")
            calls_after_two = mock.await_count
            refreshed = await async_client.get("/api/v1/ozon/stocks?refresh=true")

        assert first.json()["cached"] is False
        assert second.json()["cached"] is True
        assert refreshed.json()["cached"] is False
        assert calls_after_two > 0
        assert mock.await_count > calls_after_two

    async def test_credentials_are_sent_as_headers(self, async_client: AsyncClient):
        await _configure(async_client, client_id="777", api_key="key-777")
        mock = AsyncMock(side_effect=_fake_ozon)

        with patch.object(ozon_module, "_ozon_post", mock):
            await async_client.get("/api/v1/ozon/stocks")

        for call in mock.await_args_list:
            assert call.args[2] == "777"
            assert call.args[3] == "key-777"

    async def test_api_error_maps_to_stable_code(self, async_client: AsyncClient):
        await _configure(async_client)
        failure = ozon_module.OzonApiError("ozon_invalid_credentials", "Ozon rejected the Client-Id or Api-Key.", 400)

        with patch.object(ozon_module, "_ozon_post", AsyncMock(side_effect=failure)):
            response = await async_client.get("/api/v1/ozon/stocks")

        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "ozon_invalid_credentials"


class TestConnectionTest:
    async def test_uses_unsaved_credentials(self, async_client: AsyncClient):
        mock = AsyncMock(return_value={"result": [{"name": "Main"}, {"name": "Overflow"}]})

        with patch.object(ozon_module, "_ozon_post", mock):
            response = await async_client.post(
                "/api/v1/ozon/test",
                json={"client_id": "111", "api_key": "abc"},
            )

        assert response.status_code == 200, response.text
        assert response.json() == {"ok": True, "warehouses": 2}
        assert mock.await_args.args[0] == ozon_module.WAREHOUSE_LIST_PATH

    async def test_reports_missing_credentials(self, async_client: AsyncClient):
        response = await async_client.post("/api/v1/ozon/test", json={})
        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "ozon_not_configured"


class TestErrorMapping:
    async def test_auth_failure(self):
        error = ozon_module._ozon_error(httpx.Response(403, json={"message": "forbidden"}))
        assert error.code == "ozon_invalid_credentials"
        assert error.status == 400

    async def test_rate_limit(self):
        error = ozon_module._ozon_error(httpx.Response(429, json={"message": "slow down"}))
        assert error.code == "ozon_rate_limited"
        assert error.status == 429

    async def test_other_failure_keeps_ozon_message(self):
        error = ozon_module._ozon_error(httpx.Response(500, json={"message": "boom"}))
        assert error.code == "ozon_api_error"
        assert "boom" in error.message


class TestPaging:
    async def test_cursor_is_followed_and_repeats_stop(self):
        pages = [
            {"items": [{"product_id": 1}], "cursor": "page-2"},
            {"items": [{"product_id": 2}], "cursor": "page-2"},
        ]
        mock = AsyncMock(side_effect=pages)

        with patch.object(ozon_module, "_ozon_post", mock):
            rows = await ozon_module._fetch_stock_rows("id", "key")

        # The repeated cursor is treated as the end, so the second page is read
        # once and no third call is made.
        assert [row["product_id"] for row in rows] == [1, 2]
        assert mock.await_count == 2
