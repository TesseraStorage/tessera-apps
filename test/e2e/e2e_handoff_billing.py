#!/usr/bin/env python3
"""Local end-to-end harness for the P6 handoff + billing flow (Task 8).

Brings up, entirely on throwaway resources:

  * a scratch Postgres fleet database (migrations 073-080 from the moneyd
    checkout) and a scratch indexd database (the real ``persist/postgres/
    init.sql`` schema) -- both created and dropped by this script;
  * a scratch moneyd process launched from ``--tessera-root`` (default
    ``/root/tessera``) with process-env settings that override every live
    env file;
  * a scratch indexer stub (HTTP + the scratch indexd database) that answers
    moneyd's admin API and accepts a simplified ``POST /register``;
  * a temp static server + proxy that serves ``apps/web/dist`` at ``/web/``
    (SPA fallback, ``Referrer-Policy: no-referrer``), proxies ``/api/v1`` to
    the scratch moneyd and strips ``/web/idx/`` to the stub indexer -- the
    same shape as the staged P6 nginx.

The happy path drives the real shared browser code (``packages/shared/src/
handoff.js`` state machine and ``billing.js`` account view) through Node
helpers committed next to this script:

  session cookie -> POST /api/v1/credentials -> POST /api/v1/handoff/mint ->
  fragment URL ``/web/#handoff=<code>`` -> real ``extractHandoffCode`` +
  ``consumeHandoffCode`` (200) -> register via the stub through ``/web/idx/``
  -> best-effort activate (200) -> account payload rendered by the real
  ``createBillingView``.

Refusal paths assert consume 409 ``already_registered``, consume 410
``invalid_code``, and that a consumed code re-consumes as 410.

Handoff codes are secrets: they are generated here, passed to Node through
the child environment, never printed, never written to any capture file, and
every captured artifact (moneyd stdout/stderr, proxy/stub access logs, Node
stdout/stderr and its diary, this script's own console log) is scanned for
the code strings before the run is allowed to pass.

Usage:
    python3 test/e2e/e2e_handoff_billing.py [--tessera-root DIR] [--keep]

Exit status 0 only when every assertion passed; the run is rerunnable
(databases are dropped and recreated on entry, ports and tmpdirs are fresh).
"""

from __future__ import annotations

import argparse
import base64
import atexit
import hashlib
import http.client
import json
import mimetypes
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

try:
    import psycopg2
except ImportError:  # pragma: no cover - environment prerequisite
    sys.exit("psycopg2 is required to run this harness")

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TESSERA_ROOT = Path("/root/tessera")
TESSERAD_ENV_FILE = Path("/root/tessera-config/tesserad.env")
FLEET_MIGRATIONS = ("073", "074", "075", "076", "077", "078", "079", "080")
FLEET_DB = "tessera_e2e_task8_fleet"
INDEXD_DB = "tessera_e2e_task8_indexd"
MAINTENANCE_DB = "postgres"
FORBIDDEN_DB_NAMES = {"fleet", "indexd"}
QUOTA_MAX_PINNED = {
    "default": 10**12,
    "plan-pending": 0,
    "plan-payg": 10**12,
    "plan-starter": 10**12,
    "plan-revoked": 0,
}
NODE_HELPER = Path(__file__).resolve().parent / "handoff_client.mjs"
NODE_RENDER = Path(__file__).resolve().parent / "account_render.mjs"


class Fail(Exception):
    """An assertion failed; the message never contains secret values."""


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        text = path.read_text()
    except OSError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def with_dbname(dsn: str, dbname: str) -> str:
    parts = urlsplit(dsn)
    if parts.scheme.startswith("postgres"):
        return urlunsplit(parts._replace(path="/" + dbname))
    if re.search(r"(?:^|\s)dbname\s*=", dsn):
        return re.sub(
            r"((?:^|\s)dbname\s*=\s*)\S+", r"\g<1>" + dbname, dsn, count=1
        )
    return f"{dsn} dbname={dbname}"


def fingerprint(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()[:12]


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class IndexerStub:
    """Minimal indexer stand-in: moneyd's admin API + simplified register."""

    def __init__(self, dsn: str, admin_password: str, access_log: Path, say):
        self.dsn = dsn
        self.admin_password = admin_password
        self.access_log = access_log
        self.say = say
        handler = _make_stub_handler(self)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.server.daemon_threads = True
        self.port = int(self.server.server_address[1])
        self.thread = threading.Thread(
            target=self.server.serve_forever, name="indexer-stub", daemon=True
        )

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def log(self, line: str) -> None:
        with self.access_log.open("a") as fh:
            fh.write(line + "\n")

    def connect(self):
        conn = psycopg2.connect(self.dsn)
        conn.autocommit = True
        return conn

    def basic_ok(self, header: str | None) -> bool:
        expected = base64.b64encode(
            ("admin:" + self.admin_password).encode()
        ).decode()
        return header == "Basic " + expected

    def ensure_quota(self, cur, name: str) -> None:
        cap = QUOTA_MAX_PINNED.get(name, 10**12)
        cur.execute(
            "INSERT INTO quotas (name, description, max_pinned_data, "
            "total_uses, fund_target_bytes) VALUES (%s, %s, %s, %s, %s) "
            "ON CONFLICT (name) DO NOTHING",
            (name, f"e2e stub quota {name}", cap, 5, 0),
        )

    def upsert_connect_key(self, key: str, quota: str, description: str):
        conn = self.connect()
        try:
            with conn.cursor() as cur:
                self.ensure_quota(cur, quota)
                cur.execute(
                    "INSERT INTO app_connect_keys "
                    "(user_secret, app_key, use_description, quota_name) "
                    "VALUES (%s, %s, %s, %s) "
                    "ON CONFLICT (app_key) DO UPDATE SET "
                    "quota_name = EXCLUDED.quota_name, "
                    "use_description = EXCLUDED.use_description, "
                    "updated_at = now() RETURNING id",
                    (secrets.token_bytes(32), key, description, quota),
                )
                return int(cur.fetchone()[0])
        finally:
            conn.close()

    def update_connect_key_quota(self, key: str, quota: str, description: str):
        return self.upsert_connect_key(key, quota, description)

    def register_account(self, app_key: str):
        conn = self.connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT k.id, q.max_pinned_data FROM app_connect_keys k "
                    "JOIN quotas q ON q.name = k.quota_name "
                    "WHERE k.app_key = %s",
                    (app_key,),
                )
                row = cur.fetchone()
                if row is None:
                    return None
                key_id, cap = row
                public_key = secrets.token_bytes(32)
                cur.execute(
                    "INSERT INTO accounts "
                    "(public_key, connect_key_id, max_pinned_data, name) "
                    "VALUES (%s, %s, %s, %s) RETURNING id",
                    (psycopg2.Binary(public_key), key_id, int(cap), "e2e"),
                )
                account_id = int(cur.fetchone()[0])
                return {
                    "ok": True,
                    "account_id": account_id,
                    "public_key": "ed25519:" + public_key.hex(),
                }
        finally:
            conn.close()

    def account_by_public_key(self, pk_path: str):
        pk_hex = pk_path.rsplit(":", 1)[-1].lower()
        try:
            pk_bytes = bytes.fromhex(pk_hex)
        except ValueError:
            return None
        conn = self.connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id FROM accounts WHERE public_key = %s "
                    "AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
                    (psycopg2.Binary(pk_bytes),),
                )
                row = cur.fetchone()
                return None if row is None else int(row[0])
        finally:
            conn.close()

    def patch_account(self, pk_path: str, body: dict) -> bool:
        account_id = self.account_by_public_key(pk_path)
        if account_id is None:
            return False
        conn = self.connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE accounts SET max_pinned_data = %s WHERE id = %s",
                    (int(body.get("maxPinnedData", 0)), account_id),
                )
            return True
        finally:
            conn.close()

    def set_funding_paused(self, pk_path: str, paused: bool) -> bool:
        account_id = self.account_by_public_key(pk_path)
        if account_id is None:
            return False
        conn = self.connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE accounts SET funding_paused = %s WHERE id = %s",
                    (paused, account_id),
                )
            return True
        finally:
            conn.close()

    def apply_budget(self, pk_path: str, body: dict) -> bool:
        account_id = self.account_by_public_key(pk_path)
        if account_id is None:
            return False
        conn = self.connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO account_funding_budget_events "
                    "(account_id, credit_id, delta_usd) VALUES (%s, %s, %s) "
                    "ON CONFLICT (credit_id) DO NOTHING",
                    (
                        account_id,
                        int(body.get("creditId", 0)),
                        float(body.get("deltaFundingBudgetUSD", 0)),
                    ),
                )
                cur.execute(
                    "UPDATE accounts SET funding_budget_usd = "
                    "COALESCE(funding_budget_usd, 0) + %s WHERE id = %s",
                    (float(body.get("deltaFundingBudgetUSD", 0)), account_id),
                )
            return True
        finally:
            conn.close()

    def delete_account(self, pk_path: str) -> bool:
        account_id = self.account_by_public_key(pk_path)
        if account_id is None:
            return False
        conn = self.connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE accounts SET deleted_at = now() WHERE id = %s",
                    (account_id,),
                )
            return True
        finally:
            conn.close()


def _read_request_body(handler) -> bytes:
    length = handler.headers.get("Content-Length")
    if not length:
        return b""
    return handler.rfile.read(int(length))


def _send_json(handler, status: int, payload: dict) -> None:
    data = json.dumps(payload).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def _make_stub_handler(stub: IndexerStub):
    class StubHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            pass

        def _handle(self):
            body_bytes = _read_request_body(self)
            path = urlsplit(self.path).path
            status = 500
            try:
                status = self._route(path, body_bytes)
            finally:
                stub.log(f"{self.command} {self.path} -> {status}")

        def _auth_or_401(self) -> bool:
            if not stub.basic_ok(self.headers.get("Authorization")):
                _send_json(self, 401, {"error": "unauthorized"})
                return False
            return True

        def _route(self, path: str, body_bytes: bytes) -> int:
            try:
                body = json.loads(body_bytes) if body_bytes else {}
            except json.JSONDecodeError:
                _send_json(self, 400, {"error": "bad_json"})
                return 400

            if path.startswith("/api/"):
                if not self._auth_or_401():
                    return 401

            if path == "/register" and self.command == "POST":
                app_key = body.get("app_key")
                if not isinstance(app_key, str) or not app_key:
                    _send_json(self, 422, {"error": "app_key_required"})
                    return 422
                result = stub.register_account(app_key)
                if result is None:
                    _send_json(self, 404, {"error": "unknown_app_key"})
                    return 404
                _send_json(self, 200, result)
                return 200

            if path == "/api/apps/connect/keys" and self.command in (
                "POST",
                "PUT",
            ):
                key = body.get("key")
                quota = body.get("quota")
                if not key or not quota:
                    _send_json(self, 422, {"error": "key_and_quota_required"})
                    return 422
                stub.update_connect_key_quota(
                    key, quota, body.get("description") or ""
                )
                _send_json(self, 200, {"key": key})
                return 200

            if path.startswith("/api/apps/connect/keys/") and self.command == "GET":
                key = urllib.parse.unquote(path.rsplit("/", 1)[-1])
                conn = stub.connect()
                try:
                    with conn.cursor() as cur:
                        cur.execute(
                            "SELECT quota_name FROM app_connect_keys "
                            "WHERE app_key = %s",
                            (key,),
                        )
                        row = cur.fetchone()
                finally:
                    conn.close()
                if row is None:
                    _send_json(self, 404, {"error": "unknown_key"})
                    return 404
                _send_json(self, 200, {"key": key, "quota": row[0]})
                return 200

            if path.startswith("/api/quotas/") and self.command == "PUT":
                name = urllib.parse.unquote(path.rsplit("/", 1)[-1])
                conn = stub.connect()
                try:
                    with conn.cursor() as cur:
                        stub.ensure_quota(cur, name)
                finally:
                    conn.close()
                _send_json(self, 200, {"name": name})
                return 200

            if path.startswith("/api/account/"):
                rest = path[len("/api/account/"):]
                if rest.endswith("/funding/pause") and self.command == "POST":
                    pk = rest[: -len("/funding/pause")]
                    ok = stub.set_funding_paused(pk, True)
                elif rest.endswith("/funding/unpause") and self.command == "POST":
                    pk = rest[: -len("/funding/unpause")]
                    ok = stub.set_funding_paused(pk, False)
                elif rest.endswith("/funding/budget") and self.command == "POST":
                    pk = rest[: -len("/funding/budget")]
                    ok = stub.apply_budget(pk, body)
                elif self.command == "PATCH":
                    ok = stub.patch_account(rest, body)
                elif self.command == "DELETE":
                    ok = stub.delete_account(rest)
                else:
                    _send_json(self, 404, {"error": "not_found"})
                    return 404
                if not ok:
                    _send_json(self, 404, {"error": "account_not_found"})
                    return 404
                _send_json(self, 200, ok and {"ok": True})
                return 200

            _send_json(self, 404, {"error": "not_found"})
            return 404

        def do_GET(self):
            self._handle()

        def do_POST(self):
            self._handle()

        def do_PUT(self):
            self._handle()

        def do_PATCH(self):
            self._handle()

        def do_DELETE(self):
            self._handle()

    return StubHandler


class FrontDoor:
    """Static server for apps/web/dist + temp proxy for /api/v1 and /web/idx/."""

    def __init__(
        self,
        dist_root: Path,
        moneyd_port: int,
        stub_port: int,
        access_log: Path,
    ):
        self.dist_root = dist_root
        self.moneyd_port = moneyd_port
        self.stub_port = stub_port
        self.access_log = access_log
        handler = _make_front_handler(self)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.server.daemon_threads = True
        self.port = int(self.server.server_address[1])
        self.thread = threading.Thread(
            target=self.server.serve_forever, name="front-door", daemon=True
        )

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def log(self, line: str) -> None:
        with self.access_log.open("a") as fh:
            fh.write(line + "\n")


HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


def _make_front_handler(front: FrontDoor):
    class FrontHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            pass

        def _handle(self):
            body = _read_request_body(self)
            path = urlsplit(self.path).path
            status = 500
            try:
                if path.startswith("/api/v1"):
                    status = self._proxy(
                        "127.0.0.1", front.moneyd_port, self.path, body
                    )
                elif path.startswith("/web/idx/"):
                    stripped = self.path[len("/web/idx"):]
                    status = self._proxy(
                        "127.0.0.1", front.stub_port, stripped, body
                    )
                elif path in ("/", ""):
                    self.send_response(302)
                    self.send_header("Location", "/web/")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    status = 302
                else:
                    status = self._static(path)
            except Exception:  # noqa: BLE001 - surface as 502
                status = 502
                try:
                    _send_json(self, 502, {"error": "front_door_error"})
                except Exception:  # noqa: BLE001
                    pass
            front.log(f"{self.command} {self.path} -> {status}")

        def _proxy(
            self, host: str, port: int, upstream_path: str, body: bytes
        ) -> int:
            headers = {}
            for name, value in self.headers.items():
                lower = name.lower()
                if lower in HOP_HEADERS or lower in (
                    "host",
                    "content-length",
                    "accept-encoding",
                ):
                    continue
                headers[name] = value
            conn = http.client.HTTPConnection(host, port, timeout=20)
            try:
                conn.request(
                    self.command,
                    upstream_path,
                    body=body or None,
                    headers=headers,
                )
                response = conn.getresponse()
                data = response.read()
                status = response.status
                self.send_response(status)
                for name, value in response.getheaders():
                    lower = name.lower()
                    if lower in HOP_HEADERS or lower == "content-length":
                        continue
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return status
            finally:
                conn.close()

        def _static(self, path: str) -> int:
            relative = path[len("/web/"):] if path.startswith("/web/") else ""
            candidates = [relative] if relative else []
            candidate_path = None
            for rel in candidates:
                if not rel:
                    continue
                resolved = (front.dist_root / rel).resolve()
                try:
                    resolved.relative_to(front.dist_root.resolve())
                except ValueError:
                    continue
                if resolved.is_file():
                    candidate_path = resolved
                    break
                if resolved.is_dir() and (resolved / "index.html").is_file():
                    candidate_path = resolved / "index.html"
                    break
            if candidate_path is None:
                candidate_path = front.dist_root / "index.html"
            if not candidate_path.is_file():
                _send_json(self, 404, {"error": "not_found"})
                return 404
            data = candidate_path.read_bytes()
            content_type, _ = mimetypes.guess_type(str(candidate_path))
            self.send_response(200)
            self.send_header(
                "Content-Type", content_type or "application/octet-stream"
            )
            if self.path.startswith("/web"):
                self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return 200

        def do_GET(self):
            self._handle()

        def do_POST(self):
            self._handle()

        def do_PUT(self):
            self._handle()

        def do_PATCH(self):
            self._handle()

        def do_DELETE(self):
            self._handle()

    return FrontHandler


class Harness:
    def __init__(self, tessera_root: Path, keep: bool):
        self.tessera_root = tessera_root
        self.moneyd_src = tessera_root / "dataplane" / "moneyd"
        self.migrations_dir = tessera_root / "dataplane" / "migrations"
        self.indexd_schema = tessera_root / "persist" / "postgres" / "init.sql"
        self.dist_root = REPO_ROOT / "apps" / "web" / "dist"
        self.keep = keep
        self.tmp = Path(tempfile.mkdtemp(prefix="tessera-e2e-task8-"))
        self.log_path = self.tmp / "harness.log"
        self.step = 0
        self.moneyd_proc = None
        self.stub = None
        self.front = None
        self.captured: list[Path] = [self.log_path]
        self.codes: list[str] = []
        self.cleaned = False
        self.fleet_dsn = ""
        self.indexd_dsn = ""
        self.admin_dsn = ""
        self.admin_password = secrets.token_urlsafe(24)
        self.session_secret = secrets.token_urlsafe(48)
        self.agent_pepper = secrets.token_urlsafe(48)
        self.public_base = ""
        self.cookie_a = ""
        self.cookie_b = ""
        self.billing_a = "TESS-E2E-A-" + secrets.token_hex(4)
        self.billing_b = "TESS-E2E-B-" + secrets.token_hex(4)


    def say(self, line: str) -> None:
        text = f"[task8] {line}"
        print(text, flush=True)
        with self.log_path.open("a") as fh:
            fh.write(text + "\n")

    def check(self, condition: bool, label: str) -> None:
        if condition:
            self.step += 1
            self.say(f"{self.step:02d}. PASS {label}")
        else:
            raise Fail(label)


    def psql(self, dsn: str, sql: str) -> None:
        conn = psycopg2.connect(dsn)
        conn.autocommit = True
        try:
            with conn.cursor() as cur:
                cur.execute(sql)
        finally:
            conn.close()

    def create_databases(self) -> None:
        live = os.environ.get("TESSERA_FLEET_DSN") or read_env_file(
            TESSERAD_ENV_FILE
        ).get("TESSERA_FLEET_DSN")
        if not live:
            raise Fail(
                "TESSERA_FLEET_DSN is not set and not found in "
                f"{TESSERAD_ENV_FILE}"
            )
        for name in (FLEET_DB, INDEXD_DB):
            if name in FORBIDDEN_DB_NAMES:
                raise Fail(f"refusing to touch live database name {name}")
        self.fleet_dsn = with_dbname(live, FLEET_DB)
        self.indexd_dsn = with_dbname(live, INDEXD_DB)
        self.admin_dsn = with_dbname(live, MAINTENANCE_DB)
        admin = psycopg2.connect(self.admin_dsn)
        admin.autocommit = True
        try:
            with admin.cursor() as cur:
                for name in (FLEET_DB, INDEXD_DB):
                    cur.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
                    cur.execute(f'CREATE DATABASE "{name}"')
        finally:
            admin.close()
        self.say(
            f"scratch databases created: {FLEET_DB}, {INDEXD_DB} "
            "(live fleet/indexd untouched)"
        )

    def drop_databases(self) -> None:
        if not self.admin_dsn:
            return
        try:
            admin = psycopg2.connect(self.admin_dsn)
        except Exception:  # noqa: BLE001 - cleanup is best-effort
            return
        admin.autocommit = True
        try:
            with admin.cursor() as cur:
                for name in (FLEET_DB, INDEXD_DB):
                    cur.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        finally:
            admin.close()

    def build_schemas(self) -> None:
        conn = psycopg2.connect(self.fleet_dsn)
        conn.autocommit = True
        try:
            with conn.cursor() as cur:
                for number in FLEET_MIGRATIONS:
                    matches = sorted(self.migrations_dir.glob(f"{number}_*.sql"))
                    if not matches:
                        raise Fail(f"migration {number}_*.sql not found")
                    cur.execute("\n".join(p.read_text() for p in matches))
        finally:
            conn.close()
        schema_sql = self.indexd_schema.read_text()
        conn = psycopg2.connect(self.indexd_dsn)
        conn.autocommit = True
        try:
            with conn.cursor() as cur:
                cur.execute(schema_sql)
        finally:
            conn.close()
        self.say(
            "schemas applied: fleet migrations 073-080, indexd init.sql"
        )

    def seed_account(self, billing_id: str, email: str) -> str:
        conn = psycopg2.connect(self.fleet_dsn)
        conn.autocommit = True
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO customer_accounts "
                    "(billing_id, display_name, kind, status, balance_usdt, "
                    "first_funded_at, email) "
                    "VALUES (%s, %s, 'human', 'active', 25, now(), %s)",
                    (billing_id, billing_id, email),
                )
                token = secrets.token_urlsafe(32)
                token_hash = hashlib.sha256(token.encode()).hexdigest()
                cur.execute(
                    "INSERT INTO magic_links "
                    "(email, billing_id, token_hash, expires_at) "
                    "VALUES (%s, %s, %s, now() + interval '15 minutes')",
                    (email, billing_id, token_hash),
                )
        finally:
            conn.close()
        return token

    def fleet_query(self, sql: str, params: tuple):
        conn = psycopg2.connect(self.fleet_dsn)
        try:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                return cur.fetchone()
        finally:
            conn.close()


    def start_stub(self) -> None:
        self.stub = IndexerStub(
            self.indexd_dsn,
            self.admin_password,
            self.tmp / "stub.access.log",
            self.say,
        )
        self.stub.start()
        self.captured.append(self.tmp / "stub.access.log")
        self.say(f"indexer stub up on 127.0.0.1:{self.stub.port}")

    def start_moneyd(self) -> None:
        port = free_port()
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("TESSERA_") and key != "ADMIN_PASSWORD"
        }
        env.update(
            {
                "TESSERA_FLEET_DSN": self.fleet_dsn,
                "TESSERA_INDEXD_DSN": self.indexd_dsn,
                "TESSERA_INDEXD_ADMIN_URL": (
                    f"http://127.0.0.1:{self.stub.port}/api"
                ),
                "ADMIN_PASSWORD": self.admin_password,
                "TESSERA_SESSION_SECRET": self.session_secret,
                "TESSERA_AGENT_KEY_PEPPER": self.agent_pepper,
                "TESSERA_TICK_SECONDS": "3600",
                "TESSERA_DUNNING_ARMED": "false",
                "TESSERA_PUBLIC_BASE_URL": self.public_base,
                "TESSERA_ADMIN_PROXY_TOKEN": "",
                "TESSERA_ADMIN_GUARD_DISABLED": "1",
            }
        )
        stdout = (self.tmp / "moneyd.out").open("wb")
        self.captured.append(self.tmp / "moneyd.out")
        self.moneyd_proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "moneyd.app:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--log-level",
                "info",
                "--app-dir",
                str(self.moneyd_src.parent),
            ],
            cwd=str(self.moneyd_src.parent),
            env=env,
            stdout=stdout,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/healthz", timeout=2
                ) as response:
                    if response.status == 200:
                        self.moneyd_port = port
                        self.say(
                            f"scratch moneyd up on 127.0.0.1:{port} "
                            "(healthz ok)"
                        )
                        return
            except Exception:  # noqa: BLE001 - keep polling
                pass
            if self.moneyd_proc.poll() is not None:
                break
            time.sleep(0.25)
        raise Fail("scratch moneyd did not become healthy on /healthz")

    def prepare_front(self) -> None:
        if not (self.dist_root / "index.html").is_file():
            raise Fail(
                f"{self.dist_root}/index.html missing; run `npm run build:web`"
            )
        self.front = FrontDoor(
            self.dist_root,
            0,
            self.stub.port,
            self.tmp / "front.access.log",
        )
        self.captured.append(self.tmp / "front.access.log")
        self.public_base = self.front.base_url
        self.say(
            f"static server + proxy reserved on {self.public_base} "
            "(/web/ static, /api/v1 -> moneyd, /web/idx/ -> stub)"
        )

    def start_front(self) -> None:
        self.front.moneyd_port = self.moneyd_port
        self.front.start()


    def request(
        self,
        method: str,
        path: str,
        body: dict | None = None,
        cookie: str | None = None,
        origin: bool = True,
    ):
        url = self.public_base + path
        data = None if body is None else json.dumps(body).encode()
        headers = {"Accept": "application/json", "Connection": "close"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if cookie:
            headers["Cookie"] = cookie
        if origin and method.upper() in ("POST", "PUT", "PATCH", "DELETE"):
            headers["Origin"] = self.public_base
        request = urllib.request.Request(
            url, data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                raw = response.read()
                status = response.status
                response_headers = response.headers
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            status = exc.code
            response_headers = exc.headers
        payload = None
        if raw:
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                payload = raw.decode("utf-8", "replace")
        return status, payload, response_headers

    def session_cookie(self, token: str) -> str:
        status, payload, headers = self.request(
            "POST", "/api/v1/auth/verify", {"token": token}, origin=True
        )
        if status != 200:
            raise Fail(f"auth/verify answered {status}")
        set_cookie = headers.get("Set-Cookie") or ""
        match = re.search(r"tessera_session=([^;]+)", set_cookie)
        if not match:
            raise Fail("auth/verify did not set a session cookie")
        return "tessera_session=" + match.group(1)


    def run_node(self, helper: Path, mode: str, env_extra: dict, name: str):
        env = os.environ.copy()
        env.update(env_extra)
        stdout_path = self.tmp / f"{name}.stdout"
        stderr_path = self.tmp / f"{name}.stderr"
        with stdout_path.open("wb") as out, stderr_path.open("wb") as err:
            proc = subprocess.run(
                ["node", str(helper), mode],
                env=env,
                stdout=out,
                stderr=err,
                timeout=120,
            )
        for capture in (stdout_path, stderr_path):
            self.captured.append(capture)
        text = stdout_path.read_text()
        for line in text.splitlines():
            self.say(f"[node:{name}] {line}")
        for line in stderr_path.read_text().splitlines():
            self.say(f"[node:{name}:err] {line}")
        if proc.returncode != 0:
            raise Fail(f"{name} exited {proc.returncode}")
        return text


    def mint_code(self, cookie: str) -> str:
        status, payload, _ = self.request(
            "POST", "/api/v1/handoff/mint", cookie=cookie
        )
        self.check(status == 200, "handoff/mint answered 200")
        if not isinstance(payload, dict) or not isinstance(
            payload.get("code"), str
        ):
            raise Fail("handoff/mint body missing code")
        code = payload["code"]
        self.codes.append(code)
        self.say(
            "minted handoff code "
            f"(sha256:{fingerprint(code)}, length={len(code)}, redacted)"
        )
        return code

    def run(self) -> None:
        if not NODE_HELPER.is_file() or not NODE_RENDER.is_file():
            raise Fail("Node helper scripts are missing")
        for required in (self.moneyd_src, self.migrations_dir, self.indexd_schema):
            if not required.exists():
                raise Fail(f"required path missing: {required}")

        self.create_databases()
        self.build_schemas()
        token_a = self.seed_account(self.billing_a, "e2e-a@example.test")
        token_b = self.seed_account(self.billing_b, "e2e-b@example.test")
        self.start_stub()
        self.prepare_front()
        self.start_moneyd()
        self.start_front()

        self.check(
            self.public_base.startswith("http://127.0.0.1:"),
            "temp proxy is loopback-only",
        )

        self.cookie_a = self.session_cookie(token_a)
        self.check(
            self.cookie_a.startswith("tessera_session="),
            "session cookie obtained via /api/v1/auth/verify",
        )

        status, payload, _ = self.request(
            "POST", "/api/v1/credentials", {}, cookie=self.cookie_a
        )
        self.check(status == 200, "POST /api/v1/credentials answered 200")
        if not isinstance(payload, dict) or not isinstance(
            payload.get("connect_key"), str
        ):
            raise Fail("credentials response missing connect_key")
        self.check(
            payload.get("quota") == "plan-payg",
            "minted credential carries the funded plan-payg quota",
        )
        self.say("connect key held in memory only (redacted)")

        code_m1 = self.mint_code(self.cookie_a)
        fragment_url = "/web/#handoff=" + urllib.parse.quote(code_m1, safe="")
        self.check(
            fragment_url.startswith("/web/#handoff=")
            and "?handoff=" not in fragment_url,
            "redirect URL carries the code in the fragment, not the query",
        )
        self.say(
            f"fragment redirect URL: {self.public_base}{fragment_url.split('=', 1)[0]}=<redacted>"
        )

        status, shell, headers = self.request("GET", "/web/")
        self.check(status == 200, "browser GET /web/ serves the static shell")
        self.check(
            isinstance(shell, str) and "app-root" in shell,
            "static shell is the built web app",
        )
        self.check(
            headers.get("Referrer-Policy") == "no-referrer",
            "static shell sets Referrer-Policy: no-referrer",
        )

        diary = self.tmp / "node-happy-diary.log"
        happy_env = {
            "TESSERA_E2E_API_BASE": self.public_base,
            "TESSERA_E2E_COOKIE": self.cookie_a,
            "TESSERA_E2E_FRAGMENT_URL": self.public_base + fragment_url,
            "TESSERA_E2E_EXPECTED_CODE": code_m1,
            "TESSERA_E2E_DIARY": str(diary),
        }
        happy_out = self.run_node(NODE_HELPER, "happy", happy_env, "happy")
        self.captured.append(diary)
        self.check("fragment_code_match=true" in happy_out, "Node parsed the fragment code with extractHandoffCode")
        self.check("consume_status=200" in happy_out, "real consumeHandoffCode answered 200")
        self.check("register_status=200" in happy_out, "registration via /web/idx/ stub answered 200")
        self.check("machine_state=resumed" in happy_out, "handoff state machine reached resumed")
        self.check("activate_outcome=linked" in happy_out, "activate answered 200 and linked")
        self.check("reconsume_status=410" in happy_out, "consumed code re-consumes as 410 invalid_code")

        linked = self.fleet_query(
            "SELECT indexd_account_id, connect_key FROM storage_identities "
            "WHERE billing_id = %s AND revoked_at IS NULL",
            (self.billing_a,),
        )
        self.check(
            linked is not None and linked[0] is not None,
            "moneyd linked the identity to the stub indexd account",
        )
        self.check(
            linked is not None and linked[1] is None,
            "moneyd cleared the raw connect key after linking",
        )

        status, account, _ = self.request(
            "GET", "/api/v1/account", cookie=self.cookie_a
        )
        self.check(status == 200, "GET /api/v1/account answered 200")
        self.check(
            isinstance(account, dict) and account.get("plan") == "payg",
            "account payload plan=payg",
        )
        self.check(
            isinstance(account, dict) and float(account.get("balance_usd")) == 25.0,
            "account payload balance_usd=25",
        )
        self.check(
            isinstance(account, dict) and account.get("status") == "active",
            "account payload status=active",
        )

        render_env = {
            "TESSERA_E2E_API_BASE": self.public_base,
            "TESSERA_E2E_COOKIE": self.cookie_a,
        }
        render_out = self.run_node(NODE_RENDER, "render", render_env, "render")
        self.check(
            "account_render=ok" in render_out,
            "real billing.js createBillingView rendered the account",
        )
        self.check("Balance" in render_out, "render shows the Balance field")
        self.check("$25.00" in render_out, "render shows the $25.00 balance")
        self.check("Plan" in render_out, "render shows the Plan field")
        self.check(
            "Pay as you go" in render_out, "render shows the payg plan label"
        )
        self.check("Active" in render_out, "render shows the Active status badge")
        self.check("Account ID" in render_out, "render shows the Account ID field")

        status, payload, _ = self.request(
            "POST", "/api/v1/handoff/mint", cookie=self.cookie_a
        )
        self.check(
            status == 409
            and isinstance(payload, dict)
            and payload.get("detail", {}).get("error") == "already_registered",
            "linked account mint answers 409 already_registered",
        )

        self.cookie_b = self.session_cookie(token_b)
        status, payload, _ = self.request(
            "POST", "/api/v1/credentials", {}, cookie=self.cookie_b
        )
        self.check(status == 200, "second account credential minted")
        key_b = payload["connect_key"]
        code_m2 = self.mint_code(self.cookie_b)

        status, payload, _ = self.request(
            "POST", "/web/idx/register", {"app_key": key_b}
        )
        self.check(
            status == 200 and payload.get("ok") is True,
            "second identity registered directly via /web/idx/ stub",
        )
        status, payload, _ = self.request(
            "POST", "/api/v1/credentials/activate", None, cookie=self.cookie_b
        )
        self.check(
            status == 200 and payload.get("linked") is True,
            "second identity activated before its code is consumed",
        )

        diary2 = self.tmp / "node-consume-409.log"
        out_409 = self.run_node(
            NODE_HELPER,
            "consume",
            {
                "TESSERA_E2E_API_BASE": self.public_base,
                "TESSERA_E2E_COOKIE": self.cookie_b,
                "TESSERA_E2E_CODE": code_m2,
                "TESSERA_E2E_EXPECTED_STATUS": "409",
                "TESSERA_E2E_DIARY": str(diary2),
            },
            "consume409",
        )
        self.check(
            "consume_status=409" in out_409
            and "consume_error=already_registered" in out_409,
            "unconsumed code for a linked identity answers 409 already_registered",
        )

        invalid_code = secrets.token_urlsafe(32)
        self.codes.append(invalid_code)
        diary3 = self.tmp / "node-consume-410.log"
        out_410 = self.run_node(
            NODE_HELPER,
            "consume",
            {
                "TESSERA_E2E_API_BASE": self.public_base,
                "TESSERA_E2E_COOKIE": self.cookie_b,
                "TESSERA_E2E_CODE": invalid_code,
                "TESSERA_E2E_EXPECTED_STATUS": "410",
                "TESSERA_E2E_DIARY": str(diary3),
            },
            "consume410",
        )
        self.captured.extend([diary2, diary3])
        self.check(
            "consume_status=410" in out_410
            and "consume_error=invalid_code" in out_410,
            "unknown code answers 410 invalid_code",
        )

        self.scan_captures()

    def scan_captures(self) -> None:
        seen: set[Path] = set()
        paths = []
        for path in self.captured:
            if path in seen or not path.is_file():
                continue
            seen.add(path)
            paths.append(path)
        for code in self.codes:
            for path in paths:
                text = path.read_text(errors="replace")
                if code in text:
                    raise Fail(
                        f"handoff code sha256:{fingerprint(code)} leaked "
                        f"into captured artifact {path.name}"
                    )
            for path in paths:
                text = path.read_text(errors="replace")
                if urllib.parse.quote(code, safe="") != code and urllib.parse.quote(code, safe="") in text:
                    raise Fail(
                        f"url-encoded handoff code sha256:{fingerprint(code)} "
                        f"leaked into captured artifact {path.name}"
                    )
        self.check(
            len(self.codes) >= 3,
            f"scanned {len(paths)} captured artifacts for {len(self.codes)} codes",
        )
        network_logs = [
            self.tmp / "moneyd.out",
            self.tmp / "front.access.log",
            self.tmp / "stub.access.log",
        ]
        for path in network_logs:
            if not path.is_file():
                continue
            text = path.read_text(errors="replace")
            self.check(
                "handoff=" not in text,
                f"{path.name} contains no 'handoff=' (query/fragment never logged)",
            )
        front_log = (self.tmp / "front.access.log").read_text(errors="replace")
        self.check(
            "GET /web/ -> 200" in front_log,
            "access log shows the fragment-free GET /web/ navigation",
        )


    def cleanup(self) -> None:
        if self.cleaned:
            return
        self.cleaned = True
        if self.moneyd_proc is not None and self.moneyd_proc.poll() is None:
            try:
                os.killpg(os.getpgid(self.moneyd_proc.pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.moneyd_proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(self.moneyd_proc.pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        for server in (self.front, self.stub):
            if server is not None:
                try:
                    server.stop()
                except Exception:  # noqa: BLE001
                    pass
        self.drop_databases()
        if self.keep:
            self.say(f"artifacts kept in {self.tmp}")
        else:
            shutil.rmtree(self.tmp, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--tessera-root",
        default=os.environ.get("TESSERA_ROOT", str(DEFAULT_TESSERA_ROOT)),
        help="moneyd source checkout (default /root/tessera)",
    )
    parser.add_argument(
        "--keep",
        action="store_true",
        help="keep the temp dir with all captured artifacts",
    )
    args = parser.parse_args()

    harness = Harness(Path(args.tessera_root).resolve(), args.keep)
    atexit.register(harness.cleanup)

    def _signal(_signum, _frame):
        raise SystemExit(130)

    signal.signal(signal.SIGINT, _signal)
    signal.signal(signal.SIGTERM, _signal)

    try:
        harness.run()
    except Fail as exc:
        print(f"[task8] FAIL: {exc}", flush=True)
        return 1
    except Exception as exc:  # noqa: BLE001 - include context, no secrets
        print(f"[task8] FAIL: unexpected error: {exc!r}", flush=True)
        return 1
    else:
        harness.say("PASS Task 8 local E2E: handoff + billing (all assertions green)")
    finally:
        harness.cleanup()

    return 0


if __name__ == "__main__":
    sys.exit(main())
