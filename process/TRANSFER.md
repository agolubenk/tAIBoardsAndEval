# Перенос слоя в дом продукта — манифест (сверка 2026-11-01)

Продукт вырос в инкубаторе — внутри host-проекта, где команда ИИ-сессий работала с 26.10. Там он жил тремя
частями: подпроект экономного пайплайна (`supertick-eval/`), подпроект досок для агентов (`t-boards/`, код — форк
Kaneo в `t-boards/app`, локально) и функциональный слой (`.claude/`, `.continue/`, `.agents/`, `.ai/`, ИИ-сервисы в
`infra/`). Этот файл — сверка «что и куда переехало», чтобы читатель старых документов, капсул и handoff находил
файл по новому пути. Инкубатор при переносе не менялся.

## Соответствие путей

| Было (инкубатор) | Стало (здесь) | Как сверено |
|---|---|---|
| `supertick-eval/<path>` | `eval/<path>` | `diff -rq` — совпадает 1:1, кроме рантайма `nerve/state/`, `swarm/state/` (не переносится) |
| `t-boards/app/<path>` | `boards/<path>` | код форка; в инкубаторе не под git, сверка — по `boards/docs/impl-progress.md` |
| `t-boards/t-boards-spec.md`, `architecture-overview2.0.md` | `boards/docs/` (то же имя) | совпадают байт-в-байт |
| `t-boards/{impl-progress,impl-remaining,kimi-tasks}.md`, `impl/`, `migration/`, `kimi-reports/`, `archive/` | `boards/docs/…` | перенесены 2026-11-01 (до этого отсутствовали) |
| `t-boards/tools/` | `boards/tools/` | пробы стенда и `run-int.sh`: пути от места скрипта, `lockf`/`flock` |
| `t-boards/README.md` | `boards/docs/README.md` | карта переписана под новую раскладку |
| `SUCCESSOR-PROMPT*.md` (корень) | `process/prompts/` | совпадают |
| `CLAUDE.md`, `AGENTS.md`, `ACTION-PLAN.md` инстанса | `process/model/` | эталон настройки инстанса, совпадают |
| `.claude/`, `.continue/`, `.agents/`, `.windsurf/skills/` | те же пути | совпадают; правки дома — ниже |
| `infra/{ai-council,owner-queue-mcp,owner-queue-bot,ops-console,mcp-hub,llm-gateway,headroom}` | те же пути | перенесены 2026-11-01, только файлы под git |
| `infra/scripts/dev-ai/`, `dev/wt-deps.sh`, `misc/done-index.py`, `prod/ops-deploy-event.py` | те же пути | перенесены 2026-11-01 |
| `docs/specs/{owner-queue,ai-council}.md`, `docs/ai/*` (консилиум, Ollama, TOON), `docs/plans/notion-board.md`, `docs/ops/owner-queue-cutover.md` | те же пути | перенесены 2026-11-01 |
| записи закрытого о консилиуме, DAMS, MCP, ops-консоли и очереди владельца | `docs/plans/done/{dev-tooling,ops-control}.md` | 43 записи дословно; SHA — коммиты инкубатора |
| команды `npm run mcp-hub:* / llm-gateway:* / ai-council:* / ai-pipeline:* / done:index`, `make wt-*` | корневой `package.json`, `Makefile` | перенесены; `wt-*` — под pnpm досок |

Ссылки в документах (`eval/`, `boards/docs/`, `docs/`, `infra/`) переписаны на новые пути; относительные ссылки
пересчитаны от исходного места файла. Не переписывались: команды запуска инстанса (`cd ~/… && claude --settings
supertick-eval/…`), строки про инстанс, измерения в `eval/data/`, выдержка `eval/context/supertick-src/` и
эталон `process/model/`.

## Что исправлено при сверке (дефекты первого переноса)

| Дефект | Исправление |
|---|---|
| Нет документов реализации досок (`impl-*`, `migration/`, `kimi-*`, `archive/`, пробы) — ссылки спеки и handoff вели в пустоту | перенесены в `boards/docs/`, `boards/tools/`; архив и пробы исключены из `vp check` |
| Слой ссылался на сервисы, которых нет в репозитории: консилиум (линзы GLM для адверсариальной проверки), очередь владельца (`oq_*`), MCP-хаб, шлюз моделей роя, headroom | сервисы перенесены в `infra/`, тесты дают тот же результат, что в инкубаторе; CI — `infra-ci.yml` |
| Хук `PreToolUse` звал `infra/scripts/dev/wt-deps.sh`, которого не было, — гейт worktree молча выключен | скрипт перенесён и понимает pnpm-workspace `boards/`; хук ловит и `pnpm …`/`vp …` |
| Stop-хук typecheck видел только `apps/*`/`packages/*` — правки досок не проверял | добавлен pnpm-путь для `boards/apps/*`, `boards/packages/*`; тест `test_typecheck_gate.py` |
| `genome/build.py` жёстко держал `supertick-eval`, `roles.json` — абсолютные пути Mac; тест геномов падал вне инстанса | пути инстанса — `repo_root` и `product_tree` в `eval/nerve/config.json`; `build.py --check` воспроизводит геномы байт-в-байт; тесты геномов и рефлексов — в `eval-ci.yml` |
| Консилиум искал улики только в `apps/`/`packages/`, самопроверка падала на чужом дереве (Prisma, turbo-пакеты хоста) | корни `boards/`, `eval/`, `process/`; проверки хоста — на фикстуре или явный пропуск |
| В git лежали живые папки дел `.ai/task/` (выгрузки Notion, трассы) и сгенерированный `.continue/agents/llm-gateway.yaml` — в инкубаторе оба в `.gitignore` | убраны из git, закрыты `.gitignore` |
| `docs/` отсутствовал, а базовые правила слоя ссылаются на `docs/README.md`, `docs/CLAUDE.md`, `docs/plans/done/` | заведены карта, стандарт, оглавление закрытого и модули `boards`, `eval`, `dev-tooling`, `ops-control` |
| Нет `.windsurf/skills` — `sync-agent-skills.sh --check` не проходил | зеркало пересобрано |
| Скрипты ИИ-контура подключали `infra/scripts/dev/dev-common.sh` — `npm run ai-pipeline:*`, `ollama:*` падали на первой строке | `dev-common.sh` — только помощники Ollama и локального env; скрипты предметной области хоста (роли `hr-helper-*`, его dev-стек, Open WebUI) не переносятся; `bash -n` всех скриптов — в `infra-ci.yml` |
| Гейт ссылок документации (`docs_linkcheck.py`) не переносился и падал | `npm run docs:check` и шаг `infra-ci.yml`; ссылки законов хоста на его документы — в `.claude/scripts/docs_linkcheck.host-only.txt`, считаются отдельно |

## Что сознательно не перенесено

- **Рантайм:** `nerve/state/`, `swarm/state/`, `council.db`, `.ai/task/`, `.claude/memory/session/`,
  `.claude/skill-observations/`, `.serena/`, `graphify-out/`, `node_modules`, `.env`.
- **Продуктовое хоста:** бизнес-код, его CI и деплой, `docs/` предметной области, OpenExecutive (разбор идей
  публичного сайта хоста), продуктовые скрипты `infra/scripts/{prod,misc}` кроме названных выше.
- **Документы предметной области хоста:** его SLO и алерты прода (`docs/ops/p0-slo-alerts.md`), API, QA, архитектура —
  список префиксов в `.claude/scripts/docs_linkcheck.host-only.txt`.
- **Мусор корня инкубатора:** снимки процессов и памяти (`mem.txt`, `ps.txt`, …) и посторонние заметки.

## Что остаётся инстанс-зависимым (проверить при развёртывании над новым хостом)

- `.claude/rules/02–16` и скиллы `hr-domain`, `nestjs-service`, `react-feature`, `db-migration` — законы предметной
  области первого хоста; грузятся по его `paths:` и в доме слоя не срабатывают (кроме правила 10 на `infra/**`).
- `eval/nerve/config.json` (`repo_root`, `product_tree`, репозиторий, адрес очереди, роли) и сгенерированные из него
  геномы `eval/pipeline/genome/*.json`; `infra/ai-council/config.toml` (источники, модели).
- Адрес стенда досок и туннеля (`T_BOARDS_URL`), Keychain-сервис секретов `hr-helper-mcp`, ops-консоль с SSO
  через бэкенд хоста; её бизнес-метрики (`infra/ops-console/agent/hrh-business.sh`) и встроенные P0-правила
  (`server/alerts/builtin.ts`) описывают прод хоста.
- `eval/nerve/space.hrhelper.nerve.plist` — launchd-агент Нерва с путями машины владельца.
- Адрес VPS и раскладка WireGuard упоминаются в документах и сидах досок и ops-консоли (`boards/docs/impl/impl-b4-vps.md`,
  `boards/deploy/vps/seed/`, тесты ops-консоли) — так было и до переноса; если репозиторий публичный, вынести их в
  конфиг — решение владельца.

## История git

Первый перенос закоммитил живые папки дел `.ai/task/` (выгрузки Notion `ai-council-backlog/raw.json`, `cards.json`,
трассы ревью) и сгенерированный `.continue/agents/llm-gateway.yaml`. Сверка убрала их из дерева, но в истории
`board-agents` они остаются (секретов и почт в них не найдено). Переписывать историю или нет — решение владельца.
