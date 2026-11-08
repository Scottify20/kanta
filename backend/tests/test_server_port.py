import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import run_server


class ServerPortTests(unittest.TestCase):
    def run_server_with(self, args, environment):
        with patch.object(sys, "argv", ["run_server.py", *args]), \
             patch.dict(os.environ, environment, clear=True), \
             patch.object(run_server, "_ensure_streams"), \
             patch.object(run_server, "_enable_file_logging"), \
             patch("uvicorn.run") as run:
            run_server.main()
        return run.call_args.kwargs["port"]

    def test_default_matches_frontend(self):
        config = Path(__file__).resolve().parents[2] / "frontend/src/app/app.config.ts"
        match = re.search(r"API_URL\s*=\s*['\"]http://127\.0\.0\.1:(\d+)['\"]", config.read_text())
        self.assertIsNotNone(match)
        self.assertEqual(self.run_server_with([], {}), int(match.group(1)))
        self.assertEqual(self.run_server_with([], {}), 8004)

    def test_port_overrides(self):
        self.assertEqual(self.run_server_with([], {"KANTA_PORT": "8123"}), 8123)
        self.assertEqual(self.run_server_with(["--port", "8124"], {"KANTA_PORT": "8123"}), 8124)

    def test_desktop_port_is_reserved_and_falls_back_when_occupied(self):
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            preferred = occupied.getsockname()[1]
            with run_server._bind_desktop_socket("127.0.0.1", preferred) as selected:
                port = selected.getsockname()[1]
                self.assertNotEqual(port, preferred)
                with socket.socket() as other:
                    with self.assertRaises(OSError):
                        other.bind(("127.0.0.1", port))

    def test_desktop_port_uses_preferred_when_free(self):
        with run_server._bind_desktop_socket("127.0.0.1", 0) as available:
            port = available.getsockname()[1]
        with run_server._bind_desktop_socket("127.0.0.1", port) as selected:
            self.assertEqual(selected.getsockname()[1], port)

    def test_desktop_server_serves_api_after_port_conflict(self):
        backend_dir = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as data, socket.socket() as occupied, \
             tempfile.TemporaryFile(mode="w+", encoding="utf-8") as output:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            preferred = occupied.getsockname()[1]
            env = dict(os.environ, KANTA_DATA_DIR=data, KANTA_HOST="127.0.0.1",
                       KANTA_PORT=str(preferred), KANTA_DESKTOP_PORT_DISCOVERY="1")
            process = subprocess.Popen(
                [sys.executable, "-u", "run_server.py"], cwd=backend_dir,
                env=env, stdout=output, stderr=subprocess.STDOUT,
            )
            try:
                deadline = time.monotonic() + 60
                port = None
                while time.monotonic() < deadline:
                    output.seek(0)
                    match = re.search(r"KANTA_BACKEND_PORT=(\d+)", output.read())
                    if match:
                        port = int(match.group(1))
                        break
                    if process.poll() is not None:
                        self.fail(f"Backend exited: {process.returncode}")
                    time.sleep(0.1)
                self.assertIsNotNone(port, "Backend did not announce its port")
                self.assertNotEqual(port, preferred)
                base = f"http://127.0.0.1:{port}"
                for path, expected in (("/health", dict), ("/api/settings", dict), ("/api/songs", list)):
                    while True:
                        try:
                            with urllib.request.urlopen(base + path, timeout=5) as response:
                                self.assertEqual(response.status, 200)
                                self.assertIsInstance(json.load(response), expected)
                            break
                        except urllib.error.URLError:
                            if time.monotonic() >= deadline or process.poll() is not None:
                                raise
                            time.sleep(0.1)
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
