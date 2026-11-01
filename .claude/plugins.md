# Plugins — куратор `claude-plugins-official`

Марketplace `claude-plugins-official` (официальный, `anthropics/claude-plugins-official`)
уже добавлен на уровне Claude Code (`claude plugin marketplace list`) — **не** через локальный
клон в `claude-plugins-official/` (тот использовался только для разовой инвентаризации 284
плагинов маркетплейса и в проект не коммитится, см. `.gitignore`). Обновление каталога:
`claude plugin marketplace update claude-plugins-official`.

Установленные ниже плагины — **project scope** (`enabledPlugins` в `.claude/settings.json`,
коммитится) — вся команда получает их автоматически при `git pull`, переустанавливать не нужно.
Проверка состояния: `claude plugin list`.

## Установлено (12) — с обоснованием под стек/домен проекта

| Плагин | Категория | Зачем именно в HR Helper v2 |
|---|---|---|
| `typescript-lsp` | code intelligence | Основной язык: `apps/backend`, `apps/frontend`, `apps/extension`, `packages/*` — весь npm workspace |
| `kotlin-lsp` | code intelligence | `apps/mobile` (Kotlin/Android) |
| `swift-lsp` | code intelligence | `apps/mobile-ios` (Swift, XcodeGen) |
| `pyright-lsp` | code intelligence | `.claude/scripts/*.py` (DAMS/RAG), `infra/scripts/**/*.py` |
| `redis-development` | database (skills, без внешнего аккаунта) | Redis используется как cache + BullMQ queues + rate-limit счётчики (`arch-db` чанк); паттерны data structures/vector search/perf сразу применимы |
| `clickhouse-best-practices` | database (skills, без аккаунта) | Аналитика/большие данные на ClickHouse (`clickhouse.service.ts`, primary+read-replica в FULL-топологии) |
| `playwright` (MS) | browser automation MCP | Совпадает с уже используемым `playwright` в `package.json`: E2E (`release-check` skill) **и** `linkedin-scraper.service.ts` (Sourcing v2 / SRC-ACQ — скрапинг, антидетект-браузинг); даёт живое управление браузером из чата для отладки UI/скрапинг-флоу |
| `context7` (Upstash) | docs lookup MCP | Актуальная документация библиотек (NestJS/Prisma/React/Connect RPC/BullMQ) вместо устаревших знаний модели — снижает риск галлюцинаций API |
| `agent-sdk-dev` | Claude Agent SDK toolkit | Проект активно строит собственных агентов на Agent SDK-паттернах (`AgentRegistry`/`AgentInvoker`/`BaseAgent`, `registerQueueAgent()`) — плагин помогает именно при разработке новых агентов, не дублирует `agent-engineer` (тот — доменный субагент HR Helper, этот — общий SDK-тулкит) |
| `mcp-server-dev` | MCP toolkit | Проект сам строит MCP-серверы/инструменты (canonical: MCP-раздел роутера в `CLAUDE.md`) — паттерны деплоя (remote HTTP/MCPB/local), auth, tool design |
| `skill-creator` | meta | В проекте уже 8 кастомных skills (`db-migration`, `hr-domain`, `incident-debug`, `nestjs-service`, `pr-review`, `react-feature`, `release-check`, `security-check`) — инструмент для их поддержки/аудита/новых skills по мере роста |
| `security-guidance` | security (hook-based) | Даёт то, чего сейчас нет: **автоматический** pattern-hook на каждый Edit + LLM diff-review на Stop (инъекции/XSS/SSRF/секреты). Дополняет, не дублирует `security-expert`/`security-check` (те — ручной/по запросу review) |

## Осознанно НЕ установлено

**Уже покрыто напрямую (не плодить второй источник того же MCP):**
- `github`, `serena` — уже подключены как MCP-серверы напрямую (`.mcp.json` → github; Serena — отдельный MCP, общий процесс по HTTP через хаб, см. `infra/mcp-hub/README.md`). Второй путь того же интеграционного canvas — риск дублирования tool-имён.

**Дублируют уже существующую bespoke-инфраструктуру проекта (осознанное решение — не плодить второй похожий инструмент; один владелец слоя сжатия/ревью, см. глобальный `~/.claude/CLAUDE.md` §«Экономия контекста»):**
- `code-review`, `pr-review-toolkit`, `feature-dev` — перекрывают `code-reviewer`/`backend-expert`/`frontend-expert`/`architecture-expert` субагентов
- `session-report`, `claude-md-management` — перекрывают DAMS (`.claude/memory/`, `.claude/README.md`) и claude-mem (`standup`/`timeline-report`/`weekly-digests`)
- `commit-commands` — git-workflow уже описан в CLAUDE.md/системных инструкциях
- `claude-security` (глубокий on-demand скан) — пересекается с `security-expert`; `security-guidance` выше даёт другой (hook-based) режим, второй похожий не добавляем
- `hookify` — второй фреймворк хуков поверх уже работающего Python hook-пайплайна (`.claude/hooks/*.py`) — риск конфликта порядка выполнения

**Не подходят кself-hosted топологии проекта:**
- `prisma` (официальный) — заточен под Prisma Postgres (managed cloud); проект держит собственный self-hosted PostgreSQL + PgBouncer + миграции через CI/CD (`arch-db` чанк) — provisioning-функциональность плагина нерелевантна
- `clickhouse` (официальный, Cloud) — заточен под ClickHouse Cloud; проект — self-hosted (LEAN одна нода / FULL кластер). Взяли только `clickhouse-best-practices` (skills, без облака)

**Требуют внешнего аккаунта/SaaS + потенциальный PII-риск — не устанавливать без отдельного решения владельца:**
- `notion`, `linear`, `asana` — не используются в проекте (проверено, реальных интеграций нет); внутренний wiki уже свой (`apps/backend/src/modules/wiki`, RAG hybrid search)
- `firecrawl`, `tavily` — сторонний scraping-as-a-service; проект уже строит **собственный** sourcing/антидетект-скрапинг (SRC-ACQ, `linkedin-scraper.service.ts` на Playwright) — внешний сервис означает отправку целей скрапинга (кандидаты/компании) третьей стороне, дублирует in-house решение
- `langfuse-observability`, `langfuse` — реальный гэп (LLM observability для множества агентов сейчас не покрыт), но требует нового внешнего сервиса и означает отправку LLM-трейсов (могут содержать резюме/PII кандидатов) наружу — кандидат в `docs/plans/BACKLOG.md` с явным решением владельца по self-hosted варианту, не тихая установка
- `sentry-cli` — Sentry уже подключён как remote MCP (`.mcp.json`); CLI-скилы (release/sourcemaps) — низкий приоритет, не блокер

**Нерелевантный стек/демо-плагины:** `terraform` (инфра — Docker Compose, не Terraform), `firebase`, `laravel-boost` (PHP), `gitlab` (репозиторий на GitHub), `imessage`/`discord`/`fakechat` (не наши каналы коммуникации), `ralph-loop`, `math-olympiad`, `playground`, `example-plugin`, `cwc-makers` — демо/нишевые, к продукту не относятся.

**Опционально, не установлено (личный dev-tool, не продуктовая интеграция):**
- `telegram` (`external_plugins/telegram`) — канал уведомлений *разработчику* Claude Code (не путать с in-app MTProto-интеграцией HR Helper, у неё отдельный canon — `arch:domain-telegram` чанк + `telegram-expert` агент). Подходит под требование «уведомления о фоновых процессах», но это персональная настройка конкретного разработчика — ставить через `--scope user`, не `project`, если понадобится.

## Обслуживание

```bash
# Обновить весь каталог маркетплейса
claude plugin marketplace update claude-plugins-official

# Обновить один плагин (перезапуск сессии для применения)
claude plugin update <name>@claude-plugins-official

# Проверить, что реально включено у всей команды
claude plugin list

# Установить/выключить точечно
claude plugin install <name>@claude-plugins-official --scope project
claude plugin disable <name>@claude-plugins-official
```

При пересмотре списка — обновлять этот файл (таблицы «Установлено» / «Осознанно не установлено»),
не заводить отдельный план в `docs/plans/BACKLOG.md` для рутинного добавления/удаления плагина
(только для `langfuse` — там нужно решение владельца по PII, см. выше).
