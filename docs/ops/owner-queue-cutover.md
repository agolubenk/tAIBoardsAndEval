# Переключение очереди владельца из артефакта claude.ai в ops-консоль

> **Статус (2026-10-19):** ✅ переключение завершено. Шаги 1–6 выполнены: очередь на проде с 18.10 (PR #213–#217),
> токены выпущены, история перенесена (138/107/38, дельта 19.10 — только `d-oq-spec`, перенесён), бот на сервере, агенты
> на MCP `oq_*`, артефакт заморожен 19.10 (версия 13 — страница «Очередь переехала»). Документ остаётся как справка
> на случай повторного развёртывания. Спека — [`../specs/owner-queue.md`](../specs/owner-queue.md).

Для владельца и агентов: как перенести очередь в ops-консоль. Мёржи и ssh на прод делает владелец (у агентов их нет).
Выгрузку истории и заморозку артефакта делает сессия Claude под **тем аккаунтом, которому принадлежит артефакт**:
другим аккаунтам его база недоступна.

## 1. Влить PR с очередью — деплой прода (выполнено: #214, 18.10)

Мёрж запускает деплой: консоль пересобирается, миграция `0008_owner_queue` добавляет три новые таблицы, существующие
таблицы не меняются. Около 3 минут сайт отвечает 502. **Без `[skip ci]`** — иначе консоль не обновится.

```bash
gh run list --workflow deploy-contabo.yml --limit 1   # предыдущий деплой завершён?
gh pr merge 214 --merge
```

Проверка после деплоя: `https://ops.admin.hrhelper.space/queue` открывается после входа в консоль (страница очереди,
пока без пунктов из базы).

## 2. Токены (на сервере)

```bash
ssh root@173.212.238.170
C=/opt/hr-helper/infra/scripts/prod/contabo-compose.sh
$C exec -T ops-console node server-dist/oq-cli.mjs token-create queue-bot owner    # токен бота очереди
$C exec -T ops-console node server-dist/oq-cli.mjs token-create agents agent,read  # токен агентов (MCP)
```

Каждый токен показывается один раз — сохраните оба.

Токен GitHub для мёржей:
1. Выпустите его на GitHub → Settings → Developer settings → Fine-grained tokens.
2. Права: только репозиторий `agolubenk/HR_Helper-v2`; Contents, Pull requests и Actions — Read and write.
3. Сохраните его на сервере:

```bash
printf '%s' 'github_pat_…' | $C exec -T ops-console node server-dist/oq-cli.mjs merge-token
```

## 3. История (сессия под аккаунтом артефакта)

Агент под аккаунтом-владельцем артефакта делает свежую выгрузку: Artifact `read_db` `list` коллекций `checks`, `items`,
`work`, `limit` 1000, `out_dir` `~/.hr-owner-queue-bot/export/<дата>`. Выгрузка 18.10 лежит в
`~/.hr-owner-queue-bot/export/2026-10-18`. Импорт не перезаписывает уже перенесённое, поэтому можно залить обе.

```bash
E=~/.hr-owner-queue-bot/export/<дата>
scp -r "$E" root@173.212.238.170:/tmp/oq-export
ssh root@173.212.238.170 'C=/opt/hr-helper/infra/scripts/prod/contabo-compose.sh; ID=$($C ps -q ops-console); docker cp /tmp/oq-export "$ID":/tmp/oq-export && $C exec -T ops-console node server-dist/oq-cli.mjs import /tmp/oq-export && rm -rf /tmp/oq-export'
```

Ожидаемый вывод: `checks/items/work: добавлено …, не прошло проверку 0`. Выгрузка 18.10 даёт 138, 106 и 38.

## 4. Бот очереди на сервер

```bash
bash infra/owner-queue-bot/deploy/install-launchd.sh --remove      # бот на Mac — стоп: токен опрашивает один процесс
node -e "const f=require('fs'),p=process.env.HOME+'/.hr-owner-queue-bot/config.json',c=JSON.parse(f.readFileSync(p));c.queueToken=process.argv[1];c.artifactUrl='https://ops.admin.hrhelper.space/queue';f.writeFileSync(p,JSON.stringify(c,null,2),{mode:0o600})" 'oq_…токен queue-bot…'
H=root@173.212.238.170
ssh $H 'mkdir -p /opt/owner-queue-bot/src /opt/owner-queue-bot/data && chmod 700 /opt/owner-queue-bot /opt/owner-queue-bot/data'
scp -r infra/owner-queue-bot/* $H:/opt/owner-queue-bot/src/
scp ~/.hr-owner-queue-bot/config.json ~/.hr-owner-queue-bot/state.json $H:/opt/owner-queue-bot/data/
ssh $H 'bash /opt/owner-queue-bot/src/deploy/run-server.sh'
```

Проверка: в логе — `песочница Chromium включена`, `бот @hrhelper_owner_queue_bot готов`, `режим страницы: shared`.
В Telegram `/menu` показывает «🟢 ответы сохраняются в общую базу».

## 5. Агенты переходят на новую очередь

1. Токен агентов — в Keychain Mac:
   ```bash
   security add-generic-password -U -s hr-helper-mcp -a OQ_TOKEN -w 'oq_…'
   ```
   Хаб подхватывает его через `npm run mcp-hub:sync`, Claude Code — при следующем старте сессии (сервер `owner-queue`
   уже есть в `.mcp.json`).
2. Протокол в памяти агентов (`feedback_closeout_owner_checklist.md`) переписывается на инструменты `oq_*`: пункты —
   `oq_put items`, свой статус — `oq_agent_status`, задачи — `oq_put/oq_patch work`.

## 6. Заморозить артефакт (сессия под аккаунтом артефакта)

Опубликовать на том же адресе страницу «Очередь переехала»: ссылка на `https://ops.admin.hrhelper.space/queue`,
дата переезда и указание, что `oq_*` — теперь единственный путь записи. Данные артефакта не удалять: они остаются
источником выгрузки.

## Откат

- **Страница или бот работают неверно:** агенты продолжают писать в артефакт по старому протоколу (шаги 5–6 не
  выполнены), бот останавливается командой `ssh … 'docker rm -f owner-queue-bot'`.
- **Сама консоль:** откат деплоя по `deploy-contabo.md`. Миграция только добавляет таблицы, старый код их не трогает.
