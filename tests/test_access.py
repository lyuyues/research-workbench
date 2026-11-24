import dataclasses
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm
from starlette.websockets import WebSocketDisconnect

from backend.app import create_app

TEAM, AUD, EMAIL = "myteam", "aud-123", "owner@example.com"
ISS = f"https://{TEAM}.cloudflareaccess.com"


@pytest.fixture(scope="module")
def key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def guarded(settings, key, monkeypatch):
    jwk = RSAAlgorithm.to_jwk(key.public_key(), as_dict=True)
    jwk.update(kid="k1", alg="RS256", use="sig")
    fetched = []

    def fake_fetch(self):
        fetched.append(self.uri)
        return {"keys": [jwk]}

    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", fake_fetch)
    s = dataclasses.replace(settings, require_access_header=True, access_team=TEAM,
                            access_aud=AUD, access_email=EMAIL)
    c = TestClient(create_app(s))
    c.fetched = fetched
    return c


def token(key, **over):
    claims = {"aud": [AUD], "email": EMAIL, "iss": ISS, "exp": int(time.time()) + 300,
              "iat": int(time.time())}
    claims.update(over)
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "k1"})


def h(tok):
    return {"Cf-Access-Jwt-Assertion": tok}


def test_valid_token_allowed_and_certs_url(guarded, key):
    assert guarded.get("/api/panels", headers=h(token(key))).status_code == 200
    assert guarded.fetched == [f"{ISS}/cdn-cgi/access/certs"]


def test_health_open(guarded):
    assert guarded.get("/api/health").status_code == 200


def test_missing_header_forbidden(guarded):
    assert guarded.get("/api/panels").status_code == 403


@pytest.mark.parametrize("over", [{"aud": ["other"]}, {"email": "evil@example.com"},
                                  {"exp": int(time.time()) - 10}, {"iss": "https://evil"}])
def test_bad_claims_forbidden(guarded, key, over):
    assert guarded.get("/api/panels", headers=h(token(key, **over))).status_code == 403


def test_wrong_signature_forbidden(guarded):
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    assert guarded.get("/api/panels", headers=h(token(other))).status_code == 403


def test_garbage_forbidden(guarded):
    assert guarded.get("/api/panels", headers=h("x")).status_code == 403
    assert guarded.get("/api/panels", headers=h("a.b.c")).status_code == 403


def test_ws_requires_valid_token(guarded, key):
    for headers in [{}, h("garbage"), h(token(key, email="evil@example.com"))]:
        with pytest.raises(WebSocketDisconnect) as exc:
            with guarded.websocket_connect("/ws/agent", headers=headers) as ws:
                ws.receive_json()
        assert exc.value.code == 4403
    with guarded.websocket_connect("/ws/agent", headers=h(token(key))) as ws:
        ws.send_json({"prompt": "hi"})
        while ws.receive_json()["kind"] != "changes":
            pass


def test_guard_without_config_fails_closed(settings):
    with pytest.raises(ValueError):
        create_app(dataclasses.replace(settings, require_access_header=True))


def ws_origin(client, origin, headers=None):
    with client.websocket_connect("/ws/agent", headers={"origin": origin, **(headers or {})}) as ws:
        ws.send_json({"type": "cancel"})
        return ws.receive_json()


def test_bad_origin_rejected(client):
    with pytest.raises(WebSocketDisconnect) as exc:
        ws_origin(client, "https://evil.example")
    assert exc.value.code == 4403


def test_local_origins_allowed_only_without_access(client, guarded, key):
    assert ws_origin(client, "http://127.0.0.1:5173")["kind"] == "error"
    assert ws_origin(client, "http://localhost:5173")["kind"] == "error"
    assert ws_origin(client, "https://research.example.com")["kind"] == "error"
    with pytest.raises(WebSocketDisconnect):
        ws_origin(guarded, "http://localhost:5173", h(token(key)))
    assert ws_origin(guarded, "https://research.example.com", h(token(key)))["kind"] == "error"
