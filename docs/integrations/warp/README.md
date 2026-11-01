# warp — разбор встраивания

> **Статус (2026-11-01):** 🔍 разобран (2026-11-01), прочитан коммит
> [`d57d976`](https://github.com/warpdotdev/warp/tree/d57d9760dba0590416eca4c94379ce7653f347b5) (2026-10-30, клон
> `--filter=blob:none --depth 1`). Прочитаны только перечисленные ниже файлы. Источник —
> [warpdotdev/warp](https://github.com/warpdotdev/warp). Индекс и правила — [`../README.md`](../README.md).

## Что это

Клиент терминала Warp: GPU-рендер на Rust, сейчас позиционируется как «agentic development environment». Работает и
со своим агентом, и с внешними CLI-агентами — Claude Code, Codex, Gemini CLI, opencode.

Раньше репозиторий содержал в основном issues. На этом коммите в нём **исходный код клиента**: Cargo workspace из
`app/` и 80 крейтов в `crates/`, около 4 150 файлов `.rs`, 6 425 файлов всего. Пути ниже — от корня репо Warp.

- **Лицензии, по каталогам:**
  - workspace — `license = "AGPL-3.0-only"` (`Cargo.toml:27`); `app/` и 78 крейтов наследуют её
    (`license.workspace = true`);
  - только `crates/warpui` и `crates/warpui_core` (UI-фреймворк) — `license = "MIT"`;
  - тексты лицензий — `LICENSE-AGPL` и `LICENSE-MIT`, © Denver Technologies, Inc.; это же написано в разделе
    «Licensing» README и в FAQ;
  - внутри есть чужие лицензии: Alacritty (`crates/warp_terminal/src/model/LICENSE-ALACRITTY`), Rudder SDK (MIT,
    Segment; `app/src/server/telemetry/`), Windows Terminal и DXC (`app/assets/windows/`), шрифты;
  - для вклада нужна CLA.
- **Что закрыто** (FAQ, «What's open source»): сервер, бэкенд Warp Drive, хостинговая аутентификация и Oz —
  оркестрация агентов. Встроенный агент работает на сервере. README: «OpenAI — founding sponsor», агентные
  workflow работают на моделях GPT. Подписку Claude или Codex во встроенном агенте использовать нельзя, ACP только
  планируется (FAQ, issue #9233).
- **Без входа и облака** часть функций работает локально. Drive, агенты на хостинговых моделях и командные функции
  требуют бэкенда (FAQ). Какой именно набор работает без аккаунта — не проверено.
- **Части кода, относящиеся к нам:**
  - **Launch configurations** — YAML в `~/.warp/launch_configurations/`: окна, вкладки и панели; у вкладки `title`,
    `color`, `commands: [{exec}]`; у панели `cwd` (`app/src/launch_configs/launch_config.rs:279-366`, пример —
    `crates/integration/tests/data/test_launch_config.yaml`). Конфиг открывается URI-хостом `launch`
    (`app/src/uri/mod.rs:142,227`), открытие пишет событие телеметрии `LaunchConfigUiLocation::Uri`. Полную
    схему `warp://launch/<путь>` знаю по документации Warp, в коде не сверял.
  - **Локальное управление** — `crates/local_control` и CLI `warpctrl` (`crates/warp_cli/src/local_control/`):
    - каталог действий `window.*`, `tab.*` (create, rename, color), `pane.*`, `session.list`,
      `input.insert`/`input.replace`, `setting.*` (`catalog.rs:169-261`, протокол v1);
    - `tab.create` принимает только `tab_type`, без cwd и команды (`protocol.rs:170`);
    - безопасность: HTTP только на 127.0.0.1, Unix-сокет-брокер выдаёт короткоживущий креденшл на одно действие,
      проверяет peer-UID, discovery-записи без токенов (`discovery.rs:1-25`, `auth.rs`);
    - функция включается настройкой: при выключенном «Scripting» endpoint не публикуется.
  - **Плагин для Claude Code** — `app/src/terminal/cli_agent_sessions/plugin_manager/claude.rs:16-60`:
    - Warp ставит в Claude Code плагины `warp@claude-code-warp` и `oz-harness-support@claude-code-warp` из
      marketplace `warpdotdev/claude-code-warp`, `can_auto_install = true`;
    - при каком действии пользователя ставит — не проверено; содержимое плагина (хуки) — отдельный репо, не
      читал.
  - **Учёт расхода по транскриптам** — `crates/warp_harness_usage/`: парсит JSONL Claude и Codex, считает `input`,
    `output`, `cache_read`, `cache_creation` 5m/1h, дедуплицирует повторы по session/response id
    (`src/claude.rs:16-60`).
  - **Маскировка секретов** — `crates/secret_redaction`, regex и DFA, AGPL.
  - **Телеметрия** — коллектор Rudder с переключателем `PrivacySettings.is_telemetry_enabled`
    (`app/src/server/telemetry/collector.rs:174`). Значение по умолчанию не проверено.

## На что ложится в tAIBE

| Часть tAIBE | Что есть у нас | Что даёт Warp | Пересечение |
|---|---|---|---|
| `eval/tools/spawn_session.sh` — запуск ролей Т3 и наследника | bash 3.2, `osascript` → Terminal или iTerm, `--terminal print`, `unset CLAUDE_CODE_CHILD_SESSION CLAUDECODE` перед `exec claude` (против выключенной записи транскрипта), геном `--settings` | Launch config: одно окно, вкладка на роль с именем и цветом, `commands` | **Дополняет** только как третья цель `--terminal`. preflight (§3.2 evolution) и `unset` не заменяет. Снимает ли Warp маркеры `CLAUDE_CODE_CHILD_SESSION`/`CLAUDECODE` — не проверено. В harness Oz он чистит только свои `*_LISTENER_MANAGED_EXTERNALLY` (`app/src/ai/agent_sdk/driver/harness/mod.rs:558`) |
| Mac владельца, 6 окон ролей | Отдельные окна Terminal | Именованные цветные вкладки в одном окне, `warpctrl tab.rename/color` | Только удобство. Метрик продукта ($/PR, контекст, RPO, простои) не трогает |
| `eval/nerve/budget.py`, `eval/tools/context_audit.py` | Расход из `usage` с `ephemeral_1h` и дедупом по request id | `warp_harness_usage` | Дубль. AGPL — код брать нельзя, нужная логика у нас уже есть |
| `eval/swarm/egress.py` | Маска секретов и PII, запрет путей | `secret_redaction` | Дубль. AGPL — только идея. Свой набор шаблонов шире (PII, Telegram, `gw-…`) |
| Слой `.claude` и геномы П1 | Геном задаёт плагины, хуки и L1 | Плагин `claude-code-warp` в Claude Code | **Риск, не польза.** Чужие хуки и плагины в L1 бьют по «первый вызов ≤ 55K» и по воспроизводимости генома |
| Нерв, тапы ролей | Monitor + `nerve.py tap` | Oz wake driver (`.../claude_code/wake_driver.rs`) — пробуждение «спящей» сессии Claude через mailbox | Похоже на Нерв по идее, но зависит от закрытого сервера Oz (`ServerApi`). Не применимо |

## Варианты встраивания

| Вариант | Что берём (ядро / возможность / дизайн / принцип) | Куда | Цена (код, RAM, токены, поддержка) | Эффект (цифра или способ замера) |
|---|---|---|---|---|
| A — идея/принцип без кода | (1) **Декларативная раскладка ролей**: окно, вкладки, имя, цвет, cwd, команда — данными, а не кодом `osascript`; рендер под Terminal, iTerm или print. (2) **Дизайн local control**: loopback-endpoint плюс короткоживущий креденшл на одно действие через Unix-сокет с peer-UID — для локальных служб (`llm-gateway`, хаб `:3050`), где сейчас долгоживущий токен в файле `.state/token` | (1) `eval/tools/spawn_session.sh`. (2) `infra/llm-gateway`, `infra/mcp-hub` — сначала оценка угрозы | (1) ~30–60 строк bash 3.2, 0 токенов. (2) Отдельная задача безопасности, не меньше нескольких дней, нужна линза security | (1) Число мест с кодом под конкретный терминал (сейчас ветки `terminal`/`iterm` в `launch`) и время добавить новую цель. Метрики продукта не меняются — делать только вместе с preflight §3.2. (2) Срок жизни секрета: «бессрочно» против «секунды»; тест «чужой UID не получает креденшл» |
| B — адаптер / интеграция | Warp как цель `--terminal warp`: скрипт пишет `~/.warp/launch_configurations/t3-<роль>.yaml` (`title`, `color`, `cwd`, `commands: exec` = та же строка с `unset … && exec claude --settings …`) и открывает `launch` URI | `eval/tools/spawn_session.sh` | ~40 строк bash. Warp на Mac владельца. Выключить телеметрию. **Отказаться от авто-установки плагина** Claude в `~/.claude`. Fallback на Terminal остаётся. RAM приложения не замерял | Продуктовых метрик не двигает. Замер — «запись транскрипта включена» у 100 % запущенных ролей (как сейчас) плюс отсутствие чужих плагинов в `/plugin list` сессии. Без выигрыша это «на прежнем уровне», а по правилам реестра — отказ |
| C — вендоринг части кода | — | — | AGPL-3.0 для `app/` и 78 крейтов: вендоринг в MIT-части запрещён правилом реестра. MIT-крейты `warpui*` — UI-фреймворк на Rust, у нас нет Rust-UI. Неприменимо | — |

## Проверка «усиливает, а не заменяет»

- [x] Не заменяет часть продукта. A(1) и B только добавляют цель запуска. Учёт расхода, маскировку и
  wake driver отклонили как дубли.
- [ ] Метрика после лучше, чем до. Для B продуктовой метрики, которая улучшилась бы, нет. Для A(1) замер не
  определён дальше «меньше кода под терминал».
- [x] Инвариант «снаружи ничего не меняется» сохранён: PR, карточки, очередь и бот не затронуты.
- [x] Лицензия: идея — всегда можно; B — Warp используется как приложение, по FAQ это не включает обязательства
  AGPL; C — запрещён (AGPL), MIT-часть не нужна.
- [ ] Ресурсы: для B нужно приложение Warp на Mac (RAM не замерял). Отказ Warp не должен останавливать запуск —
  обязателен fallback на Terminal. Пока не реализовано.
- [ ] Данные: для B телеметрия клиента (включая событие открытия launch config) и плагин в `~/.claude` трогают
  машину владельца и слой. Значения по умолчанию не проверены.

## Риски и открытые вопросы

- **Лицензия:** почти весь код под AGPL-3.0-only. Ни строки в `boards/`, `eval/` или `infra/`, только идеи.
  Атрибуция идеи — по правилам реестра.
- **Облако и лок-ин:** агент, Drive и Oz закрыты и серверные, встроенный агент — на GPT. Для команды на подписке
  Claude ценности нет. Формат launch config — частный формат Warp.
- **Вмешательство в слой:** авто-установка плагинов `claude-code-warp` меняет конфиг Claude Code вне генома.
  Это прямой риск для П1 (воспроизводимый геном) и для бюджета первого вызова. Перед любым B нужно прочитать
  репо `warpdotdev/claude-code-warp` (не сделано).
- **Телеметрия:** Rudder-коллектор, переключатель в PrivacySettings, значение по умолчанию не проверено.
- **Нагрузка репо:** README приглашает агентов работать по `AGENTS.md` и `.agents/skills/`. Для нас это недоверенные
  инструкции. Разбор их не исполнял.
- **Не проверено:** точная схема `warp://`, работает ли запуск `commands` без входа в аккаунт, RAM и CPU клиента на
  Mac, как Warp наследует окружение при запуске из URI и не тянет ли он `CLAUDE_CODE_CHILD_SESSION`.

## Вердикт и рекомендация

**Не брать.** Код — AGPL, а нужная нам часть (учёт расхода, маскировка) уже есть. Агентная часть закрыта и
серверная. Как терминал Warp не улучшает ни одной метрики продукта.

**Вернуться позже**, если выполнено одно из условий:

- владелец сам перейдёт на Warp как основной терминал. Тогда B — opt-in `--terminal warp` с выключенной телеметрией,
  запретом авто-плагина и fallback на Terminal, только вместе с preflight §3.2;
- Warp откроет ACP с подпиской Claude.

Самое ценное, что можно взять сейчас, — идея A(2): креденшл на одно действие через Unix-сокет с peer-UID для
локальных служб. Это отдельная карточка безопасности после оценки угрозы. A(1), раскладку ролей данными, стоит
делать только в составе preflight лаунчера.

Карточку в tAI-Boards не заводил (вне объёма). Адверсариальная проверка ≥ 3 линзами (корректность и отказы ·
ресурсы, включая Mac владельца · продукт и простота, плюс security для A(2)) обязательна до внедрения.
