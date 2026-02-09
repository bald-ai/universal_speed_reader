#!/usr/bin/env python3
"""
Local Piper TTS server for the speed reader prototype.

Runs on http://127.0.0.1:7332

Endpoints:
- GET  /health
- GET  /books/<bookId>/status
- POST /books/<bookId>/prepare
- GET  /books/<bookId>/audio.wav
- GET  /books/<bookId>/timings.json

Output:
  .tts_data/<bookId>/
    book.wav
    timings.json
    meta.json
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
import traceback
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


HOST = "127.0.0.1"
PORT = int(os.environ.get("TTS_PORT", "7332"))

SERVER_VERSION = "0.5"

BASE_DIR = Path(__file__).resolve().parent
VOICE_DIR = BASE_DIR / "voices"
VENV_DIR = BASE_DIR / ".venv"
VENV_PY = VENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python")

REPO_ROOT = BASE_DIR.parent.parent
DATA_DIR = REPO_ROOT / ".tts_data"

VOICE_ID = "en_US-lessac-high"  # single voice for now (female)
MODEL_PATH = VOICE_DIR / f"{VOICE_ID}.onnx"  # used by prepare_book.py outputs

DEFAULT_PAUSE_MS = 200


def _run(cmd: list[str], *, input_text: str | None = None) -> None:
    subprocess.run(
        cmd,
        input=input_text,
        text=True if input_text is not None else False,
        check=True,
    )


def ensure_venv() -> None:
    """Create a local venv and install deps there.

    Homebrew Python is PEP-668 "externally managed", so we must NOT pip-install
    into the system interpreter.
    """
    py = shutil.which("python3") or "python3"

    if not VENV_PY.exists():
        print(f"[tts-server] Creating venv at {VENV_DIR}")
        _run([py, "-m", "venv", str(VENV_DIR)])

    # Check if deps exist; install if missing.
    try:
        subprocess.run([str(VENV_PY), "-c", "import piper"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return
    except Exception:
        pass

    print("[tts-server] Installing deps into venv (piper-tts, onnx, onnxruntime)...")
    _run([str(VENV_PY), "-m", "pip", "install", "-q", "-U", "pip"])
    _run([str(VENV_PY), "-m", "pip", "install", "-q", "-U", "piper-tts", "onnx", "onnxruntime"])


def run_prepare_subprocess(
    *,
    book_id: str,
    paragraphs: list[dict[str, Any]],
    pause_ms_between_paragraphs: int,
) -> None:
    ensure_venv()

    out_dir = DATA_DIR / book_id
    out_dir.mkdir(parents=True, exist_ok=True)
    payload_path = out_dir / "payload.json"
    payload_path.write_bytes(
        _json_bytes(
            {
                "bookId": book_id,
                "voiceId": VOICE_ID,
                "pauseMsBetweenParagraphs": pause_ms_between_paragraphs,
                "paragraphs": paragraphs,
            }
        )
    )

    cmd = [
        str(VENV_PY),
        str(BASE_DIR / "prepare_book.py"),
        "--payload-json",
        str(payload_path),
        "--out-dir",
        str(out_dir),
        "--voice-dir",
        str(VOICE_DIR),
    ]

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    job = _get_job(book_id)
    if not job:
        job = JobState(state="preparing", done_paras=0, total_paras=len(paragraphs))
        _set_job(book_id, job)

    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            s = line.strip()
            if not s:
                continue
            if s.startswith("PROGRESS "):
                parts = s.split()
                if len(parts) >= 3:
                    try:
                        job.done_paras = int(parts[1])
                        job.total_paras = int(parts[2])
                        job.updated_at_ms = _now_ms()
                        _set_job(book_id, job)
                    except Exception:
                        pass
            if s.startswith("STAGE "):
                job.error = s  # stored as "stage" while preparing
                job.updated_at_ms = _now_ms()
                _set_job(book_id, job)
            print(f"[tts-server][{book_id}] {s}")

        code = proc.wait()
        if code != 0:
            raise RuntimeError(f"prepare_book.py exited with code {code}")
    finally:
        try:
            proc.kill()
        except Exception:
            pass


_PUNCT_RE = re.compile(r"^[\(\[\{\"']+|[\)\]\}\",;:\.\!\?\"']+$")


def clean_token_for_tts(token: str) -> str:
    # Keep token count stable, but reduce punctuation that can confuse alignment.
    t = token.strip()
    if not t:
        return token
    t2 = _PUNCT_RE.sub("", t)
    if not t2:
        return t
    return t2


def _json_bytes(data: Any) -> bytes:
    return json.dumps(data, ensure_ascii=False).encode("utf-8")


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class JobState:
    state: str  # missing | preparing | ready | error
    done_paras: int = 0
    total_paras: int = 0
    error: str | None = None
    started_at_ms: int | None = None
    updated_at_ms: int | None = None


_jobs_lock = threading.Lock()
_jobs: dict[str, JobState] = {}


def _get_job(book_id: str) -> JobState | None:
    with _jobs_lock:
        return _jobs.get(book_id)


def _set_job(book_id: str, job: JobState) -> None:
    with _jobs_lock:
        _jobs[book_id] = job


def _clear_job(book_id: str) -> None:
    with _jobs_lock:
        _jobs.pop(book_id, None)


def _infer_ready(book_id: str) -> bool:
    out_dir = DATA_DIR / book_id
    return (out_dir / "book.wav").exists() and (out_dir / "timings.json").exists()


def _status_payload(book_id: str) -> dict[str, Any]:
    if _infer_ready(book_id):
        return {"state": "ready"}

    job = _get_job(book_id)
    if not job:
        return {"state": "missing"}

    payload: dict[str, Any] = {"state": job.state}
    if job.state == "preparing":
        payload["progress"] = {"doneParas": job.done_paras, "totalParas": job.total_paras}
        if job.error and job.error.startswith("STAGE "):
            payload["stage"] = job.error
    if job.state == "error" and job.error:
        payload["error"] = job.error
    return payload


def _write_error(book_id: str, error: str) -> None:
    out_dir = DATA_DIR / book_id
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "error.json").write_bytes(_json_bytes({"error": error, "atMs": _now_ms()}))


def _prepare_book_worker(
    *,
    book_id: str,
    paragraphs: list[dict[str, Any]],
    pause_ms_between_paragraphs: int,
) -> None:
    # Mark preparing immediately (deps download/installation can take a while).
    job = _get_job(book_id)
    if not job or job.state != "preparing":
        job = JobState(
            state="preparing",
            done_paras=0,
            total_paras=len(paragraphs),
            started_at_ms=_now_ms(),
            updated_at_ms=_now_ms(),
        )
        _set_job(book_id, job)

    try:
        run_prepare_subprocess(
            book_id=book_id,
            paragraphs=paragraphs,
            pause_ms_between_paragraphs=pause_ms_between_paragraphs,
        )
        job.state = "ready"
        job.error = None
        job.updated_at_ms = _now_ms()
        _set_job(book_id, job)
    except Exception as e:
        err = f"{e}"
        tb = traceback.format_exc()
        print("[tts-server] ERROR preparing book:", err)
        print(tb)
        _write_error(book_id, err)
        job.state = "error"
        job.error = err
        job.updated_at_ms = _now_ms()
        _set_job(book_id, job)


class Handler(BaseHTTPRequestHandler):
    server_version = "piper-tts-server/" + SERVER_VERSION

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:
        try:
            path = self.path.split("?", 1)[0]
            if path == "/health":
                self._send(
                    200,
                    _json_bytes(
                        {
                            "ok": True,
                            "version": SERVER_VERSION,
                            "pid": os.getpid(),
                        }
                    ),
                    "application/json; charset=utf-8",
                )
                return

            m = re.match(r"^/books/([^/]+)/status$", path)
            if m:
                book_id = m.group(1)
                payload = _status_payload(book_id)
                payload["version"] = SERVER_VERSION
                payload["pid"] = os.getpid()
                self._send(200, _json_bytes(payload), "application/json; charset=utf-8")
                return

            m = re.match(r"^/books/([^/]+)/timings\.json$", path)
            if m:
                book_id = m.group(1)
                out_dir = DATA_DIR / book_id
                p = out_dir / "timings.json"
                if not p.exists():
                    self._send(404, _json_bytes({"error": "Not found"}), "application/json; charset=utf-8")
                    return
                self._send(200, p.read_bytes(), "application/json; charset=utf-8")
                return

            m = re.match(r"^/books/([^/]+)/audio\.wav$", path)
            if m:
                book_id = m.group(1)
                out_dir = DATA_DIR / book_id
                p = out_dir / "book.wav"
                if not p.exists():
                    self._send(404, _json_bytes({"error": "Not found"}), "application/json; charset=utf-8")
                    return
                data = p.read_bytes()
                self._send(200, data, "audio/wav")
                return

            self._send(404, _json_bytes({"error": "Not found"}), "application/json; charset=utf-8")
        except Exception as e:
            self._send(500, _json_bytes({"error": f"{e}"}), "application/json; charset=utf-8")

    def do_POST(self) -> None:
        try:
            path = self.path.split("?", 1)[0]
            m = re.match(r"^/books/([^/]+)/prepare$", path)
            if not m:
                self._send(404, _json_bytes({"error": "Not found"}), "application/json; charset=utf-8")
                return

            book_id = m.group(1)
            length = int(self.headers.get("content-length", "0"))
            raw = self.rfile.read(length) if length > 0 else b"{}"
            payload = json.loads(raw.decode("utf-8"))
            paragraphs = payload.get("paragraphs")
            if not isinstance(paragraphs, list):
                self._send(400, _json_bytes({"error": "paragraphs must be a list"}), "application/json; charset=utf-8")
                return

            print(f"[tts-server] prepare request book={book_id} paragraphs={len(paragraphs)}")

            pause_ms = payload.get("pauseMsBetweenParagraphs")
            if not isinstance(pause_ms, int):
                pause_ms = DEFAULT_PAUSE_MS
            pause_ms = max(0, min(2000, pause_ms))

            existing = _get_job(book_id)
            if existing and existing.state == "preparing":
                self._send(200, _json_bytes({"ok": True, "alreadyPreparing": True}), "application/json; charset=utf-8")
                return

            force = payload.get("force") is True
            if force:
                try:
                    shutil.rmtree(DATA_DIR / book_id, ignore_errors=True)
                except Exception:
                    pass
                _clear_job(book_id)
            else:
                # If already ready, do nothing.
                if _infer_ready(book_id):
                    self._send(200, _json_bytes({"ok": True, "alreadyReady": True}), "application/json; charset=utf-8")
                    return

            # Set preparing right away so UI can show progress immediately.
            _set_job(
                book_id,
                JobState(
                    state="preparing",
                    done_paras=0,
                    total_paras=len(paragraphs),
                    started_at_ms=_now_ms(),
                    updated_at_ms=_now_ms(),
                ),
            )

            t = threading.Thread(
                target=_prepare_book_worker,
                kwargs={
                    "book_id": book_id,
                    "paragraphs": paragraphs,
                    "pause_ms_between_paragraphs": pause_ms,
                },
                daemon=True,
            )
            t.start()

            self._send(
                200,
                _json_bytes(
                    {
                        "ok": True,
                        "state": "preparing",
                        "version": SERVER_VERSION,
                        "pid": os.getpid(),
                    }
                ),
                "application/json; charset=utf-8",
            )
        except Exception as e:
            self._send(500, _json_bytes({"error": f"{e}"}), "application/json; charset=utf-8")

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep logs quiet; uncomment to debug.
        # super().log_message(fmt, *args)
        return


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[tts-server] Listening on http://{HOST}:{PORT}")
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
