#!/usr/bin/env python3
"""The product's switches for the automated process, as tAI-Boards stores them (workspace settings →
«Pipeline & evolution»), for the layer's hooks and tools.

    python3 -I .claude/scripts/pipeline_settings.py                 # effective switches and where they came from
    python3 -I .claude/scripts/pipeline_settings.py fetch           # refresh the cache from the board now
    python3 -I .claude/scripts/pipeline_settings.py enabled swarm   # exit 0 — on, 1 — off (for shell scripts)

In code: `import pipeline_settings; pipeline_settings.enabled("successorAuto")`.

Where the switches come from:
1. the board — cached in `.claude/pipeline-settings.json` (gitignored, runtime), written by `fetch` and refreshed by
   itself at most every 10 minutes when the board's address (`boards.url` in `eval/nerve/config.json` or
   `T_BOARDS_URL`; https, or http only to localhost), the product (`boards.workspace` or `T_BOARDS_WORKSPACE`) and
   the key (`T_BOARDS_API_KEY`: env, else Keychain via `infra/scripts/dev-ai/mcp-secret.sh`) are known; the board
   answers `GET /api/pipeline-settings/workspace/{id}`. A cache of another workspace is ignored;
2. defaults — every switch on — when the board was never read;
3. on top of either, `TAIBE_PIPELINE` in the environment can only switch parts OFF — `off` (everything) or
   `swarm=off,abJudge=off` — never back on: a session cannot overrule the owner.
A failed read keeps the last known switches (an outage never re-enables what the owner switched off) and is not
retried for 10 minutes, so a board that is down costs one timeout per 10 minutes, not one per tool call. Only a
complete answer (automation and every switch, all booleans) is accepted; redirects are refused, so the key never
leaves for another host. Never raises into a hook. Stdlib only.

The keys are the board's (`boards/packages/permissions/src/pipeline-toggles.ts`); `test_pipeline_settings.py`
fails when the two lists differ.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
CACHE = '.claude/pipeline-settings.json'
TTL_SECONDS = 600
TIMEOUT_SECONDS = 1.5  # hooks run on every prompt: a slow board must not slow the session
TOGGLES = ('abJudge', 'askOnce', 'handoffDupes', 'promptBrief', 'successorAuto', 'grillHint', 'nerveWakes', 'swarm',
           'councilReview', 'cardAutofill')
OFF = ('off', '0', 'false', 'no')
# The key goes only to hosts the person trusts: an address written in the repository (config.json, a PR can change
# it) is used only for these hosts or for `T_BOARDS_ALLOWED_HOSTS` from the person's own environment; `T_BOARDS_URL`
# set in the environment is the person's choice and is trusted as is.
KNOWN_HOSTS = ('d4dev.admin.hrhelper.space', 'localhost', '127.0.0.1', '::1')


def defaults():
    return {'automation': True, 'toggles': {name: True for name in TOGGLES}}


def normalize(value):
    """Known keys only, booleans only; anything else takes its default (mirrors normalizePipelineSettings)."""
    out = defaults()
    if not isinstance(value, dict):
        return out
    if isinstance(value.get('automation'), bool):
        out['automation'] = value['automation']
    toggles = value.get('toggles') if isinstance(value.get('toggles'), dict) else {}
    for name in TOGGLES:
        if isinstance(toggles.get(name), bool):
            out['toggles'][name] = toggles[name]
    return out


def apply_env(settings, text):
    """TAIBE_PIPELINE switches parts off on top of the board's settings: 'off' or 'name=off,…'. Never on."""
    text = (text or '').strip()
    if not text:
        return settings
    out = {'automation': settings['automation'], 'toggles': dict(settings['toggles'])}
    if text.lower() in OFF:
        out['automation'] = False
        return out
    for part in text.split(','):
        name, _, value = part.partition('=')
        if name.strip() in TOGGLES and value.strip().lower() in OFF:
            out['toggles'][name.strip()] = False
    return out


def complete(value):
    """The board's answer, only when it is whole: a gateway's `{}` must not reset an «off» to defaults."""
    if not isinstance(value, dict) or not isinstance(value.get('automation'), bool):
        return None
    toggles = value.get('toggles')
    if not isinstance(toggles, dict) or not all(isinstance(toggles.get(n), bool) for n in TOGGLES):
        return None
    return normalize(value)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # the key header would follow a redirect to any host
        return None


def _board_url(url):
    parts = urllib.parse.urlsplit(url)
    local = parts.hostname in ('localhost', '127.0.0.1', '::1')
    if parts.scheme == 'https' or (parts.scheme == 'http' and local):
        return url.rstrip('/')
    return None


def _instance(root):
    """`boards` of the instance config (`eval/nerve/config.json`, or `supertick-eval/nerve/` over the host)."""
    for tree in ('eval', 'supertick-eval'):
        try:
            with open(os.path.join(root, tree, 'nerve', 'config.json'), encoding='utf-8') as f:
                return json.load(f).get('boards') or {}
        except (OSError, ValueError):
            continue
    return {}


def _workspace(root):
    return (os.environ.get('T_BOARDS_WORKSPACE', '').strip()
            or str(_instance(root).get('workspace') or '').strip())


def _key(root):
    """T_BOARDS_API_KEY from the environment, else the layer's secret chain (env → Keychain, mcp-secret.sh) — the
    same key the boards MCP uses. Called only when a fetch is due (≤ once per 10 minutes)."""
    key = os.environ.get('T_BOARDS_API_KEY', '').strip()
    script = os.path.join(root, 'infra', 'scripts', 'dev-ai', 'mcp-secret.sh')
    if key or not os.path.isfile(script):
        return key
    try:
        out = subprocess.run(['bash', script, 'T_BOARDS_API_KEY'], capture_output=True, text=True, timeout=3)
        return out.stdout.strip() if out.returncode == 0 else ''
    except (OSError, subprocess.TimeoutExpired):
        return ''


def _read_cache(root):
    try:
        with open(os.path.join(root, CACHE), encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        return {'broken': True}


def _write_cache(root, data):
    path = os.path.join(root, CACHE)
    tmp = path + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(data, f)
    os.replace(tmp, path)


def fetch(root=ROOT, timeout=TIMEOUT_SECONDS):
    """Read the board, write the cache. Returns (settings, error); a failure is remembered (`lastAttempt`, `lastError`)
    and keeps the last known settings."""
    env_url = os.environ.get('T_BOARDS_URL', '').strip()
    raw_url = env_url or str(_instance(root).get('url') or '').strip()
    url = _board_url(raw_url)
    if url and not env_url:
        allowed = set(KNOWN_HOSTS) | {h.strip().lower() for h in
                                      os.environ.get('T_BOARDS_ALLOWED_HOSTS', '').split(',') if h.strip()}
        host = (urllib.parse.urlsplit(url).hostname or '').lower()
        if host not in allowed:
            return None, ('not connected: boards.url host %r is not trusted — the key is sent only to known hosts; '
                          'set T_BOARDS_URL or T_BOARDS_ALLOWED_HOSTS in your own environment' % host)
    ws = _workspace(root)
    if not (raw_url and ws):
        return None, 'not connected: set boards.url and boards.workspace in eval/nerve/config.json (or T_BOARDS_URL, ' \
                     'T_BOARDS_WORKSPACE)'
    key = _key(root)
    if not key:
        return None, 'not connected: no T_BOARDS_API_KEY (env or Keychain, infra/scripts/dev-ai/mcp-secret.sh)'
    if url is None:
        return None, 'T_BOARDS_URL must be https (http only to localhost)'
    req = urllib.request.Request('%s/api/pipeline-settings/workspace/%s' % (url, urllib.parse.quote(ws, safe='')),
                                 headers={'x-api-key': key, 'accept': 'application/json'})
    opener = urllib.request.build_opener(_NoRedirect)
    error, settings = None, None
    try:
        with opener.open(req, timeout=timeout) as resp:  # noqa: S310 — the board's own URL, checked above
            settings = complete(json.loads(resp.read().decode('utf-8')))
            if settings is None:
                error = 'HTTP %s: incomplete settings in the answer' % resp.status
    except urllib.error.HTTPError as e:
        error = 'HTTP %s' % e.code
    except Exception as e:  # noqa: BLE001 — any failure keeps the last known switches
        error = '%s: %s' % (type(e).__name__, str(e)[:120])
    data = _read_cache(root)
    if data.get('broken') or data.get('workspace') not in (None, ws):
        data = {}
    data.update({'workspace': ws, 'lastAttempt': time.time()})
    if settings is not None:
        data.update({'fetchedAt': data['lastAttempt'], 'settings': settings, 'lastError': None})
    else:
        data['lastError'] = error
    try:
        _write_cache(root, data)
    except OSError as e:
        return settings, error or 'cache not written: %s' % e
    return settings, error


def _base(root, refresh):
    """(settings, source) from the board's cache or defaults, before the environment."""
    data = _read_cache(root)
    ws = _workspace(root)
    if data.get('broken') or (ws and data.get('workspace') not in (None, ws)):
        data = {}  # another product's switches are not this product's
    try:
        last = max(float(data.get('lastAttempt') or 0), float(data.get('fetchedAt') or 0))
    except (TypeError, ValueError):
        last = 0.0
    if refresh and time.time() - last > TTL_SECONDS:
        fresh, _ = fetch(root)
        if fresh is not None:
            return fresh, 'board (just fetched)'
        data = _read_cache(root)
    cached = complete(data.get('settings'))
    note = ', last read failed: %s' % data['lastError'] if data.get('lastError') else ''
    if cached is not None:
        age = time.time() - float(data.get('fetchedAt') or 0)
        return cached, 'cache %s (%d s old%s)' % (CACHE, age, note)
    return defaults(), 'defaults (no board settings known%s)' % note


def load(root=ROOT, refresh=True):
    """(settings, source) — the board's switches (or defaults), with the environment's «off» on top."""
    settings, source = _base(root, refresh)
    env = os.environ.get('TAIBE_PIPELINE', '').strip()
    if env:
        return apply_env(settings, env), source + ' + env TAIBE_PIPELINE (off only)'
    return settings, source


def enabled(name, root=ROOT, refresh=True):
    """Is this automated part on? Unknown names are on (a new tool is not silently disabled)."""
    try:
        settings, _ = load(root, refresh)
    except Exception:  # noqa: BLE001 — a hook must never fail on settings
        return True
    if name not in TOGGLES:
        return True
    return settings['automation'] and settings['toggles'][name]


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ['fetch']:
        settings, error = fetch(timeout=10)
        print('fetched' if settings and not error else 'not fetched: %s' % error)
        return 0 if settings else 1
    if argv[:1] == ['enabled'] and len(argv) == 2:
        return 0 if enabled(argv[1]) else 1
    settings, source = load()
    if source.startswith('defaults'):
        _, why = fetch(timeout=10)
        source += ' — %s' % why if why else ''
    print('pipeline settings — %s; automation %s' % (source, 'on' if settings['automation'] else 'OFF'))
    for name in TOGGLES:
        on = settings['automation'] and settings['toggles'][name]
        print('  %-14s %s' % (name, 'on' if on else 'off'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
