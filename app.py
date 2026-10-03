from __future__ import annotations

import json
import math
import mimetypes
import os
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
CACHE_DIR = ROOT / ".cache" / "tiles"
HOST = "127.0.0.1"
PREFERRED_PORT = int(os.environ.get("VIA_PORT", os.environ.get("ROUTE_STUDIO_PORT", "8787")))
USER_AGENT = os.environ.get(
    "NOMINATIM_USER_AGENT",
    "VIA/0.1 (local route editor and authorized mock-location test tool)",
)

_search_cache: dict[str, tuple[float, bytes]] = {}
_last_nominatim_request = 0.0

TILE_PROVIDERS = {
    "osm": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    "osmde": "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
    "osmfr": "https://a.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png",
}


def tile_bytes(provider: str, z: int, x: int, y: int) -> bytes:
    if provider not in TILE_PROVIDERS:
        raise ValueError("Unknown tile provider")
    if not (0 <= z <= 20):
        raise ValueError("Invalid zoom")
    limit = 1 << z
    if not (0 <= x < limit and 0 <= y < limit):
        raise ValueError("Invalid tile coordinates")

    cache_path = CACHE_DIR / provider / str(z) / str(x) / f"{y}.png"
    if cache_path.is_file():
        return cache_path.read_bytes()

    url = TILE_PROVIDERS[provider].format(z=z, x=x, y=y)
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(request, timeout=12) as response:
        payload = response.read()
    if not payload:
        raise RuntimeError("Empty tile response")

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = cache_path.with_suffix(f".{threading.get_ident()}.tmp")
    temp_path.write_bytes(payload)
    temp_path.replace(cache_path)
    return payload


def choose_port(start: int) -> int:
    for port in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((HOST, port))
            except OSError:
                continue
            return port
    raise RuntimeError("No free local port found")


def nominatim_search(query: str) -> bytes:
    global _last_nominatim_request

    query = query.strip()
    if not query:
        return b"[]"

    key = query.casefold()
    now = time.time()
    cached = _search_cache.get(key)
    if cached and now - cached[0] < 600:
        return cached[1]

    wait = 1.0 - (now - _last_nominatim_request)
    if wait > 0:
        time.sleep(wait)

    params = urllib.parse.urlencode(
        {
            "q": query,
            "format": "jsonv2",
            "limit": 7,
            "addressdetails": 1,
        }
    )
    url = f"https://nominatim.openstreetmap.org/search?{params}"
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
        },
    )

    with urllib.request.urlopen(request, timeout=12) as response:
        payload = response.read()

    _last_nominatim_request = time.time()
    _search_cache[key] = (_last_nominatim_request, payload)
    return payload


class AndroidBridge:
    """Small local ADB bridge for authorized Android test-provider playback.

    The bridge intentionally keeps Android's mock-location semantics visible. It does not
    attempt to hide mock flags or bypass third-party anti-cheat / integrity checks.
    """

    def __init__(self) -> None:
        self.serial: str | None = None
        self.providers: set[str] = set()
        self.original_mock_mode: str | None = None
        self.last_location: dict[str, float] | None = None
        self.lock = threading.RLock()

    def _adb_path(self) -> str:
        executable = os.environ.get("ADB_PATH") or shutil.which("adb")
        if not executable:
            raise RuntimeError("未找到 adb。请安装 Android SDK Platform-Tools，或设置 ADB_PATH。")
        return executable

    def _run(self, *args: str, timeout: float = 15.0) -> str:
        command = [self._adb_path(), *args]
        proc = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        stdout = proc.stdout.strip()
        stderr = proc.stderr.strip()
        text = "\n".join(part for part in (stdout, stderr) if part).strip()
        normal_location_help = (
            len(args) >= 4
            and args[-3:] == ("cmd", "location", "help")
            and proc.returncode in (0, 255)
            and "Location service commands:" in stdout
        )
        if proc.returncode != 0 and not normal_location_help:
            raise RuntimeError(text[:500] or "ADB command failed")
        lowered = text.lower()
        if any(token in lowered for token in ("error:", "exception", "failed", "cannot connect", "unknown command")):
            raise RuntimeError(text[:500] or "ADB command failed")
        return stdout or text

    def devices(self) -> list[dict[str, str]]:
        output = self._run("devices", "-l")
        result: list[dict[str, str]] = []
        for line in output.splitlines():
            line = line.strip()
            if not line or line.startswith("List of devices"):
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            serial, state = parts[0], parts[1]
            if state not in {"device", "offline", "unauthorized"}:
                continue
            model = ""
            for part in parts[2:]:
                if part.startswith("model:"):
                    model = part.removeprefix("model:")
                    break
            result.append({"serial": serial, "state": state, "model": model})
        return result

    def status(self) -> dict:
        with self.lock:
            return {
                "adb": bool(os.environ.get("ADB_PATH") or shutil.which("adb")),
                "connected": self.serial is not None,
                "serial": self.serial,
                "providers": sorted(self.providers),
                "lastLocation": self.last_location,
            }

    def connect(self, serial: str) -> dict:
        serial = str(serial or "").strip()
        if not serial:
            raise ValueError("请选择 Android 设备")

        with self.lock:
            if self.serial and self.serial != serial:
                self.disconnect()

            state = self._run("-s", serial, "get-state")
            if state.strip() != "device":
                raise RuntimeError("设备离线或尚未授权 ADB 调试")

            help_text = self._run("-s", serial, "shell", "cmd", "location", "help")
            if "set-test-provider-location" not in help_text:
                raise RuntimeError("当前 Android ROM 不支持 ADB test-provider 接口，建议 Android 12+")

            enabled = self._run("-s", serial, "shell", "cmd", "location","is-location-enabled")
          if enabled.strip().lower() != "true":
                raise RuntimeError("手机系统定位当前处于关闭状态")

            mode_text = self._run(
                "-s", serial, "shell", "appops", "get",
                "com.android.shell", "android:mock_location"
            )
            match = re.search(
                r"(?:MOCK_LOCATION|mock_location):\s*(allow|ignore|deny|default|foreground)",
                mode_text,
                re.IGNORECASE,
            )
            self.original_mock_mode = match.group(1).lower() if match else "default"
            self._run(
                "-s", serial, "shell", "appops", "set",
                "com.android.shell", "android:mock_location", "allow"
            )
            self.serial = serial
            self.providers.clear()
            self.last_location = None
            return self.status()

    def set_location(self, lat: float, lng: float, accuracy: float = 5.0) -> dict:
        if not all(math.isfinite(value) for value in (lat, lng, accuracy)):
            raise ValueError("坐标或精度不是有限数值")
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise ValueError("坐标超出有效范围")
        if not (0.1 <= accuracy <= 10000):
            raise ValueError("精度必须在 0.1–10000 米之间")

        with self.lock:
            if not self.serial:
                raise RuntimeError("尚未连接 Android 设备")
            serial = self.serial
            provider = "gps"
            if provider not in self.providers:
                self._run(
                    "-s", serial, "shell", "cmd", "location", "providers",
                    "add-test-provider", provider
                )
                self._run(
                    "-s", serial, "shell", "cmd", "location", "providers",
                    "set-test-provider-enabled", provider, "true"
                )
                self.providers.add(provider)

            self._run(
                "-s", serial, "shell", "cmd", "location", "providers",
                "set-test-provider-location", provider,
                "--location", f"{lat:.8f},{lng:.8f}",
                "--accuracy", f"{accuracy:.2f}",
            )
            self.last_location = {
                "lat": round(lat, 8),
                "lng": round(lng, 8),
                "accuracy": round(accuracy, 2),
                "time": time.time(),
            }
            return self.status()

    def clear(self) -> dict:
        with self.lock:
            if not self.serial:
                self.providers.clear()
                self.last_location = None
                return self.status()
            errors: list[str] = []
            for provider in list(self.providers):
                try:
                    self._run(
                        "-s", self.serial, "shell", "cmd", "location", "providers",
                        "remove-test-provider", provider
                    )
                 self.providers.discard(provider)
                except Exception as exc:  # cleanup should attempt all providers
                    errors.append(str(exc))
            self.last_location = None
            if errors:
                raise RuntimeError("清理模拟定位失败：" + "; ".join(errors))
            return self.status()

    def disconnect(self) -> dict:
        with self.lock:
            if not self.serial:
                return self.status()
            serial = self.serial
            cleanup_error: str | None = None
            try:
                self.clear()
            except Exception as exc:
                cleanup_error = str(exc)
            try:
                if self.original_mock_mode is not None:
                    self._run(
                        "-s", serial, "shell", "appops", "set",
                        "com.android.shell", "android:mock_location", self.original_mock_mode
                    )
            finally:
                self.serial = None
                self.providers.clear()
                self.original_mock_mode = None
                self.last_location = None
            if cleanup_error:
                raise RuntimeError(cleanup_error)
            return self.status()


ANDROID = AndroidBridge()


class Handler(BaseHTTPRequestHandler):
    server_version = "VIA/0.1"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def send_bytes(
        self,
        data: bytes,
        content_type: str,
        status: int = 200,
        cache_control: str = "no-store, max-age=0",
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache_control)
        if cache_control.startswith("no-store"):
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, data, status: int = 200) -> None:
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_bytes(payload, "application/json; charset=utf-8", status)

    def read_json(self) -> dict:
        length_text = self.headers.get("Content-Length", "0")
        try:
            length = int(length_text)
        except ValueError as exc:
            raise ValueError("Invalid Content-Length") from exc
        if length <= 0:
            return {}
        if length > 64 * 1024:
            raise ValueError("Request body too large")
        raw = self.rfile.read(length)
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("Expected JSON object")
        return data

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path.startswith("/api/tiles/"):
            parts = parsed.path.strip("/").split("/")
            if len(parts) != 6 or not parts[5].endswith(".png"):
                self.send_error(404)
                return
            try:
                _, _, provider, z_text, x_text, y_file = parts
                z = int(z_text)
                x = int(x_text)
                y = int(y_file[:-4])
                payload = tile_bytes(provider, z, x, y)
                self.send_bytes(
                    payload,
                    "image/png",
                    cache_control="public, max-age=604800, immutable",
                )
            except ValueError as exc:
                self.send_json({"error": str(exc)}, 400)
            except Exception as exc:
                self.send_json({"error": str(exc)}, 502)
            return

        if parsed.path == "/api/health":
            self.send_json({"ok": True, "name": "VIA", "version": "0.1", "android": ANDROID.status()})
            return

        if parsed.path == "/api/search":
            query = urllib.parse.parse_qs(parsed.query).get("q", [""])[0].strip()
            if not query:
                self.send_json([])
                return
            try:
                payload = nominatim_search(query)
                self.send_bytes(payload, "application/json; charset=utf-8")
            except Exception as exc:
                self.send_json({"error": str(exc)}, 502)
            return

        if parsed.path == "/api/android/devices":
            try:
                self.send_json({"devices": ANDROID.devices(), "status": ANDROID.status()})
            except Exception as exc:
                self.send_json({"error": str(exc), "devices": [], "status": ANDROID.status()}, 503)
            return

        if parsed.path == "/api/android/status":
            self.send_json(ANDROID.status())
            return

        if parsed.path in ("/", "/index.html"):
            file_path = STATIC_DIR / "index.html"
        elif parsed.path.startswith("/static/"):
            relative = parsed.path.removeprefix("/static/")
            file_path = (STATIC_DIR / relative).resolve()
            if STATIC_DIR.resolve() not in file_path.parents and file_path != STATIC_DIR.resolve():
                self.send_error(403)
                return
        else:
            self.send_error(404)
            return

        if not file_path.is_file():
            self.send_error(404)
            return

        content_type, _ = mimetypes.guess_type(file_path.name)
        if file_path.suffix == ".js":
            content_type = "text/javascript; charset=utf-8"
        elif file_path.suffix == ".css":
            content_type = "text/css; charset=utf-8"
        elif file_path.suffix == ".html":
            content_type = "text/html; charset=utf-8"
        else:
            content_type = content_type or "application/octet-stream"

        self.send_bytes(file_path.read_bytes(), content_type)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        try:
            payload = self.read_json()
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, 400)
            return

        try:
            if parsed.path == "/api/android/connect":
                self.send_json(ANDROID.connect(str(payload.get("serial", ""))))
                return

            if parsed.path == "/api/android/location":
                lat = float(payload.get("lat"))
                lng = float(payload.get("lng"))
                accuracy = float(payload.get("accuracy", 5.0))
                self.send_json(ANDROID.set_location(lat, lng, accuracy))
                return

            if parsed.path == "/api/android/clear":
                self.send_json(ANDROID.clear())
                return

            if parsed.path == "/api/android/disconnect":
                self.send_json(ANDROID.disconnect())
                return
        except (ValueError, TypeError) as exc:
            self.send_json({"error": str(exc)}, 400)
            return
        except subprocess.TimeoutExpired:
            self.send_json({"error": "ADB 命令超时"}, 504)
            return
        except Exception as exc:
            self.send_json({"error": str(exc)}, 502)
            return

        self.send_error(404)


def main() -> None:
    port = choose_port(PREFERRED_PORT)
    server = ThreadingHTTPServer((HOST, port), Handler)
    url = f"http://{HOST}:{port}"
    print("=" * 56)
    print("VIA 0.1 — route editor + Android mock-location bridge")
    print(f"Open: {url}")
    print("Local only: the control API listens on 127.0.0.1")
    print("Press Ctrl+C to stop.")
    print("=" * 56)

    if os.environ.get("VIA_NO_BROWSER", os.environ.get("ROUTE_STUDIO_NO_BROWSER", "0")) != "1":
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            ANDROID.disconnect()
        except Exception as exc:
            print(f"Android cleanup warning: {exc}")
        server.server_close()


if __name__ == "__main__":
    main()
