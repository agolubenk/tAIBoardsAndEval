"""Аудит контекста команды: куда уходят токены, кроме самих задач. Только чтение журналов, сессиям не пишет.

usage: python3 -I context_audit.py "<с YYYY-MM-DD HH:MM>" "<по YYYY-MM-DD HH:MM>" [--json out.json] [--match "<строка>"]

Время — местное (Минск). Журналы — сессии команды: первое сообщение содержит «ключ реестра» (или строку --match:
у пилота с геномом ключа реестра нет, его первое сообщение — «…ты — автор t-boards…»).
1. Деньги по статьям: вход, запись кэша (5 мин / 1 ч), чтение кэша, выход. Холодный вызов — запись кэша больше
   половины контекста (от 30K), то есть контекст переписан целиком. Причина: старт, сжатие, сон, прочее.
2. Что лежит в контексте: вставки хуков, вложения (CLAUDE.md, скиллы) и результаты инструментов. По каждому —
   токены и «хвост»: токены × число последующих вызовов до сжатия. Хвост — сколько раз это потом перечитано.
3. UserPromptSubmit по причине хода (человек, сообщение сессии, монитор) и по источнику (первый тег вставки).
4. CLAUDE.md и правила, подгруженные по пути (nested_memory): по файлу и сколько из них — тот же файл из другого
   worktree в том же контексте.
5. Инструменты по семействам и скиллы. 6. Первый вызов сессии — базовый контекст.
7. Наблюдатель claude-mem: его собственные сессии и их расход.

Токены вставок и результатов — оценка по символам (латиница ~3,5 символа на токен, кириллица ~2,2). Деньги — по
прайсу API; на подписке это мерило расхода лимита."""
import collections
import glob
import json
import os
import re
import sys
from datetime import datetime

HOME_CLAUDE = os.path.expanduser('~/.claude/')
ROOT = HOME_CLAUDE + 'projects/-Users-agolubenko-Desktop-Development-HR-Helper-v2'
OBSERVER_GLOB = HOME_CLAUDE + 'projects/*observer*/*.jsonl'
PRICES = {'fable': (10, 50, 0.25), 'opus-5-5': (4, 20, 0.2), 'opus-5': (5, 25, 0.5), 'sonnet': (2, 10, 0.2),
          'haiku-5-5': (0.1, 0.5, 0.01)}
COMPACTED = 'This session is being continued'

pos = [a for a in sys.argv[1:] if not a.startswith('--')]
out_json = sys.argv[sys.argv.index('--json') + 1] if '--json' in sys.argv else None
match = sys.argv[sys.argv.index('--match') + 1] if '--match' in sys.argv else 'ключ реестра'
for flag_value in (out_json, match):
    if flag_value in pos:
        pos.remove(flag_value)
since = datetime.strptime(pos[0], '%Y-%m-%d %H:%M')
until = datetime.strptime(pos[1], '%Y-%m-%d %H:%M')


def price(model):
    for k in PRICES:
        if k in (model or ''):
            return PRICES[k]
    return PRICES['opus-5-5']


# one estimate for the whole eval: the evolution toolkit prices artifacts with the same function
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'evolve'))
from tokens import est_tokens  # noqa: E402,F401


def text_of(content):
    if isinstance(content, str):
        return content
    out = []
    for x in content or []:
        if isinstance(x, dict) and isinstance(x.get('text') or x.get('content'), str):
            out.append(x.get('text') or x.get('content'))
    return ' '.join(out)


def local_time(ts):
    return datetime.fromisoformat(ts.replace('Z', '+00:00')).astimezone().replace(tzinfo=None)


def wake_kind(text):
    if 'cross-session-message' in text or '<agent-message' in text or text.startswith('Another Claude session sent'):
        return 'сообщение'
    if '<task-notification' in text:
        return 'монитор/фон'
    if COMPACTED in text:
        return 'сжатие'
    if '<scheduled-task' in text or 'cron' in text[:80].lower():
        return 'крон'
    return 'человек/прочее'


def tool_family(name):
    if name.startswith('mcp__'):
        parts = name.split('__')
        server = parts[1]
        if server == 'hub' and len(parts) > 2 and '_1mcp_' in parts[2]:
            server = 'hub:' + parts[2].split('_1mcp_')[0]
        return 'mcp:' + server
    return name


def norm_path(p):
    p = p or '?'
    if p.startswith(HOME_CLAUDE):
        return '~/.claude/' + p[len(HOME_CLAUDE):]
    # копия файла в worktrees/<вид>/<тема>/ — тот же файл репозитория
    m = re.search(r'/worktrees/[^/]+/[^/]+/(.+)$', p) or re.search(r'/HR_Helper-v2/(.+)$', p)
    if m:
        return m.group(1)
    m = re.search(r'/(apps|packages|infra|docs|\.claude|shared|scripts|e2e)/', p)
    return p[m.start() + 1:] if m else os.path.basename(p)


def first_tag(text):
    m = re.search(r'<([a-zA-Z][\w-]{2,40})[\s>]', text[:400])
    return m.group(1) if m else 'без тега'


def call_cost(u, model):
    pi, po, pr = price(model)
    cw = u.get('cache_creation_input_tokens', 0) or 0
    c1 = (u.get('cache_creation') or {}).get('ephemeral_1h_input_tokens', 0) or 0
    return {'вход': (u.get('input_tokens', 0) or 0) * pi / 1e6,
            'запись кэша 5 мин': (cw - c1) * 1.25 * pi / 1e6,
            'запись кэша 1 ч': c1 * 2 * pi / 1e6,
            'чтение кэша': (u.get('cache_read_input_tokens', 0) or 0) * pr / 1e6,
            'выход': (u.get('output_tokens', 0) or 0) * po / 1e6}


def first_prompt(path):
    for line in open(path, encoding='utf-8', errors='replace'):
        if '"type":"user"' not in line and '"type": "user"' not in line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get('type') != 'user':
            continue
        t = text_of((o.get('message') or {}).get('content'))
        if match in t or (t.strip() and not t.lstrip().startswith('<')):
            return t
    return ''


money = collections.Counter()
calls_total = 0
cold = collections.defaultdict(lambda: {'n': 0, 'usd': 0.0})
ctx_sum = 0
held = collections.defaultdict(lambda: {'n': 0, 'tok': 0, 'tail_tok': 0})   # что лежит в контексте
ups_by_wake = collections.defaultdict(lambda: {'n': 0, 'tok': 0})
hook_src = collections.defaultdict(lambda: {'n': 0, 'tok': 0})
nested = collections.defaultdict(lambda: {'n': 0, 'tok': 0, 'dup': 0})
instr = collections.Counter()
tools = collections.Counter()
skills = collections.Counter()
models = collections.Counter()
base = []
sessions = 0


def settle(pending, upto):
    for key, tok, at in pending:
        held[key]['tail_tok'] += tok * (upto - at)


for path in glob.glob(os.path.join(ROOT, '*.jsonl')):
    if datetime.fromtimestamp(os.path.getmtime(path)) < since:
        continue
    if match not in first_prompt(path)[:400]:
        continue
    sessions += 1
    pending, seg_calls, file_calls = [], 0, 0
    prev_call, after_compact = None, False
    last_wake = 'человек/прочее'
    seen_req = set()
    tu_family = {}
    nested_seg = collections.Counter()

    def hold(key, tok):
        held[key]['n'] += 1
        held[key]['tok'] += tok
        pending.append((key, tok, seg_calls))

    for line in open(path, encoding='utf-8', errors='replace'):
        try:
            o = json.loads(line)
        except Exception:
            continue
        ts = o.get('timestamp')
        if not ts:
            continue
        t = local_time(ts)
        in_window = since <= t <= until
        typ = o.get('type')
        m = o.get('message') if isinstance(o.get('message'), dict) else {}
        if typ == 'user':
            c = m.get('content')
            results = [x for x in c if isinstance(x, dict) and x.get('type') == 'tool_result'] if isinstance(c, list) else []
            if results:
                if in_window:
                    for x in results:
                        hold('результат:' + tu_family.get(x.get('tool_use_id'), '?'), est_tokens(text_of(x.get('content'))))
                continue
            txt = text_of(c).strip()
            if not txt:
                continue
            last_wake = wake_kind(txt)
            if COMPACTED in txt:
                settle(pending, seg_calls)
                pending, seg_calls, after_compact = [], 0, True
                nested_seg.clear()
            elif in_window:
                hold('сообщение:' + last_wake, est_tokens(txt))
        elif typ == 'attachment' and in_window:
            a = o.get('attachment') or {}
            at = a.get('type')
            if at == 'hook_additional_context':
                ev = (a.get('hookEvent') or a.get('hookName') or '?').split(':')[0]
                content = a.get('content') if isinstance(a.get('content'), str) else json.dumps(a.get('content'), ensure_ascii=False)
                tok = est_tokens(content)
                hold('хук:' + ev, tok)
                src = hook_src[(ev, first_tag(content))]
                src['n'] += 1
                src['tok'] += tok
                if ev == 'UserPromptSubmit':
                    ups_by_wake[last_wake]['n'] += 1
                    ups_by_wake[last_wake]['tok'] += tok
            elif at == 'nested_memory':
                np = norm_path(a.get('path'))
                tok = est_tokens(a.get('content') if isinstance(a.get('content'), str) else json.dumps(a.get('content'), ensure_ascii=False))
                hold('вложение:nested_memory', tok)
                nested[np]['n'] += 1
                nested[np]['tok'] += tok
                if nested_seg[np]:
                    nested[np]['dup'] += tok
                nested_seg[np] += 1
            elif at == 'instructions':
                total = 0
                for f in a.get('files') or []:
                    if isinstance(f, dict):
                        tok = est_tokens(f.get('content') or '')
                        instr[norm_path(f.get('path') or f.get('filePath'))] += tok
                        total += tok
                hold('вложение:instructions', total or est_tokens(json.dumps(a.get('files'), ensure_ascii=False)))
            elif at == 'skill_listing':
                content = a.get('content') if isinstance(a.get('content'), str) else json.dumps(a.get('content'), ensure_ascii=False)
                hold('вложение:skill_listing', est_tokens(content))
        elif typ == 'assistant' and m.get('usage'):
            # один ответ модели = несколько записей с общим requestId, по блоку в каждой:
            # tool_use собираем со всех записей, деньги и контекст — по первой
            for b in m.get('content') or []:
                if isinstance(b, dict) and b.get('type') == 'tool_use':
                    tu_family[b.get('id')] = tool_family(b.get('name') or '?')
                    if in_window:
                        tools[tool_family(b.get('name') or '?')] += 1
                        if b.get('name') == 'Skill':
                            skills[(b.get('input') or {}).get('skill', '?')] += 1
            rid = o.get('requestId') or m.get('id')
            if rid in seen_req:
                continue
            seen_req.add(rid)
            file_calls += 1
            seg_calls += 1
            gap = (t - prev_call).total_seconds() / 60 if prev_call else None
            prev_call = t
            was_compact, after_compact = after_compact, False
            if not in_window:
                continue
            u = m['usage']
            cc = call_cost(u, m.get('model'))
            for k, v in cc.items():
                money[k] += v
            calls_total += 1
            models[m.get('model') or '?'] += 1
            cw = u.get('cache_creation_input_tokens', 0) or 0
            ctx = cw + (u.get('cache_read_input_tokens', 0) or 0) + (u.get('input_tokens', 0) or 0)
            ctx_sum += ctx
            if ctx > 30000 and cw > 0.5 * ctx:
                why = ('старт' if file_calls == 1 else 'сжатие' if was_compact else
                       'сон > 60 мин' if gap and gap > 60 else 'сон 5–60 мин' if gap and gap > 5 else 'прочее')
                cold[why]['n'] += 1
                cold[why]['usd'] += cc['запись кэша 5 мин'] + cc['запись кэша 1 ч']
            if file_calls == 1:
                base.append(ctx)
    settle(pending, seg_calls)

obs_money, obs_models, obs_calls, obs_files = collections.Counter(), collections.Counter(), 0, 0
for path in glob.glob(OBSERVER_GLOB):
    if datetime.fromtimestamp(os.path.getmtime(path)) < since:
        continue
    hit, seen = False, set()
    for line in open(path, encoding='utf-8', errors='replace'):
        if '"usage"' not in line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        m = o.get('message') if isinstance(o.get('message'), dict) else {}
        if o.get('type') != 'assistant' or not m.get('usage') or not o.get('timestamp'):
            continue
        if not since <= local_time(o['timestamp']) <= until:
            continue
        rid = o.get('requestId') or m.get('id')
        if rid in seen:
            continue
        seen.add(rid)
        for k, v in call_cost(m['usage'], m.get('model')).items():
            obs_money[k] += v
        obs_models[m.get('model') or '?'] += 1
        obs_calls += 1
        hit = True
    obs_files += hit

total = sum(money.values())
pct = (lambda v: f'{v / total:5.1%}') if total else (lambda _v: '-')
print(f'Окно {since:%d.%m %H:%M} – {until:%d.%m %H:%M}: сессий {sessions}, вызовов {calls_total}, ${total:,.1f}, '
      f'средний контекст {ctx_sum // max(calls_total, 1):,}; модели: ' + ', '.join(f'{k} {v}' for k, v in models.most_common(4)))
print('1. Деньги: ' + ' · '.join(f'{k} ${v:,.1f} ({pct(v).strip()})' for k, v in money.most_common()))
print('   Холодные вызовы по причине: ' + ' · '.join(
    f'{k} {v["n"]} = ${v["usd"]:,.1f} ({pct(v["usd"]).strip()})' for k, v in sorted(cold.items(), key=lambda kv: -kv[1]['usd'])))
print('2. Что лежит в контексте: n · токены · хвост · $ хвоста по чтению кэша Opus')
held_tail = sum(v['tail_tok'] for v in held.values())
for k, v in sorted(held.items(), key=lambda kv: -kv[1]['tail_tok'])[:16]:
    print(f'   {k:<34} {v["n"]:>6} · {v["tok"]:>10,} · {v["tail_tok"]:>14,} · ${v["tail_tok"] * 0.2 / 1e6:>7,.1f}')
print(f'   итого хвост учтённого ${held_tail * 0.2 / 1e6:,.1f} из чтения кэша ${money["чтение кэша"]:,.1f}')
print('3. UserPromptSubmit по причине хода: ' + ' · '.join(f'{k} {v["n"]}/{v["tok"]:,}т' for k, v in sorted(ups_by_wake.items(), key=lambda kv: -kv[1]['tok'])))
print('   Источники вставок хуков (событие, первый тег): ' + ' · '.join(
    f'{e}/{tag} {v["n"]}/{v["tok"]:,}т' for (e, tag), v in sorted(hook_src.items(), key=lambda kv: -kv[1]['tok'])[:8]))
dup_tok = sum(v['dup'] for v in nested.values())
print(f'4. nested_memory по файлу (n · токены · из них повтор в том же контексте); повторы всего {dup_tok:,}т')
for k, v in sorted(nested.items(), key=lambda kv: -kv[1]['tok'])[:10]:
    print(f'   {k:<52} {v["n"]:>4} · {v["tok"]:>9,} · {v["dup"]:>9,}')
print('   instructions по файлу (токены за окно): ' + ' · '.join(f'{k} {v:,}' for k, v in instr.most_common(8)))
print('5. Инструменты: ' + ', '.join(f'{k} {v}' for k, v in tools.most_common(24)))
print('   скиллы: ' + (', '.join(f'{k} {v}' for k, v in skills.most_common()) or '—'))
if base:
    base.sort()
    print(f'6. Первый вызов сессии: мин {base[0]:,} · медиана {base[len(base) // 2]:,} · макс {base[-1]:,} (сессий {len(base)})')
obs_total = sum(obs_money.values())
print(f'7. Наблюдатель claude-mem: сессий {obs_files}, вызовов {obs_calls}, ${obs_total:,.1f} по прайсу; модели: '
      + (', '.join(f'{k} {v}' for k, v in obs_models.most_common(3)) or '—'))
if out_json:
    json.dump({'money': money, 'cold': cold, 'held': held, 'ups_by_wake': ups_by_wake,
               'hook_src': {f'{e}/{tag}': v for (e, tag), v in hook_src.items()}, 'nested': nested, 'instr': instr,
               'tools': tools, 'skills': skills, 'models': models, 'base': base, 'sessions': sessions,
               'calls': calls_total, 'ctx_avg': ctx_sum // max(calls_total, 1),
               'observer': {'files': obs_files, 'calls': obs_calls, 'money': obs_money, 'models': obs_models}},
              open(out_json, 'w'), ensure_ascii=False, indent=1)
