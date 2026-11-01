# Наследник: очередь владельца и трек «Ops и прод» (ops-консоль, бот, MCP) — с 20.10.2026

Ты принимаешь направление «очередь владельца» в HR Helper v2. Переезд из артефакта claude.ai в ops-консоль **завершён
19.10.2026**: новых задач по нему нет, только сопровождение и решения владельца ниже. Ничего не начинай без запроса.

## Что работает (проверено 18–19.10)

- **Очередь:** https://ops.admin.hrhelper.space/queue — страница бывшего артефакта, данные в ops-консоли (`oq_docs`:
  коллекции `checks` · `items` · `work`, журнал `oq_events`, токены `oq_tokens`). API — `/api/oq/v1`. Вход — владелец
  консоли (две учётки с ролью owner) или токен очереди.
- **Бот** @hrhelper_owner_queue_bot — контейнер `owner-queue-bot` на VPS `root@173.212.238.170`, код в
  `/opt/owner-queue-bot/src`, данные в `/opt/owner-queue-bot/data` (`config.json`: токен Telegram, `queueToken`, owner id
  7377211277). Работает через страницу `/queue` (headless Chromium с песочницей). Мёрж и деплой — через API консоли,
  токен GitHub для мёржей выставлен и проверен.
- **Агенты** пишут через MCP `owner-queue` (`oq_list`, `oq_get`, `oq_put`, `oq_patch`, `oq_agent_status`, `oq_history`).
  Он зарегистрирован на уровне пользователя (`~/.hr-owner-queue-bot/mcp/server.mjs`) и в `.mcp.json`; токен `OQ_TOKEN`
  лежит в Keychain. Сервер сам отдаёт 403 при записи ответа владельца и 409 при сдвиге `planEnd` без `basePlanEnd`.
- **Артефакт** https://claude.ai/artifact/2pnqnnaGXWmStS9y5cWydJ заморожен (версия 13, «Очередь переехала»), его база не
  тронута. **Туда не писать.** Выгрузки истории: `~/.hr-owner-queue-bot/export/2026-10-18` и `2026-10-19`.

## Где что

Код: `infra/ops-console/server/queue/*`, `infra/ops-console/server/routes/queue.ts`, `infra/owner-queue-bot/`,
`infra/owner-queue-mcp/`. Спека — `docs/specs/owner-queue.md`. Ранбук и справка по развёртыванию —
`docs/ops/owner-queue-cutover.md`. Протокол агентов — память `feedback_closeout_owner_checklist.md`, состояние — память
`project_owner_queue_bot.md`. PR: #213, #214 (деплой консоли), #215–#217, #220.

## План оставшихся шагов (на 20.10, 12:30 МСК)

План ведётся в «Ходе работ» самой очереди (`work/w-oq-*`, `w-p13-*`, направление «Ops-консоль и прод») и в списке
claude-mem `owner-queue-tails`. Меняя статус, обновляй оба. Мёржи — только после «МОЖНО ВЛИВАТЬ» от «Контроля» на
указанную голову; вливает владелец кнопкой или сессия 46.

| Задача | Статус | Кто и что дальше |
|---|---|---|
| `w-p13-slo` — алерты P0, [#226](https://github.com/agolubenk/HR_Helper-v2/pull/226) | ✅ на проде 20.10 12:29 (39399186099, prod-probe 14/14) | дальше у владельца s-p0-slo-agent (агент на хосте 1.2.1 → 1.3). После — biz_* на странице сервера, правило «Бизнес-метрики не считаются» |
| учёт OOM + алерт Redis очередей, [#235](https://github.com/agolubenk/HR_Helper-v2/pull/235) `eee2f281e` | «Контроль»: можно вливать | база уже main (20.10 переведена вручную: ветка #226 не удалена, GitHub сам не перевёл); дифф 23 файла, из них 3185 строк — снимок схемы drizzle. m-235 → s-ops-agent-14 (агент 1.4, учёт по журналу ядра, `oom.json` в /var/lib/hrh-ops). Проверка: пики памяти и swap на странице сервера |
| `w-p13-onlyoffice` — редактор [#234](https://github.com/agolubenk/HR_Helper-v2/pull/234) на проде 20.10 12:47Z; потолок 4g [#238](https://github.com/agolubenk/HR_Helper-v2/pull/238) на проде 10:31Z | 4g не помог (замер 20.10: установщик 2 ч 25 мин, 3,8 ГБ + 2,9 ГБ swap, убит 12:55:58Z; swap сервера кончился) | ждёт владельца: c-onlyoffice-save (правка → версия +1) и решение d-onlyoffice-plugins-2 (off / keep / asis). Для off готов [#249](https://github.com/agolubenk/HR_Helper-v2/pull/249) `ba6197909` (PLUGINS_ENABLED=false, потолок 2500m) — после «off» завести m-249, «Контроль» смотрит. keep = том под sdkjs-plugins, засеянный из нынешнего контейнера до деплоя; при обновлении образа DS пересеивать |
| Redis очередей, [#233](https://github.com/agolubenk/HR_Helper-v2/pull/233) | на проде 20.10 10:03Z (redisQueue up, воркеры на redis-queue) | ждёт владельца: s-redis-move блок 1 — ожидается найдено 17 (1 DLQ + 16 hh-sync, поставлены 10:00:01Z), перенесено 17, не перенесено 0; потом подтвердить блок 2 (очистка 412 ключей bull:* в кэше) |
| `w-oq-alias` — короткий адрес, [#232](https://github.com/agolubenk/HR_Helper-v2/pull/232) | на проде 20.10 12:17Z, адрес выключен до сертификата (fail-open работает) | ждёт владельца: c-queue-dns (записи пока нет) → s-queue-cert |
| `w-oqb-memory` — утечка бота, #225 влит без деплоя 20.10 | ждёт владельца | s-oqb-memory; через 3–4 ч сравнить память контейнера с 767 МБ, потом запись в DONE |
| `w-oq-hub` — `oq_*` в общем хабе | ✅ 20.10 | 6 инструментов owner-queue в хабе :3050 |
| `w-oq-glm` — ревью GLM #213, #214, #221 | после 21.10 06:28 UTC | из основной папки: `python3 infra/ai-council/glm_pr_review.py <PR> <out.json>`. Находки — в PR и в очередь |
| `w-oq-close13` — 13 влитых PR (#188, #201–#213) | ждёт владельца | «Влил» в каждом пункте. Агент поле ответа менять не может, сервер ответит 403 |
| Notion: 14 отложенных карточек | после `c-notion-oauth-2` (первый вход владельца не сохранил токены) | Notion в хабе отвечает «Error calling tool». Файл `~/.hr-owner-queue-bot/export/notion-pending-2026-10-20.json` (key/tool/arguments); 4 новые 20.10 — PRE-1 BullMQ «:» в jobId (medium), ttl:60 = 60 мс (medium), ключ колбэка OnlyOffice, часовой Huntflow и DLQ |
| полоса ops с 27.10 (w-n-stt, w-n-ops-bugs, w-n-backup) | по ответу владельца на d-plan-capacity | строки завела сессия 5e |

Серверные шаги — блоки в пунктах очереди (исходники — `scratchpad/srv2/*.sh` сессии 09, в пунктах они полные).
После каждого мёржа: проверить деплой (`gh run list`), `/api/v1/health/ready`, страницу консоли, затем запись в
`docs/plans/done/` по одобрению владельца.

## Как сопровождать

- Обновить код бота на сервере: `scp` изменённых файлов из `infra/owner-queue-bot` в `/opt/owner-queue-bot/src`, затем
  `ssh root@173.212.238.170 'bash /opt/owner-queue-bot/src/deploy/run-server.sh'`. Данные и токены сохраняются. В логе
  должно быть `режим страницы: shared`.
- Токены консоли: `…/contabo-compose.sh exec -T ops-console node server-dist/oq-cli.mjs token-list | token-create | token-revoke`.
- Изменения консоли — это деплой прода: только PR и мёрж владельца, гейт `npm run typecheck && npm test` в
  `infra/ops-console`. Изменения бота, MCP и документов вливать с `[skip ci]`.
- Гейт бота: `cd infra/owner-queue-bot && node --test test/*.test.mjs`.
- Чего нельзя: класть секреты (токен GitHub, сессии) через агента — классификатор блокирует, это делает владелец;
  входить в claude.ai автоматизированным браузером (claude.ai отказывает); писать в старый артефакт.
