#!/usr/bin/env python3
"""End-to-end proof for server-assisted seed-phrase recovery (Packet 1).

Brings up, entirely on throwaway resources (nothing production is touched):

  * a real indexd test cluster (``tessera/e2e/clusterhost_test.go``): real app
    + admin APIs, real slab/contract machinery, 15 in-memory hosts;
  * a scratch moneyd pointed at that cluster (its own scratch fleet database);
  * a temp HTTP front door serving ``apps/web/dist`` at ``/web/`` with
    ``/api/v1`` -> moneyd and ``/web/idx/`` -> the cluster app;
  * a ``localhost:3099`` indexer proxy (the web build's ``proxyOrigin`` target
    for a loopback host);
  * the real ``tessera-cli`` built from source;
  * real headless Chromium (Playwright-core).

The scenario is a single throwaway account:

  PC1 (CLI)   magic-link sign-in, register with a fresh phrase, upload a file.
  PC2 (CLI)   a fresh home (a second machine): sign in, recover with the
              phrase only -> same app id/key, the file is listed.
  PC2 (web)   a fresh browser profile (a cleared browser): signed-in session,
              enter the phrase -> recovery -> the file is listed, and the
              indexd "App password" approval step never appears.

The phrase is generated in-process and never printed, logged, or written to
any report; only names, sizes and booleans are.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import http.server
import json
import mimetypes
import os
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
from pathlib import Path

import psycopg2

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TESSERA_ROOT = Path("/root/tessera")
DEFAULT_CLI_ROOT = Path("/root/tessera-cli")
TESSERAD_ENV_FILE = Path("/root/tessera-config/tesserad.env")
FLEET_MIGRATIONS = ("073", "074", "075", "076", "077", "078", "079", "080")
FLEET_DB = "tessera_e2e_recovery_fleet"
FORBIDDEN_DB_NAMES = {"fleet", "indexd"}
SCRATCH_DB_PREFIX = "tessera_e2e_"
BROWSER_DRIVER = Path(__file__).resolve().parent / "recovery_browser.mjs"
PW_CORE = "/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.mjs"
PW_CHROMIUM = "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome"
IDX_PROXY_PORT = 3099
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


class Fail(Exception):
    pass


def read_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.is_file():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip()
    return env


def with_dbname(dsn: str, dbname: str) -> str:
    parts = urllib.parse.urlsplit(dsn)
    return urllib.parse.urlunsplit(parts._replace(path="/" + dbname))


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def wait_port(host: str, port: int, timeout: float = 30) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=2):
                return True
        except OSError:
            time.sleep(0.2)
    return False


# ── front door / idx proxy ───────────────────────────────────────────────


def _proxy(
    handler, host: str, port: int, upstream_path: str, body: bytes, keep_host: str = ""
) -> int:
    headers = {}
    for name, value in handler.headers.items():
        lower = name.lower()
        if lower in HOP_HEADERS or lower in ("host", "content-length", "accept-encoding"):
            continue
        headers[name] = value
    # The indexer's connect/register endpoints are pinned to the advertised
    # host; the front origin IS that host, so preserve it verbatim.
    if keep_host:
        headers["Host"] = keep_host
    conn = http.client.HTTPConnection(host, port, timeout=60)
    try:
        conn.request(handler.command, upstream_path, body=body or None, headers=headers)
        response = conn.getresponse()
        data = response.read()
        status = response.status
        handler.send_response(status)
        for name, value in response.getheaders():
            if name.lower() in HOP_HEADERS or name.lower() == "content-length":
                continue
            handler.send_header(name, value)
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)
        return status
    finally:
        conn.close()


class _FrontHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    front = None  # set by make_front_handler

    def log_message(self, *args):
        pass

    def _body(self) -> bytes:
        length = self.headers.get("Content-Length")
        return self.rfile.read(int(length)) if length else b""

    def _static(self, path: str) -> int:
        dist = self.front.dist
        rel = path[len("/web/"):] if path.startswith("/web/") else ""
        candidate = None
        if rel:
            resolved = (dist / rel).resolve()
            if str(resolved).startswith(str(dist.resolve())) and resolved.is_file():
                candidate = resolved
        if candidate is None:
            candidate = dist / "index.html"
        if not candidate.is_file():
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return 404
        data = candidate.read_bytes()
        ctype = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
        # Point the built app at THIS origin as its indexer: the browser then
        # signs the front host (the cluster's advertised host) with no CORS,
        # and never touches the hardcoded index.tessera.storage.
        if "javascript" in ctype and b"index.tessera.storage" in data:
            data = data.replace(
                b"https://index.tessera.storage",
                f"http://127.0.0.1:{self.front.port}".encode(),
            )
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        if self.path.startswith("/web"):
            self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        return 200

    def _handle(self):
        body = self._body()
        path = urllib.parse.urlsplit(self.path).path
        indexer_host = f"127.0.0.1:{self.front.port}"
        try:
            if path.startswith("/api/v1"):
                _proxy(self, "127.0.0.1", self.front.moneyd_port, self.path, body)
            elif path.startswith("/web/idx/"):
                _proxy(
                    self, self.front.app_host, self.front.app_port,
                    self.path[len("/web/idx"):], body, keep_host=indexer_host,
                )
            elif path in ("/", ""):
                self.send_response(302)
                self.send_header("Location", "/web/")
                self.send_header("Content-Length", "0")
                self.end_headers()
            elif path.startswith("/web/") or path == "/web":
                self._static(path)
            else:
                # Indexer app routes (/auth/*, /objects*, /hosts, /slabs*,
                # /shared*): the front origin is the cluster's advertised
                # host, so present it and preserve Host.
                _proxy(
                    self, self.front.app_host, self.front.app_port, self.path,
                    body, keep_host=indexer_host,
                )
        except Exception:
            try:
                self.send_response(502)
                self.send_header("Content-Length", "0")
                self.end_headers()
            except Exception:  # noqa: BLE001
                pass

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _handle


def make_front_handler(front):
    return type("FrontHandler", (_FrontHandler,), {"front": front})


class FrontDoor:
    """HTTP front door: /web static + /api/v1 -> moneyd + /web/idx/ -> app."""

    def __init__(self, dist: Path):
        self.dist = dist
        self.moneyd_port = 0
        self.app_host = "127.0.0.1"
        self.app_port = 0
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), make_front_handler(self))
        self.server.daemon_threads = True
        self.port = int(self.server.server_address[1])
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self):
        self.thread.start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


class IdxProxy:
    """http://localhost:3099/idx/<path> -> the cluster app (the web build's
    proxyOrigin target for a loopback host). Adds permissive CORS because the
    app page is served from a different loopback origin."""

    def __init__(self, app_host: str, app_port: int):
        self.app_host = app_host
        self.app_port = app_port
        proxy = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def _cors(self):
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Headers", "*")
                self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")

            def _handle(self):
                if self.command == "OPTIONS":
                    self.send_response(204)
                    self._cors()
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                length = self.headers.get("Content-Length")
                body = self.rfile.read(int(length)) if length else b""
                path = self.path[len("/idx"):] or "/"
                try:
                    headers = {}
                    for name, value in self.headers.items():
                        if name.lower() in HOP_HEADERS or name.lower() in (
                            "host",
                            "content-length",
                            "origin",
                            "accept-encoding",
                        ):
                            continue
                        headers[name] = value
                    # The SDK signs indexer URLs for the host it was configured
                    # with (index.tessera.storage); indexd validates that host,
                    # so the proxy must present it (exactly like nginx does).
                    headers["Host"] = "index.tessera.storage"
                    conn = http.client.HTTPConnection(proxy.app_host, proxy.app_port, timeout=60)
                    try:
                        conn.request(self.command, path, body=body or None, headers=headers)
                        response = conn.getresponse()
                        data = response.read()
                        note = ""
                        if response.status >= 400:
                            note = " " + data[:200].decode("utf-8", "replace").replace("\n", " ")
                        print(f"[idx-proxy] {self.command} {self.path} -> {response.status}{note}", flush=True)
                        self.send_response(response.status)
                        self._cors()
                        for name, value in response.getheaders():
                            if name.lower() in HOP_HEADERS or name.lower() in (
                                "content-length",
                                "access-control-allow-origin",
                            ):
                                continue
                            self.send_header(name, value)
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                    finally:
                        conn.close()
                except Exception as exc:  # noqa: BLE001
                    print(f"[idx-proxy] {self.command} {self.path} -> 502 {exc!r}", flush=True)
                    try:
                        self.send_response(502)
                        self._cors()
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                    except Exception:  # noqa: BLE001
                        pass

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = _handle

        self.server = http.server.ThreadingHTTPServer(
            ("127.0.0.1", IDX_PROXY_PORT), Handler
        )
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


# ── harness ──────────────────────────────────────────────────────────────


class Harness:
    def __init__(self, tessera_root: Path, cli_root: Path, keep: bool, client: str):
        self.tessera_root = tessera_root
        self.cli_root = cli_root
        self.keep = keep
        self.client = client
        self.tmp = Path(tempfile.mkdtemp(prefix="tessera-recoveryproof-"))
        self.log_path = self.tmp / "harness.log"
        self.step = 0
        self.cleaned = False
        self.cleaned = False
        self.captured: list[Path] = [self.log_path]
        self.moneyd_proc = None
        self.cluster_proc = None
        self.moneyd_port = 0
        self.front = None
        self.idx_proxy = None
        self.fleet_dsn = ""
        self.cluster = {}
        self.admin_dsn = ""
        self.admin_password = secrets.token_urlsafe(24)
        self.session_secret = secrets.token_urlsafe(48)
        self.agent_pepper = secrets.token_urlsafe(48)
        self.public_base = ""
        self.advertise_url = ""
        self.shots_dir = ""
        self.hosts = 15
        self.email = "recovery-e2e@example.test"
        self.billing_id = "TESS-E2E-REC-" + secrets.token_hex(4)
        self.secrets_scan: list[str] = []

    # -- reporting ------------------------------------------------------

    def say(self, line: str) -> None:
        text = f"[recovery] {line}"
        print(text, flush=True)
        with self.log_path.open("a") as fh:
            fh.write(text + "\n")

    def check(self, condition: bool, label: str) -> None:
        if condition:
            self.step += 1
            self.say(f"{self.step:02d}. PASS {label}")
        else:
            raise Fail(label)

    # -- database -------------------------------------------------------

    def live_dsn(self) -> str:
        dsn = os.environ.get("TESSERA_FLEET_DSN") or read_env_file(TESSERAD_ENV_FILE).get(
            "TESSERA_FLEET_DSN"
        )
        if not dsn:
            raise Fail("TESSERA_FLEET_DSN not set and not found in tesserad.env")
        return dsn

    def create_fleet_db(self) -> None:
        live = self.live_dsn()
        if FLEET_DB in FORBIDDEN_DB_NAMES or not FLEET_DB.startswith(SCRATCH_DB_PREFIX):
            raise Fail(f"refusing database name {FLEET_DB!r}")
        self.fleet_dsn = with_dbname(live, FLEET_DB)
        self.admin_dsn = with_dbname(live, "postgres")
        admin = psycopg2.connect(self.admin_dsn)
        admin.autocommit = True
        try:
            with admin.cursor() as cur:
                cur.execute(f'DROP DATABASE IF EXISTS "{FLEET_DB}" WITH (FORCE)')
                cur.execute(f'CREATE DATABASE "{FLEET_DB}"')
        finally:
            admin.close()
        conn = psycopg2.connect(self.fleet_dsn)
        conn.autocommit = True
        try:
            with conn.cursor() as cur:
                for number in FLEET_MIGRATIONS:
                    matches = sorted((self.tessera_root / "dataplane" / "migrations").glob(f"{number}_*.sql"))
                    if not matches:
                        raise Fail(f"migration {number}_*.sql not found")
                    cur.execute("\n".join(p.read_text() for p in matches))
        finally:
            conn.close()
        self.say(f"fleet schema ready ({FLEET_DB})")

    def drop_fleet_db(self) -> None:
        if not self.admin_dsn:
            return
        try:
            admin = psycopg2.connect(self.admin_dsn)
        except Exception:  # noqa: BLE001
            return
        admin.autocommit = True
        try:
            with admin.cursor() as cur:
                cur.execute(f'DROP DATABASE IF EXISTS "{FLEET_DB}" WITH (FORCE)')
        finally:
            admin.close()

    def seed_account(self) -> list[str]:
        tokens = [secrets.token_urlsafe(32) for _ in range(3)]
        conn = psycopg2.connect(self.fleet_dsn)
        conn.autocommit = True
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO customer_accounts "
                    "(billing_id, display_name, kind, status, balance_usdt, "
                    "first_funded_at, email) VALUES (%s,%s,'human','active',25,now(),%s)",
                    (self.billing_id, self.billing_id, self.email),
                )
                for token in tokens:
                    cur.execute(
                        "INSERT INTO magic_links (email, billing_id, token_hash, expires_at) "
                        "VALUES (%s,%s,%s, now() + interval '15 minutes')",
                        (
                            self.email,
                            self.billing_id,
                            hashlib.sha256(token.encode()).hexdigest(),
                        ),
                    )
        finally:
            conn.close()
        return tokens

    def pg_env(self) -> dict[str, str]:
        parts = urllib.parse.urlsplit(self.live_dsn())
        return {
            "POSTGRES_USER": urllib.parse.unquote(parts.username or ""),
            "POSTGRES_PASSWORD": urllib.parse.unquote(parts.password or ""),
            "POSTGRES_HOST": parts.hostname or "127.0.0.1",
            "POSTGRES_PORT": str(parts.port or 5432),
            "POSTGRES_DB": "postgres",
        }

    def wait_contracts(self, hosts: int, timeout: float = 180) -> int:
        dsn = self.cluster["indexd_dsn"]
        deadline = time.time() + timeout
        last = 0
        while time.time() < deadline:
            conn = psycopg2.connect(dsn)
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT count(DISTINCT c.host_id) FROM contracts c "
                        "WHERE c.good AND c.state IN (0,1) AND c.renewed_to IS NULL "
                        "AND c.proof_height > (SELECT scanned_height FROM global_settings)"
                    )
                    last = int(cur.fetchone()[0])
            finally:
                conn.close()
            if last >= hosts:
                return last
            time.sleep(0.3)
        return last

    def funding_diag(self, app_id_hex: str) -> dict:
        conn = psycopg2.connect(self.cluster["indexd_dsn"])
        appid = psycopg2.Binary(bytes.fromhex(app_id_hex))
        try:
            with conn.cursor() as cur:
                def one(sql, params=()):
                    cur.execute(sql, params)
                    return int(cur.fetchone()[0])
                return {
                    "accounts": one("SELECT count(*) FROM accounts"),
                    "accounts_with_app_id": one("SELECT count(*) FROM accounts WHERE app_id IS NOT NULL"),
                    "accounts_mine": one("SELECT count(*) FROM accounts WHERE app_id = %s", (appid,)),
                    "attachments_total": one("SELECT count(*) FROM pool_attachments"),
                    "attachments_mine": one(
                        "SELECT count(*) FROM pool_attachments pa JOIN accounts a "
                        "ON a.id = pa.account_id WHERE a.app_id = %s",
                        (appid,),
                    ),
                }
        finally:
            conn.close()

    def wait_funded(self, app_id_hex: str, hosts: int, timeout: float = 90) -> int:
        dsn = self.cluster["indexd_dsn"]
        deadline = time.time() + timeout
        last = 0
        while time.time() < deadline:
            conn = psycopg2.connect(dsn)
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT count(*) FROM pool_attachments pa "
                        "JOIN accounts a ON a.id = pa.account_id "
                        "WHERE a.app_id = %s AND a.deleted_at IS NULL",
                        (psycopg2.Binary(bytes.fromhex(app_id_hex)),),
                    )
                    last = int(cur.fetchone()[0])
            finally:
                conn.close()
            if last >= hosts:
                return last
            time.sleep(0.3)
        self.say(f"funding diagnostic: {self.funding_diag(app_id_hex)}")
        return last

    # -- processes ------------------------------------------------------

    def start_cluster(self) -> None:
        ready = self.tmp / "cluster-ready.json"
        stop = self.tmp / "cluster-stop"
        env = {**os.environ, **self.pg_env(),
               "TESSERA_E2E_CLUSTER_READY": str(ready),
               "TESSERA_E2E_CLUSTER_STOP": str(stop),
               # The cluster advertises the front door's origin: the browser
               # (rewritten bundle) and the CLI both sign that host.
               "TESSERA_E2E_CLUSTER_ADVERTISE_URL": self.public_base}
        out = (self.tmp / "cluster.out").open("wb")
        self.captured.append(self.tmp / "cluster.out")
        self.cluster_proc = subprocess.Popen(
            ["go", "test", "./e2e/", "-run", "TestClusterHost", "-count=1", "-timeout", "0", "-v"],
            cwd=str(self.tessera_root), env=env, stdout=out, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        deadline = time.time() + 360
        while time.time() < deadline and not ready.is_file():
            if self.cluster_proc.poll() is not None:
                raise Fail("cluster host exited before ready")
            time.sleep(0.3)
        if not ready.is_file():
            raise Fail("cluster host did not become ready")
        self.cluster = json.loads(ready.read_text())
        self.cluster["stop_file"] = stop
        app = urllib.parse.urlsplit(self.cluster["app_url"])
        self.cluster["app_host"] = app.hostname
        self.cluster["app_port"] = app.port
        self.hosts = int(self.cluster.get("hosts", "15"))
        self.say(
            f"indexd cluster up: app={self.cluster['app_url']} "
            f"admin={self.cluster['admin_url']} "
            f"hosts={self.hosts} db={self.cluster['db_name']}"
        )

    def stop_cluster(self) -> None:
        if not self.cluster_proc:
            return
        try:
            self.cluster["stop_file"].write_text("")
        except Exception:  # noqa: BLE001
            pass
        try:
            self.cluster_proc.wait(timeout=60)
        except Exception:  # noqa: BLE001
            self.cluster_proc.kill()

    def start_moneyd(self) -> None:
        port = free_port()
        env = {k: v for k, v in os.environ.items()
               if not k.startswith("TESSERA_") and k != "ADMIN_PASSWORD"}
        env.update({
            "TESSERA_FLEET_DSN": self.fleet_dsn,
            "TESSERA_INDEXD_DSN": self.cluster["indexd_dsn"],
            "TESSERA_INDEXD_ADMIN_URL": self.cluster["admin_url"],
            "ADMIN_PASSWORD": self.cluster["admin_password"],
            "TESSERA_SESSION_SECRET": self.session_secret,
            "TESSERA_AGENT_KEY_PEPPER": self.agent_pepper,
            "TESSERA_TICK_SECONDS": "3600",
            "TESSERA_DUNNING_ARMED": "false",
            "TESSERA_PUBLIC_BASE_URL": self.public_base,
            "TESSERA_ADMIN_PROXY_TOKEN": "",
            "TESSERA_ADMIN_GUARD_DISABLED": "1",
        })
        out = (self.tmp / "moneyd.out").open("wb")
        self.captured.append(self.tmp / "moneyd.out")
        self.moneyd_proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "moneyd.app:app",
             "--host", "127.0.0.1", "--port", str(port), "--log-level", "info",
             "--app-dir", str(self.tessera_root / "dataplane")],
            cwd=str(self.tessera_root / "dataplane"), env=env, stdout=out,
            stderr=subprocess.STDOUT, start_new_session=True,
        )
        deadline = time.time() + 40
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=2) as r:
                    if r.status == 200:
                        self.moneyd_port = port
                        self.front.moneyd_port = port
                        self.say(f"scratch moneyd up on 127.0.0.1:{port} (healthz ok)")
                        return
            except Exception:  # noqa: BLE001
                pass
            if self.moneyd_proc.poll() is not None:
                break
            time.sleep(0.25)
        raise Fail("scratch moneyd did not become healthy")

    def stop_moneyd(self) -> None:
        if not self.moneyd_proc:
            return
        try:
            os.killpg(os.getpgid(self.moneyd_proc.pid), signal.SIGTERM)
        except Exception:  # noqa: BLE001
            self.moneyd_proc.terminate()
        try:
            self.moneyd_proc.wait(timeout=15)
        except Exception:  # noqa: BLE001
            self.moneyd_proc.kill()

    # -- http -----------------------------------------------------------

    def api(self, method: str, path: str, body=None, cookie=None, origin=True):
        url = self.public_base + path
        data = None if body is None else json.dumps(body).encode()
        headers = {"Accept": "application/json", "Connection": "close"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if cookie:
            headers["Cookie"] = cookie
        if origin and method.upper() in ("POST", "PUT", "PATCH", "DELETE"):
            headers["Origin"] = self.public_base
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, r.read(), r.headers
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(), exc.headers

    # -- cli ------------------------------------------------------------

    def build_cli(self) -> Path:
        binary = self.tmp / "tessera"
        out = subprocess.run(
            ["go", "build", "-o", str(binary), "."], cwd=str(self.cli_root),
            capture_output=True, text=True,
        )
        if out.returncode != 0:
            raise Fail(f"cli build failed: {out.stderr[-400:]}")
        self.say("tessera-cli built from source")
        return binary

    def cli_env(self, home: Path, phrase: str) -> dict[str, str]:
        return {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(home / "home"),
            "TESSERA_HOME": str(home),
            "TESSERA_PHRASE": phrase,
        }

    def write_config(self, home: Path) -> None:
        home.mkdir(parents=True, exist_ok=True)
        (home / "config.json").write_text(json.dumps({
            "indexer_url": self.public_base,
            "billing_api_url": self.public_base + "/api/v1",
        }))

    def run_cli(self, binary: Path, home: Path, phrase: str, args: list[str]):
        env = self.cli_env(home, phrase)
        return subprocess.run(
            [str(binary), *args], env=env, capture_output=True, text=True, timeout=300,
        )

    # -- browser --------------------------------------------------------

    def run_browser(self, cookie: str, phrase: str, expect_file: str) -> dict:
        phrase_file = self.tmp / "phrase.txt"
        phrase_file.write_text(phrase + "\n")
        phrase_file.chmod(0o600)
        out_file = self.tmp / "browser-result.json"
        capture = (self.tmp / "browser.log").open("wb")
        self.captured.append(self.tmp / "browser.log")
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "PW_CORE": PW_CORE,
            "PW_CHROMIUM": PW_CHROMIUM,
            "FRONT_URL": self.public_base,
            "SESSION_COOKIE": cookie,
            "PHRASE_FILE": str(phrase_file),
            "EXPECT_FILE": expect_file,
            "OUT_FILE": str(out_file),
            "SHOTS_DIR": self.shots_dir,
        }
        proc = subprocess.run(
            ["node", str(BROWSER_DRIVER)], env=env, capture_output=True,
            text=True, timeout=300,
        )
        capture.write(proc.stdout.encode())
        capture.write(proc.stderr.encode())
        capture.close()
        phrase_file.unlink(missing_ok=True)
        if out_file.is_file():
            return json.loads(out_file.read_text())
        return {"ok": False, "error": proc.stderr[-500:] or "browser produced no result"}

    # -- teardown -------------------------------------------------------

    def cleanup(self) -> None:
        if self.cleaned:
            return
        self.cleaned = True
        for stop in (self.idx_proxy, self.front):
            if stop is not None:
                try:
                    stop.stop()
                except Exception:  # noqa: BLE001
                    pass
        self.stop_moneyd()
        self.stop_cluster()
        self.drop_fleet_db()
        if not self.keep:
            shutil.rmtree(self.tmp, ignore_errors=True)
        else:
            print(f"kept harness dir: {self.tmp}", flush=True)

    def scan_secrets(self, phrase: str) -> None:
        """Fail if the phrase leaked into any captured (non-phrase) file."""
        for path in self.captured:
            if path.name == "phrase.txt" or not path.is_file():
                continue
            try:
                text = path.read_text(errors="ignore")
            except Exception:  # noqa: BLE001
                continue
            if phrase and phrase in text:
                raise Fail(f"phrase leaked into {path.name}")
            for secret in self.secrets_scan:
                if secret and secret in text:
                    raise Fail(f"a credential leaked into {path.name}")


def generate_phrase(tmp: Path) -> str:
    helper = tmp / "phrase.mjs"
    helper.write_text(
        "import wasmInit, { generateRecoveryPhrase } from '"
        + str(REPO_ROOT / "packages/shared/vendor/sia-storage/wasm/sia_storage_wasm.js")
        + "'\n"
        "import { readFileSync } from 'node:fs'\n"
        "await wasmInit({ module_or_path: readFileSync('"
        + str(REPO_ROOT / "packages/shared/vendor/sia-storage/wasm/sia_storage_wasm_bg.wasm")
        + "') })\n"
        "process.stdout.write(generateRecoveryPhrase())\n"
    )
    out = subprocess.run(["node", str(helper)], capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise Fail("phrase generation failed: " + out.stderr[-300:])
    phrase = out.stdout.strip()
    words = phrase.split()
    if len(words) != 12:
        raise Fail(f"generated phrase has {len(words)} words, want 12")
    helper.unlink(missing_ok=True)
    return phrase


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tessera-root", type=Path, default=DEFAULT_TESSERA_ROOT)
    ap.add_argument("--cli-root", type=Path, default=DEFAULT_CLI_ROOT)
    ap.add_argument("--client", choices=("both", "cli", "web"), default="both")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument(
        "--screenshots",
        type=Path,
        default=None,
        help="capture PNGs of the browser screens into this directory (visual proof)",
    )
    return ap.parse_args()


def main() -> int:
    args = parse_args()
    h = Harness(args.tessera_root, args.cli_root, args.keep, args.client)
    phrase = generate_phrase(h.tmp)
    h.secrets_scan = [phrase]
    if args.screenshots:
        h.shots_dir = str(args.screenshots)

    def on_signal(signum, frame):
        h.cleanup()
        sys.exit(130)

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    try:
        phrase_file = h.tmp / "phrase.txt"
        phrase_file.write_text(phrase + "\n")
        phrase_file.chmod(0o600)

        h.create_fleet_db()
        tokens = h.seed_account()
        h.say(f"throwaway account seeded: {h.billing_id} (3 magic links)")

        dist = REPO_ROOT / "apps" / "web" / "dist"
        if not (dist / "index.html").is_file():
            raise Fail(f"{dist}/index.html missing; run npm run build:web")
        # Reserve the front origin first: the cluster advertises it, so both the
        # CLI and the browser sign exactly the host indexd's connect handshake
        # is pinned to.
        h.front = FrontDoor(dist)
        h.public_base = h.front.base_url
        h.advertise_url = h.public_base
        h.say(f"front door reserved on {h.public_base}")

        h.start_cluster()
        h.front.app_host = h.cluster["app_host"]
        h.front.app_port = h.cluster["app_port"]

        h.start_moneyd()
        h.front.start()
        h.say("front door up (app + /api/v1 -> moneyd + indexer -> cluster)")

        formed = h.wait_contracts(hosts=h.hosts, timeout=240)
        h.check(formed >= h.hosts, f"host contracts formed ({formed}/{h.hosts})")

        binary = h.build_cli()
        pc1 = h.tmp / "pc1"
        pc2 = h.tmp / "pc2"
        h.write_config(pc1)
        h.write_config(pc2)

        # ── PC1 (CLI): sign in, register with the phrase, upload ──────
        r = h.run_cli(binary, pc1, phrase, ["login", "--email", h.email, "--token", tokens[0]])
        h.check(
            r.returncode == 0,
            "PC1 CLI sign-in + first registration succeeds"
            + ("" if r.returncode == 0 else f" -- rc={r.returncode}: {(r.stderr or r.stdout).strip()[-400:]}"),
        )
        cfg1 = json.loads((pc1 / "config.json").read_text())
        h.check(bool(cfg1.get("app_id")) and bool(cfg1.get("app_key")),
                "PC1 stored an app id/key (identity created)")
        h.secrets_scan.append(cfg1["app_key"])
        h.check(phrase not in (r.stdout + r.stderr) and cfg1["app_key"] not in (r.stdout + r.stderr),
                "PC1 output contains no phrase/key")

        local_file = h.tmp / "proof.txt"
        local_file.write_text("tessera recovery e2e payload\n")
        attached = h.wait_funded(cfg1["app_id"], hosts=h.hosts, timeout=180)
        h.check(attached >= h.hosts, f"account pool attached on all hosts ({attached}/{h.hosts})")
        r = h.run_cli(binary, pc1, phrase, ["upload", str(local_file), "--as", "proof.txt"])
        h.check(
            r.returncode == 0,
            "PC1 uploaded proof.txt"
            + ("" if r.returncode == 0 else f" -- rc={r.returncode}: {(r.stderr or r.stdout).strip()[-400:]}"),
        )

        # ── PC2 (CLI): fresh home, phrase-only recovery ───────────────
        r = h.run_cli(binary, pc2, phrase, ["login", "--email", h.email, "--token", tokens[1]])
        h.check(
            r.returncode == 0,
            "PC2 CLI sign-in + phrase-only recovery succeeds"
            + ("" if r.returncode == 0 else f" -- rc={r.returncode}: {(r.stderr or r.stdout).strip()[-400:]}"),
        )
        cfg2 = json.loads((pc2 / "config.json").read_text())
        h.check(cfg2.get("app_id") == cfg1.get("app_id") and cfg2.get("app_key") == cfg1.get("app_key"),
                "PC2 recovered the SAME app id and key (same identity)")
        h.check(phrase not in (r.stdout + r.stderr) and cfg2["app_key"] not in (r.stdout + r.stderr),
                "PC2 output contains no phrase/key")
        r = h.run_cli(binary, pc2, phrase, ["list"])
        h.check(r.returncode == 0 and "proof.txt" in r.stdout,
                "PC2 lists the file uploaded by PC1")

        if h.client in ("both", "web"):
            # ── PC2 (web): cleared browser, seed-only recovery ────────
            status, body, headers = h.api("POST", "/api/v1/auth/verify", {"token": tokens[2]})
            set_cookie = ""
            for value in headers.get_all("Set-Cookie") or []:
                if value.startswith("tessera_session="):
                    set_cookie = value.split(";", 1)[0]
            # the browser needs the cookie VALUE only (its name is added there)
            cookie = set_cookie.split("=", 1)[1] if "=" in set_cookie else ""
            h.check(status == 200 and bool(cookie),
                    "throwaway session cookie obtained for the browser")
            if cookie:
                h.secrets_scan.append(cookie)
            result = h.run_browser(cookie, phrase, "proof.txt")
            h.check(
                not result.get("sawApprovalStep"),
                "browser recovery never showed the indexd approval step"
                + (
                    ""
                    if not result.get("sawApprovalStep")
                    else f" -- diag={result.get('diag')} logs={result.get('logs')}"
                ),
            )
            h.check(
                result.get("ok") and "proof.txt" in result.get("filesText", ""),
                "browser recovered with the seed only and lists the file"
                + ("" if result.get("ok") else f" -- {result.get('error', '')[:300]}"),
            )

        h.scan_secrets(phrase)
        h.check(True, "no phrase/key/cookie leaked into any capture")
        h.say("ALL CHECKS PASSED")
        return 0
    except Fail as exc:
        h.say(f"FAILED: {exc}")
        return 1
    finally:
        h.cleanup()


if __name__ == "__main__":
    sys.exit(main())
