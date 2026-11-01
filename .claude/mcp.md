# MCP — настройка (проект: `.mcp.json`)

Конфиг живёт в `.mcp.json` (корень репо, ключ `mcpServers` — Claude Code читает только его,
не `servers`). Секреты в конфиг не хардкодятся и **не** передаются `${VAR}`-плейсхолдерами:
Claude, запущенный из VSCode/Dock, не видит export'ов из `~/.zshrc`, а credential-переменные в
`headers` удалённых серверов Claude Code читает пустыми (→ github 400 «Authorization header is
badly formatted»). Вместо этого — скрипты `infra/scripts/dev-ai/mcp-*.sh`, которые берут секрет
по цепочке **env → macOS Keychain** (service `hr-helper-mcp`, account = имя переменной):

```bash
security add-generic-password -U -s hr-helper-mcp -a <NAME> -w '<значение>'   # положить/обновить
security delete-generic-password -s hr-helper-mcp -a <NAME>                    # убрать
```

Проверка состояния: `claude mcp list`; переподключение в сессии — `/mcp`.
Какие серверы из `.mcp.json` включены — `enabledMcpjsonServers` в `.claude/settings.local.json`.

**Таймауты.** Старт stdio-серверов через `uvx` (первая установка пакета, serena с LSP на
монорепо) может занять 20–60 с — дефолтного лимита не хватает (`CONNECT_TIMEOUT`). Поэтому в
`~/.claude/settings.json` → `env.MCP_TIMEOUT = "60000"`. Если сервер всё равно падает по
таймауту на первом старте — прогреть кэш вручную (`uvx <пакет> --help`) и сделать `/mcp`.

## github — официальный remote-сервер GitHub

- Транспорт: HTTP, `https://api.githubcopilot.com/mcp/`
- Auth: `headersHelper` → `infra/scripts/dev-ai/mcp-auth-headers.sh GITHUB_PAT` печатает
  `{"Authorization":"Bearer …"}`. Токен: env `GITHUB_PAT` → Keychain → `gh auth token`
  (т.е. достаточно `gh auth login`, если отдельный PAT не нужен). Нет токена → helper отдаёт
  `{}` и сервер честно показывает 401 в `/mcp`
- OAuth в Claude Code для этого сервера ограничен, поэтому PAT, не встроенный OAuth-флоу
- Создать токен: GitHub → Settings → Developer settings → Personal access tokens
  (fine-grained, права по факту: Issues + Pull requests read/write на этот репозиторий)
- `security add-generic-password -U -s hr-helper-mcp -a GITHUB_PAT -w 'github_pat_...'`
- Старый `@modelcontextprotocol/server-github` (npm) — deprecated с апреля 2025, не использовать

## sentry — официальный remote-сервер Sentry

- Транспорт: HTTP, `https://mcp.sentry.dev/mcp`
- Auth: OAuth — при первом использовании откроется браузер для входа, токен не хранится
  в `.mcp.json`
- Если Sentry для проекта ещё не подключён — сервер просто не подключится, ничего не сломает

## postgres-readonly — schema-only доступ к dev-БД

- Пакет: `uvx postgres-mcp --access-mode=restricted` (актуальная поддерживаемая замена;
  оригинальный `@modelcontextprotocol/server-postgres` архивирован в мае 2025 из-за
  непропатченной SQL-инъекции, обходящей read-only режим — не использовать)
- `--access-mode=restricted` — защита на уровне MCP-сервера (блокирует write-инструменты)
- **Настоящая защита — на уровне БД**, не полагаться на флаг сервера/промпт-инструкции:
  роль `mcp_readonly` создаётся через `infra/scripts/db/mcp-readonly-role.sql`
  (`make`/`npm`-обёртки нет — разовая ручная операция, см. комментарий в файле)
- Роль по умолчанию имеет **только** `CONNECT` + `USAGE ON SCHEMA public`
  (структура видна через `pg_catalog` — `\dt`, `execute_sql` по `pg_class`/`pg_attribute`;
  `information_schema` и `list_objects`/`get_object_details` postgres-mcp пусты — они показывают
  только таблицы с привилегиями; данные таблиц — `permission denied`) — сознательный
  дефолт «без PII по умолчанию» (см. `CLAUDE.md §Критические правила`)
- Точечный допуск к данным конкретной **не-PII** таблицы (справочники, конфиг,
  миграционные таблицы — не `Candidate`/`Resume`/`TelegramSession` и т.п.):
  ```sql
  docker exec -i backend-postgres-1 psql -U hrhelper -d hrhelper -c \
    'GRANT SELECT ON "<table>" TO mcp_readonly;'
  ```
- Запуск — через обёртку `infra/scripts/dev-ai/mcp-postgres.sh` (URI → `DATABASE_URI`
  → `uvx postgres-mcp==0.3.0` с `mcp<2` и `--overrides postgres-mcp.overrides.txt`: его жёсткий пин `pglast==7.2.0`
  с PyPI удалён, без override uvx молча ставит чужой `postgres-mcp` 0.1.0 — «invalid dsn», 2026-10-20); URI кладётся в Keychain:
  `security add-generic-password -U -s hr-helper-mcp -a MCP_PG_READONLY_URI -w 'postgresql://mcp_readonly:<пароль-из-вывода-скрипта>@localhost:5432/hrhelper'`
  (или `export MCP_PG_READONLY_URI=...` в окружении, из которого запускается `claude`)
- Нет URI → обёртка сразу выходит с подсказкой в stderr (виден в `/mcp`), а не висит до таймаута
- Топология — один Postgres-инстанс на 5432 во всех окружениях (см.
  `.claude/rules/10-db-topology.md`); если когда-нибудь чтение вынесут на отдельный узел
  (`DATABASE_READ_URL`), роль создавать там, не на primary

## cloudflare — официальный remote-сервер Cloudflare API

- Транспорт: HTTP, `https://mcp.cloudflare.com/mcp` (Code Mode: весь Cloudflare API, ~2500
  эндпоинтов, через два инструмента `search()`/`execute()` — модель пишет JS против типизированной
  OpenAPI-схемы, код исполняется в изолированном Worker; ~1k токенов контекста вместо сотен тысяч)
- Auth: OAuth — `/mcp` → cloudflare → Authenticate; при логине выбрать минимальные scope'ы
  (аккаунт/зона проекта). Токен не хранится в `.mcp.json`. Для CI/автоматизации сервер
  принимает и Cloudflare API token как Bearer — тогда по схеме github (`headersHelper` +
  Keychain), не хардкодом
- Узкие продуктовые серверы (docs/observability/builds/bindings — `*.mcp.cloudflare.com/mcp`)
  не подключены: API-сервер их покрывает; добавлять только под конкретную нужду
- Мутирующие вызовы (DNS, Workers, R2) — только по явной просьбе, это внешний прод-ресурс

## docker — управление локальными контейнерами

- Пакет: `uvx mcp-server-docker` (stdio, говорит с активным docker-контекстом —
  Docker Desktop `desktop-linux`, сокет `~/.docker/run/docker.sock`)
- 19 инструментов: list/create/run/recreate/start/stop/remove контейнеров, логи, образы
  (pull/push/build/remove), сети, volumes
- **Без auto-allow — только чтение**: в `.claude/settings.local.json` разрешены
  `list_containers`, `fetch_container_logs`, `list_images`, `list_networks`, `list_volumes`.
  Всё остальное (особенно `remove_container`/`remove_volume` — потеря данных dev-БД)
  спрашивает подтверждение каждый раз — не добавлять в allow
- Для рестартов dev-стека канон — `infra/scripts/dev/*` и `docker compose -f
  infra/docker/docker-compose.yml ...`, MCP — для диагностики (статус, логи)

## notion — официальный remote-сервер Notion

- Транспорт: HTTP, `https://mcp.notion.com/mcp`
- С 2026-10-30 (R-084) — **архив только для чтения**: канон открытого бэклога/багов — t-boards
  (`.claude/rules/17-notion-board.md`). Сюда не писать; читать старые обсуждения по `notionPageId` карточки
- **Известный баг сжатия** (не проект, сам MCP-сервер): `notion-fetch`/`notion-get-comments`
  на страницах/комментариях длиннее ~250 байт отдают нечитаемые плейсхолдеры
  `<<ccr:hash,...>>` вместо текста. Обход — `infra/ai-council/notion.py`'s `NotionClient`
  (голый `urllib`-REST клиент, ключ — `.claude/council/.notion-key`):
  `client.page_text(page_id)` (полное тело страницы), `client.comments(page_id)` (полный тред
  комментариев), `client.call(f"/pages/{id}")["properties"]` (свойства страницы — так же
  обходит отдельный rate-limit `notion-query-data-sources` для баз Задачи/Ошибки). Только
  чтение, не альтернатива записи через MCP.

- **Ключ пропал** (переезд проекта, новый клон): ключи интеграций лежат в неотслеживаемых файлах
  (`.claude/council/.notion-key`, `.continue/.env`) и вместе с кодом не переезжают. Токен внутренней интеграции
  берётся в её настройках в Notion и записывается в эти файлы; затем — пробное чтение карточки. В чек-лист переезда
  проекта — перенос этих файлов наравне с кодом.

## ai-council — локальный stdio-сервер (`infra/ai-council/mcp_server.py`)

- Команда: `python3 infra/ai-council/mcp_server.py` (только stdlib + пакет `mcp`)
- Канон: `docs/specs/ai-council.md` §3, §10, §12 — единый MCP-фасад для Claude Code И Continue
  (у Continue нет хуков, поэтому явные MCP-инструменты — единственный способ дать ему то же,
  что Claude Code получает автоматически)
- Три группы инструментов: (1) Notion-card-scoped консилиум — чтение через `gateway.py` (:8790),
  запись/постановка в очередь только через `supervisor.py` CLI, не дублируется здесь;
  (2) жизненный цикл AI-пайплайна (start/stop/status/doctor) — обёртка над
  `infra/scripts/dev-ai/ai-tooling-pipeline.sh`, тот же канон-скрипт, что `npm run ai-pipeline:*`;
  (3) `task_brief` — явный вызов GLM RU→EN структуризации задачи, тот же
  `.claude/scripts/glm_client.py`, что и автоматический `UserPromptSubmit`-хук, но с ОТДЕЛЬНЫМ
  ключом/биллингом (`.claude/rag/.glm-key`, General API) — не расходует бюджет консилиума
  (Coding Plan, `.continue/.env` `ZAI_API_KEY`)

## Что НЕ подключено (сознательно)

- **OpenAPI/Swagger MCP** — контракты уже покрыты `npm run contract:api-v1` +
  `docs/api/*-openapi-spec.*`; отдельный MCP добавлять только если появится конкретная
  нужда (лишний сервер = лишний шум в контексте)
- **CLI вместо MCP где возможно** — `gh` (GitHub CLI) для разовых операций дешевле по
  контексту, чем MCP-инструменты; GitHub MCP выше — для тех задач, где агенту нужен
  многошаговый доступ к issues/PR в рамках одной сессии

## Общий MCP-хаб для других ИИ-клиентов (`infra/mcp-hub/`)

Copilot Chat, Continue, Roo, Kimi Code и Codex получают те же серверы через локальный хаб
`http://127.0.0.1:3050/mcp` (1mcp), а не каждый свою копию. Serena там одна на всех, включая
Claude Code: user-scope `serena` указывает на `http://127.0.0.1:9121/mcp`, а не на stdio, имена
`mcp__serena__*` те же. Поднимается задачей VS Code «MCP: старт и авторизация» при открытии
папки или `npm run mcp-hub:init` из основной папки репо (из worktree скрипт откажет); та же команда запускает `claude mcp login` для remote-серверов
этого файла, которые ждут OAuth. Если хаб не поднят, у Claude Code пропадает serena, а при записи `hub` (local scope,
`?tags=oauth,connector`) ещё и notion/sentry/cloudflare/context7 и подключённые коннекторы. Эта запись — по желанию, вместо отдельного входа
в каждый из них; подробности — README хаба. Устройство, подключение клиентов, OAuth и теги — в
[`infra/mcp-hub/README.md`](../infra/mcp-hub/README.md).

## Локальные предпочтения (не для команды)

URL/порты/dev-специфика — `.claude/CLAUDE.local.md` (не коммитится).
