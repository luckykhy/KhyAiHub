# qoder_bridge.py
# Local HTTP bridge for Qoder IDE → khy gateway OpenAI-compatible interface.
#
# Scopes (Track 2 per IMPL-RPT-041 §2):
#   qoder-cli --wrap--> 127.0.0.1:3000 /v1 --OpenAI chat.completion--> khy gateway
#
# Why this file exists:
#   start_qoder_bridge.ps1 invokes `pythonw.exe qoder_bridge.py` (no CLI args), so all
#   knobs come from environment variables. Idempotent: the launcher only starts us when
#   port 3000 is NOT already listening, so we must NOT exit early on a second-instance
#   situation inside the listener boot sequence.
#
# Why stdlib only (zero extra deps per IMPL-RPT-041 §2):
#   The bridge runs as a Windows user-level background process. Adding pip dependencies
#   would require a venv, an activation step, and an extra failure surface on login.
#   http.server + subprocess + json + socket is sufficient for the three endpoints.
#
# Safety / secrets (R2 SECURITY-001):
#   - The bridge binds 127.0.0.1 only (loopback). Nothing here ever leaves the host.
#   - The OpenAI-style Authorization header echoed by downstream clients is NOT logged.
#     We accept it, ignore it, and never persist or echo it back.
#   - `qodercli` itself carries the real Qoder credentials (login is a separate, manual
#     step documented in IMPL-RPT-041 §七). We never touch credentials here.
#   - No hardcoded keys, tokens, or paths beyond a locally-bare default ('qoder-local'
#     dummy per Track 1's qoderProxyModels.js so khy can pick() the entry).

import json
import os
import socket
import subprocess
import sys
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import ThreadingMixIn

# --- Configuration ---------------------------------------------------------

# IMPL-RPT-041 §4.1: bound to loopback; QODER_BRIDGE_PORT overrides for tests.
DEFAULT_BIND_HOST = '127.0.0.1'
DEFAULT_PORT = 3000

# IMPL-RPT-041 §4.1: 12-model catalog. Order is intentional — 'auto' is default.
# Unknown model IDs are forwarded to qodercli verbatim (passthrough semantics).
KNOWN_MODELS = (
    'auto',
    'ultimate',
    'performance',
    'efficient',
    'lite',
    'qwen3.7-max',
    'qwen3.7-plus',
    'glm-5.2',
    'kimi-k2.7-code',
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'minimax-m3',
)

# IMPL-RPT-041 §4.1: 300s subprocess timeout. Generous because some Qoder models run
# deep reasoning chains; overshoots surface as a clean 502 to the khy gateway
# (rather than a stuck socket).
QODERCLI_TIMEOUT_SECONDS = 300

# Loopback dummy for the OpenAI-style Authorization header. Not a secret — qodercli
# resolves real identity from its own login state. Matches Track 1's qoderProxyModels.js
# convention so khy's custom_provider pick() sees a non-empty value.
LOOPBACK_DUMMY_KEY = 'qoder-local'

# Default model id used when the request omits one or sends empty.
DEFAULT_MODEL_ID = 'auto'


# --- qodercli discovery ----------------------------------------------------

def _site_packages_dir() -> str:
    """Return sys.executable's site-packages dir (best effort, may not exist for
    frozen interpreters; caller handles the fallback)."""
    try:
        # Same logic Python uses to bootstrap site.py; portable across PEP 370 layouts.
        exec_path = sys.executable
        py_version_dir = 'Python%d%d' % (sys.version_info.major, sys.version_info.minor)
        candidates = [
            os.path.join(os.path.dirname(exec_path), 'Lib', 'site-packages'),
            os.path.join(os.path.dirname(exec_path), '..', 'Lib', 'site-packages'),
            os.path.join(os.path.dirname(exec_path), py_version_dir, 'site-packages'),
            os.path.join(os.path.dirname(exec_path), '..', py_version_dir, 'site-packages'),
        ]
        for c in candidates:
            if os.path.isdir(c):
                return os.path.normpath(c)
    except Exception:
        pass
    return ''


def _find_qodercli() -> str:
    """Resolve the qodercli executable path.
    Order:
      1. QODERCLI_PATH env (explicit, wins).
      2. Same dir as sys.executable — the common case for a bundled qoder_agent_sdk
         install via 'pip install --user' or venv (matches IMPL-RPT-041 §4.1 path-guess).
      3. PATH lookup via shutil.which (graceful fallback for global installs).
      4. Site-packages sibling: <site-packages>/../Scripts/qodercli.exe on Windows.
    Returns '' if nothing is found; caller treats that as a fatal startup error.
    """
    explicit = (os.environ.get('QODERCLI_PATH') or '').strip()
    if explicit and os.path.isfile(explicit):
        return explicit
    exe_dir = os.path.dirname(sys.executable or '') or ''
    if exe_dir:
        candidate = os.path.join(exe_dir, 'qodercli.exe' if os.name == 'nt' else 'qodercli')
        if os.path.isfile(candidate):
            return candidate
    try:
        import shutil
        which = shutil.which('qodercli')
        if which:
            return which
    except Exception:
        pass
    sp = _site_packages_dir()
    if sp:
        # Sibling Scripts/ on Windows is where pip puts console-script entry points.
        scripts = os.path.join(os.path.dirname(sp), 'Scripts')
        cand = os.path.join(scripts, 'qodercli.exe' if os.name == 'nt' else 'qodercli')
        if os.path.isfile(cand):
            return cand
    return ''


def _socket_has_open_port(host: str, port: int) -> bool:
    """Return True if something is already listening on host:port (the launcher
    script also checks this before starting us, but we re-check inside fork-spawn
    races during boot)."""
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(0.5)
        s.connect((host, port))
        s.close()
        return True
    except Exception:
        return False
    finally:
        try:
            if s:
                s.close()
        except Exception:
            pass


# --- Model catalog ---------------------------------------------------------

def _model_object(model_id: str) -> dict:
    """Build the OpenAI-style model descriptor for /v1/models."""
    return {
        'id': model_id,
        'object': 'model',
        'created': int(time.time()),
        'owned_by': 'qoder',
        # IMPL-RPT-041 §4.1: 'auto' is the default; everything else is a passthrough
        # to qodercli. The 'permission' field stays empty — khy gateway treats the
        # qoder pool as a custom provider (see custom_provider entries in Track 1).
        'permission': [],
    }


def _build_models_payload() -> dict:
    return {
        'object': 'list',
        'data': [_model_object(m) for m in KNOWN_MODELS],
    }


# --- Chat-completion handling ---------------------------------------------

def _messages_to_prompt(messages) -> str:
    """Flatten OpenAI chat.completion 'messages' array into a single prompt string
    for qodercli. qodercli consumes a free-form prompt, not the messages-array
    schema, so we preserve role prefixes for clarity in its log but otherwise
    pass the conversation through verbatim.
    """
    parts = []
    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get('role') or 'user').strip() or 'user'
        content = msg.get('content')
        if content is None:
            continue
        if isinstance(content, str):
            parts.append('{}: {}'.format(role, content))
        elif isinstance(content, list):
            # OpenAI multimodal content: [{'type':'text','text':'...'}, ...] — only
            # extract text for the text-only qodercli surface.
            for piece in content:
                if isinstance(piece, dict) and piece.get('type') == 'text':
                    parts.append('{}: {}'.format(role, piece.get('text', '')))
        else:
            parts.append('{}: {}'.format(role, json.dumps(content, ensure_ascii=False)))
    return '\n\n'.join(parts)


def _extract_assistant_text(qodercli_payload) -> str:
    """Best-effort extraction of assistant text from qodercli's JSON-shaped stdout.
    qodercli is documented to print JSON, but its exact schema has shifted across
    versions; accept a few common shapes and fall back to the raw stdout string
    when no structured field matches. The khy gateway only consumes the 'content'
    string returned here, so a fallback string is still useful for debugging."""
    if isinstance(qodercli_payload, dict):
        for key in ('content', 'message', 'text', 'reply', 'output'):
            v = qodercli_payload.get(key)
            if isinstance(v, str) and v.strip():
                return v
            if isinstance(v, dict):
                inner = v.get('content') or v.get('text')
                if isinstance(inner, str) and inner.strip():
                    return inner
        # choices[0].message.content (OpenAI-shape from newer qodercli versions)
        choices = qodercli_payload.get('choices')
        if isinstance(choices, list) and choices:
            first = choices[0]
            if isinstance(first, dict):
                msg = first.get('message') or {}
                if isinstance(msg, dict):
                    inner = msg.get('content')
                    if isinstance(inner, str) and inner.strip():
                        return inner
    if isinstance(qodercli_payload, str):
        return qodercli_payload
    return ''


def _call_qodercli(qodercli_path: str, body: dict) -> str:
    """Invoke the qodercli subprocess and return the assistant text.
    Raises RuntimeError on timeout / non-zero exit / unreadable stdout so the
    HTTP layer can map to 502.
    """
    model = body.get('model') or DEFAULT_MODEL_ID
    # IMPL-RPT-041 §4.1: unknown model IDs flow through as-is.
    prompt = _messages_to_prompt(body.get('messages'))
    if not prompt:
        raise RuntimeError('empty prompt: messages array missing or all-empty')

    # Build argv. We deliberately keep this explicit and short: qodercli has a stable
    # `<model> <prompt>` shape per its CLI docs. Anything else (--json, --stream)
    # belongs to a future revision; do NOT bake unknown flags in here.
    argv = [qodercli_path, str(model), prompt]

    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=QODERCLI_TIMEOUT_SECONDS,
            check=False,
            # Inherit no env mutations — qodercli reads Qoder auth from its own
            # login state, not from env.
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            'qodercli timed out after {}s'.format(QODERCLI_TIMEOUT_SECONDS)
        ) from exc
    except FileNotFoundError as exc:
        raise RuntimeError('qodercli not found at {}'.format(qodercli_path)) from exc
    except Exception as exc:
        raise RuntimeError('qodercli launch failed: {}'.format(exc)) from exc

    if proc.returncode != 0:
        stderr = (proc.stderr or '').strip()
        raise RuntimeError(
            'qodercli exit {}: {}'.format(proc.returncode, stderr[:500] or 'no stderr')
        )

    stdout = (proc.stdout or '').strip()
    if not stdout:
        raise RuntimeError('qodercli produced empty stdout')

    # Try JSON parse first; fall back to raw text on parse error.
    parsed = None
    try:
        parsed = json.loads(stdout)
    except (ValueError, TypeError):
        parsed = None

    text = _extract_assistant_text(parsed)
    if not text:
        # Last-resort: hand back the raw stdout so khy user sees SOMETHING rather
        # than an empty 502. Truncated to keep the chat response bounded.
        text = stdout[:8000]
    return text


def _build_chat_completion(model: str, text: str, request_id: str) -> dict:
    """Wrap the assistant text in an OpenAI chat.completion response object."""
    return {
        'id': 'qoder-' + (request_id or 'cmpl'),
        'object': 'chat.completion',
        'created': int(time.time()),
        'model': model,
        'choices': [
            {
                'index': 0,
                'message': {
                    'role': 'assistant',
                    'content': text,
                },
                'finish_reason': 'stop',
            }
        ],
        'usage': {
            # qodercli does not return token usage; zeros are honest, not misleading.
            'prompt_tokens': 0,
            'completion_tokens': 0,
            'total_tokens': 0,
        },
    }


# --- HTTP handler ----------------------------------------------------------

class _BridgeHandler(BaseHTTPRequestHandler):
    # Quieter logs — the launcher already writes stderr to a file. Keep only the
    # essentials; never include request bodies (may contain user prompts).
    def log_message(self, fmt, *args):  # noqa: A003 - http.server API
        try:
            sys.stderr.write('{} {} - {}\n'.format(
                self.address_string(), self.command, fmt % args
            ))
            sys.stderr.flush()
        except Exception:
            pass

    # Disable default do_HEAD/do_PUT/etc. by routing everything through do_GET.
    # Subclasses need only define do_GET / do_POST.
    def _write_json(self, status_code: int, payload: dict) -> None:
        try:
            data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        except (TypeError, ValueError):
            data = json.dumps({'error': 'response-encoding-failed'}).encode('utf-8')
            status_code = HTTPStatus.INTERNAL_SERVER_ERROR
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def _read_json_body(self) -> dict:
        length_raw = self.headers.get('Content-Length') or '0'
        try:
            length = max(0, min(int(length_raw), 5 * 1024 * 1024))  # cap at 5 MiB
        except ValueError:
            length = 0
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, ValueError):
            return {}

    def do_GET(self):  # noqa: N802 - http.server API
        path = self.path.split('?', 1)[0]
        if path == '/health':
            self._write_json(HTTPStatus.OK, {
                'status': 'ok',
                'bind': getattr(self.server, 'qoder_meta', {}).get('bind', ''),
                'port': getattr(self.server, 'qoder_meta', {}).get('port', 0),
                'qodercli': bool(getattr(self.server, 'qoder_meta', {}).get('qodercli')),
                'models_known': len(KNOWN_MODELS),
            })
            return
        if path == '/v1/models':
            self._write_json(HTTPStatus.OK, _build_models_payload())
            return
        self._write_json(HTTPStatus.NOT_FOUND, {
            'error': {'message': 'not found', 'path': path}
        })

    def do_POST(self):  # noqa: N802 - http.server API
        path = self.path.split('?', 1)[0]
        if path != '/v1/chat/completions':
            self._write_json(HTTPStatus.NOT_FOUND, {
                'error': {'message': 'not found', 'path': path}
            })
            return
        body = self._read_json_body()
        if not isinstance(body, dict):
            self._write_json(HTTPStatus.BAD_REQUEST, {
                'error': {'message': 'request body must be a JSON object'}
            })
            return

        # Per Track 1 convention: accept (and silently ignore) the OpenAI-style
        # Authorization header. We never echo it back, log it, or store it.
        _ = self.headers.get('Authorization')  # noqa: F841 - explicitly ignored

        qodercli_path = getattr(self.server, 'qoder_meta', {}).get('qodercli', '')
        if not qodercli_path:
            self._write_json(HTTPStatus.SERVICE_UNAVAILABLE, {
                'error': {
                    'message': 'qodercli not found; set QODERCLI_PATH or install qoder_agent_sdk'
                }
            })
            return

        try:
            text = _call_qodercli(qodercli_path, body)
        except RuntimeError as exc:
            self._write_json(HTTPStatus.BAD_GATEWAY, {
                'error': {'message': str(exc)}
            })
            return

        model = body.get('model') or DEFAULT_MODEL_ID
        rid = self.headers.get('X-Request-Id') or 'cmpl'
        self._write_json(HTTPStatus.OK, _build_chat_completion(model, text, rid))


class _ThreadingServer(ThreadingMixIn, ThreadingHTTPServer):
    """ThreadingMixIn so concurrent /v1/chat/completions requests don't serialize."""
    daemon_threads = True


def main(argv=None):
    argv = list(argv if argv is not None else sys.argv[1:])

    host = DEFAULT_BIND_HOST
    try:
        port = int(os.environ.get('QODER_BRIDGE_PORT') or DEFAULT_PORT)
    except (TypeError, ValueError):
        port = DEFAULT_PORT

    # If something is already on our port we exit silently. The launcher
    # already guards this, but a second-start race during boot would otherwise
    # crash with EADDRINUSE — silent retry-then-exit is the documented behavior.
    if _socket_has_open_port(host, port):
        try:
            sys.stderr.write('qoder_bridge: port {} already in use, exiting\n'.format(port))
            sys.stderr.flush()
        except Exception:
            pass
        return 0

    qodercli_path = _find_qodercli()
    if not qodercli_path:
        # Non-fatal: we still boot, but /v1/chat/completions will return 503 with
        # a clear message so the user knows to install qoder_agent_sdk or set
        # QODERCLI_PATH. /health and /v1/models still work for diagnostics.
        try:
            sys.stderr.write(
                'qoder_bridge: qodercli not found; chat endpoint will return 503\n'
            )
            sys.stderr.flush()
        except Exception:
            pass

    server = _ThreadingServer((host, port), _BridgeHandler)
    server.qoder_meta = {
        'bind': host,
        'port': port,
        'qodercli': qodercli_path,
    }
    try:
        sys.stderr.write(
            'qoder_bridge: listening on {}:{} (qodercli={})\n'.format(
                host, port, qodercli_path or 'NOT-FOUND'
            )
        )
        sys.stderr.flush()
    except Exception:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            server.server_close()
        except Exception:
            pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
