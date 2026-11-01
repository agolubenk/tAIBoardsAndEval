# Рычаги Claude Code для экономии контекста: справка по документации

статус: готово · источник — code.claude.com/docs (выборка субагента-справочника, 26.10.2026) · локально Claude Code 2.1.237

Часть ключей помечена версией (v2.1.242+, v2.1.288+, v2.1.296+, v2.1.304+). На локальной 2.1.237 они могут ещё
не работать. Перед включением проверить `claude --version` и обновиться.

## Что сейчас стоит у команды (замер 26.10, без секретов)

- `~/.claude/settings.json`:
  - `model: opus[1m]`;
  - `effortLevel: xhigh` — для `claude-opus-5-5` тоже `xhigh`; дефолт Opus 5.5 — `medium`;
  - `env.MCP_TIMEOUT=60000`.
- `.claude/settings.local.json` (с 26.10 09:42, начало Т3):
  - `autoCompactWindow: 250000` и `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW=250000`;
  - 12 плагинов выключены.
- Включено плагинов: 13.
  - Командой используются: `claude-mem`, `context-mode`, `playwright`.
  - Остальные дают в контекст только список скиллов, агентов и инструментов: `claude-security`,
    `clickhouse-best-practices`, `redis-development`, `frontend-design`, `claude-mem-cowork`, `code-review`,
    `security-guidance`, `chrome-devtools-mcp`, `pyright-lsp`, `typescript-lsp`.
- `ENABLE_TOOL_SEARCH=true`: MCP-инструменты отложены, но их имена всё равно лежат в базе.

## Ключи

| Цель | Ключ | Где | Примечание |
|---|---|---|---|
| Порог автосжатия | `autoCompactWindow` / `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (100K–1M) | settings / env | у Opus 5.5 без настройки сжатие ≈ 967K; у нас уже стоит 250K |
| Жёсткое окно 200K | `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` | env | держит модели с родным 1M на 200K |
| Сжатие во сне | `idleCompaction` (v2.1.290+), `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` (дефолт 200000) | settings / env | встроенная «консолидация во сне»; проверить, срабатывает ли |
| Усилие | `effortLevel`, `modelSettings.<model>.effortLevel`, `--effort`, `CLAUDE_CODE_EFFORT_LEVEL` | settings / флаг / env | env важнее флага; `maxEffortLevel` — потолок |
| Скиллы проекта и пользователя | `skillOverrides: {"<имя>": "off"\|"name-only"\|"user-invocable-only"}` | settings | на скиллы плагинов не действует |
| Скиллы плагинов | `enabledPlugins: {"<id>": false}` через `--settings` | флаг | `--settings` перекрывает local, project и user на одну сессию |
| Встроенные скиллы | `disableBundledSkills` / `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` | settings / env | |
| Бюджет списка скиллов | `skillListingBudgetFraction`, `skillListingMaxDescChars` | settings | дефолты не документированы |
| Авто-память | `autoMemoryEnabled`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `autoMemoryDirectory` | settings / env | MEMORY.md грузится целиком до 200 строк или 25 КБ |
| Исключить CLAUDE.md и правила | `claudeMdExcludes: ["<glob по абсолютному пути>"]` | settings | работает и для `.claude/rules/*`; массивы складываются по слоям |
| Убрать инструмент из контекста | `permissions.deny: ["Artifact", "mcp__docker", …]` или `--disallowedTools` | settings / флаг | запрет по имени убирает инструмент из контекста; в середине сессии сбрасывает кэш |
| Только свои MCP | `--mcp-config <файл> --strict-mcp-config` | флаг | |
| Длина описаний MCP | `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` (v2.1.280+) | env | режет и инструкции серверов |
| TTL кэша | `promptCacheTtl` / `CLAUDE_CODE_PROMPT_CACHE_TTL` = `5m`\|`1h` (v2.1.242+); субагенты — `subagentPromptCacheTtl` | settings / env | подписка: основной разговор 1 ч, субагенты 5 мин |
| Общий кэш для `-p` | `--exclude-dynamic-system-prompt-sections` | флаг | переносит динамику в первое сообщение, префикс переиспользуется; кэш общий в пределах машины и каталога |
| Голый запуск | `--bare` | флаг | пропускает хуки, скиллы, плагины, MCP, память и CLAUDE.md; **только `ANTHROPIC_API_KEY`, без OAuth** — на подписке не подходит |
| Лимиты headless | `--max-turns`, `--max-budget-usd`, `--fallback-model`, `--output-format json` (`total_cost_usd`, `usage`) | флаг | |
| Тонкий субагент | frontmatter: `model`, `effort`, `tools`, `disallowedTools`, `mcpServers`, `skills`, `omitClaudeMd` (v2.1.271+), `autoCompactWindow` (v2.1.296+), `memory`, `maxTurns`, `experimental.cacheTtl` | `.claude/agents/*.md` | у субагентов плагинов `hooks`, `mcpServers` и `permissionMode` игнорируются |

## Хуки

- **UserPromptSubmit.** Поля: `prompt`, `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`,
  внутри субагента ещё `agent_id`/`agent_type`. **Поля происхождения нет.** Хук срабатывает и на сообщение другой
  сессии, и на отчёт фонового субагента, и на плановую задачу. Отличать человека можно только по тексту — по тем же
  маркерам, что `wake_kind()` в `tools/context_audit.py`.
- **SessionStart.** Матчеры: `startup`, `resume`, `clear`, `compact`, `fork`.

## Не документировано

- Отключение инструкций MCP-серверов.
- Отключение списка имён отложенных инструментов. Есть только `ENABLE_TOOL_SEARCH=false`, а он грузит всё сразу.
- `disableSkills`.
- Поле `num_turns` в JSON.
