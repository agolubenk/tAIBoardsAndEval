# Перезапуск команды 30.10 — что сделать владельцу

`$H` = `~/.claude/projects/-Users-agolubenko-Desktop-Development-HR-Helper-v2/handoff`.

## Где мы

- Все 9 прежних сессий остановлены и сдали отчёты (`$H/2026-10-30/collect/hr-helper-v2-<id>.md`): e1, 66, 85, 84, d7,
  4c, d9, 87, 12. Фоновые задачи сняты (у d9 — два вотчера, у d7 — один, у остальных их не было). Кронов и мониторов
  нет. Новых PR, мёржей и записей в очередь с начала заморозки не было.
- Файлы из scratchpad старых сессий, на которые ссылаются отчёты, скопированы в `$H/2026-10-30/collect/files/`. Без
  копии они пропали бы вместе с сессией.
- Инструменты обновлены:
  - геном — по одному на каждую из 6 ролей: `supertick-eval/pipeline/genome/<ключ>.json`, все собраны из `roles.json`
    скриптом `build.py`. Исправлено: прежние геномы выключали правило 90 у самой команды Т3;
  - Нерв знает новые роли (`boards` вместо `review`), маршруты QA → `coord`, безопасность → `release`,
    t-boards и supertick-eval → `boards`;
  - капсула пишет ещё и `contextPack` для карточки t-boards (≤ 2000 символов);
  - два новых антигена: устаревший путь к бинарю `claude` и `gh pr merge` без правил мёржа;
  - `supertick-eval/context/our-team.md` переписан на 30.10.

  Тесты: pipeline 36/36, Нерв 15/15, `build.py --check` чисто.

## Шаг 1. Три вопроса по раскладке (LANES-BASE §0)

Запуск идёт с рекомендованными ответами. Если хотите иначе — скажите роли 1 после запуска, ничего переделывать не
придётся.

1. **Кто вливает PR.** Роль 5 (`release`). На рискованных PR вердикт безопасности даёт роль 1 или 2, чтобы роль 5 не
   проверяла сама себя.
2. **Работы 87 (VPS, бэкап, зеркало Notion).** Отходят роли 5. Код форка t-boards — роли 6.
3. **85 и 84.** Закрываются после «передано», как и остальные, вместо «до понедельника». QA уходит к роли 1,
   безопасность — к роли 5.

## Шаг 2. Перезапустить Нерв (новые роли)

```
launchctl kickstart -k gui/$(id -u)/space.hrhelper.nerve
```

Откат: `cp ~/.claude/projects/-Users-agolubenko-Desktop-Development-HR-Helper-v2/handoff/2026-10-30/collect/files/nerve-config.before-3010.json ~/Desktop/Development/HR_Helper-v2/supertick-eval/nerve/config.json`
и ещё раз `kickstart`.

## Шаг 3. Запустить 6 сессий

Первый запуск 30.10 в 18:42 прошёл из панели, без генома. По решению `d-genome-stage0-3010` (21:55) роли переезжают
в терминал: дела сдаёт вкладка той же роли в панели, процедура — `RELAUNCH-TERMINAL.md`.

Каждая роль — в своей вкладке встроенного терминала VS Code (Terminal → New Terminal). Запускайте по порядку
1 → 5 → 4 → 3 → 2 → 6. Первой нужна роль 1: она единственная пишет вам. Старую вкладку роли закрывайте, когда
оркестратор (hr-helper-v2-37) скажет «можно закрыть»: новая роль сначала принимает дела.

```
cd ~/Desktop/Development/HR_Helper-v2 && claude --settings supertick-eval/pipeline/genome/coord.json "Сборка Т3, ключ реестра coord, роль 1. Перезапуск в терминале: дела сдаёт hr-helper-v2-db (эта же роль, панель). Первым прочитай supertick-eval/prompts/launch-3010/RELAUNCH-TERMINAL.md и действуй по нему."
cd ~/Desktop/Development/HR_Helper-v2 && claude --settings supertick-eval/pipeline/genome/release.json "Сборка Т3, ключ реестра release, роль 5. Перезапуск в терминале: дела сдаёт hr-helper-v2-f8 (эта же роль, панель). Первым прочитай supertick-eval/prompts/launch-3010/RELAUNCH-TERMINAL.md и действуй по нему."
cd ~/Desktop/Development/HR_Helper-v2 && claude --settings supertick-eval/pipeline/genome/backend.json "Сборка Т3, ключ реестра backend, роль 4. Перезапуск в терминале: дела сдаёт hr-helper-v2-6f (эта же роль, панель). Первым прочитай supertick-eval/prompts/launch-3010/RELAUNCH-TERMINAL.md и действуй по нему."
cd ~/Desktop/Development/HR_Helper-v2 && claude --settings supertick-eval/pipeline/genome/frontend.json "Сборка Т3, ключ реестра frontend, роль 3. Перезапуск в терминале: дела сдаёт hr-helper-v2-89 (эта же роль, панель). Первым прочитай supertick-eval/prompts/launch-3010/RELAUNCH-TERMINAL.md и действуй по нему."
cd ~/Desktop/Development/HR_Helper-v2 && claude --settings supertick-eval/pipeline/genome/plan.json "Сборка Т3, ключ реестра plan, роль 2. Перезапуск в терминале: дела сдаёт hr-helper-v2-7a (эта же роль, панель). Первым прочитай supertick-eval/prompts/launch-3010/RELAUNCH-TERMINAL.md и действуй по нему."
cd ~/Desktop/Development/HR_Helper-v2 && claude --settings supertick-eval/pipeline/genome/boards.json "Сборка Т3, ключ реестра boards, роль 6. Перезапуск в терминале: дела сдаёт hr-helper-v2-27 (эта же роль, панель). Первым прочитай supertick-eval/prompts/launch-3010/RELAUNCH-TERMINAL.md и действуй по нему."
```

- По фразе «Сборка Т3, ключ реестра …» включается правило 90, а Нерв узнаёт роль.
- `claude` берётся из PATH, сейчас это 2.1.312. Старые инструкции с путём к бинарю расширения 2.1.311 устарели.
- **Запасной путь — панель расширения VS Code.** Вставьте то же первое сообщение. Геном там не подхватится: сессия
  будет работать с полным набором инструментов, а первый вызов в замере стоил 83K токенов против 42K.

## Шаг 4. «Передано» и закрытие старых

Когда новые сессии запустятся, напишите здесь «запущены». Если не напишете — я увижу их сам в лесе t-boards
(`forest_list_work_state`, ярлыки `t3-<ключ>`).

1. Каждая новая роль принимает дела и ставит в лесе шаг «дела приняты от …».
2. После этого я шлю каждой старой сессии «передано» (текст — ниже).
3. Каждая старая сессия отвечает одной строкой: «сдано: ок» или «сдано: не хватает — <что>». Недостающее я
   отправляю новой роли.
4. После «сдано: ок» вкладку старой сессии закрываете вы.

| Старая | Чьи дела к кому |
|---|---|
| e1 | → 1 `coord`; полоса 6 (с 11:22) → 6 `boards` |
| 66 (в очереди — d8) | → 1 `coord` |
| 85 | QA → 1 `coord`; безопасность → 5 `release` |
| 84 | → 2 `plan` |
| d7 | → 3 `frontend` |
| 4c | → 4 `backend` |
| d9 | → 5 `release` |
| 87 | VPS и OPS → 5; форк t-boards → 6; волна 2 просроченных → 3; PR #446 → 4 |
| 12 | → 6 `boards` |

Текст «передано» (шлю я):

> передано: роль `<N>` (`<ключ>`) запущена и приняла твой отчёт `collect/hr-helper-v2-<id>.md` — видно в лесе
> t-boards, session `t3-<ключ>`. Проверь за 5 минут, есть ли всё из разделов B и C твоего отчёта в
> `supertick-eval/prompts/launch-3010/roles/<N>-<ключ>.md`. Захваты в очереди на твоё имя не снимай: новая роль
> перехватит их со своим `session`. Ответь одной строкой: «сдано: ок» или «сдано: не хватает — <что>, <где>». После
> ответа ничего не запускай.

## Ваши дела — независимо от запуска

| Что | Срок | Кто ведёт |
|---|---|---|
| `c-tb-board-close-3010` (закрыть TB-1, TB-12, OPS-2) | **истекает 31.10 12:28** | 1 |
| Окно «Влить» m-440 → m-442 → m-443 (P0, права интеграций), затем проба прода | когда удобно, одним заходом | 5 |
| m-445 — только с `[skip ci]` в заголовке мёржа (команда уже в пункте), затем пункт «главный checkout» | в любой момент | 5 |
| Ротация токена шлюза из пункта #445 — не откладывать | после m-445 | 5 |
| `s-admin-domain-on` v9, этап 6: «можно» ставит роль 1 после проб; за минуту до — вход `c-admin-mfa-s1` | после окна #440 | 1 |
| Пакет вопросов 20:50 (q1 PR-B · q2 Potok · q3 push форка · q4 потерянные роли) | вечер 30.10 | 1 |
| `s-tb-fork-push-ops15` → `ops19`, `s-tb-update-b10`, `s-tb-wg-replies`, `c-close-overdue-3010`, `c-swarm-openrouter-keys`, `s-ai-policy-enforce` | по очереди | 5 / 6 / 1 |

## Главный checkout — не потерять перезапуск

Файлы перезапуска лежат незакоммиченными в главном checkout, он на `main`. Роль 6 первым делом выносит их PR с
`[skip ci]`. До тех пор пункт «главный checkout» (`reset --keep` после #445) должен их сохранить. Роль 5 включает
их в проверку коллизий:

- `supertick-eval/pipeline/genome/{roles.json,build.py,test_genome.py,coord.json,plan.json,frontend.json,backend.json,release.json,boards.json,antigens.json}`;
- `supertick-eval/pipeline/{capsule.py,test_capsule.py,reflex/test_reflex.py}`;
- `supertick-eval/nerve/{config.json,test_nerve.py}`;
- `supertick-eval/context/our-team.md`;
- `supertick-eval/prompts/launch-3010/**`;
- раскладка документов `t-boards/`, тоже вне git и тоже в этом PR: `impl/`, `archive/`, `migration/`, `README.md`,
  правки и удаления в корне `t-boards/`, а ещё `supertick-eval/pipeline/capsules/author.md`.

## Если что-то пошло не так

- Новая сессия упала на старте, например из-за ошибки в геноме: запустите ту же команду без
  `--settings supertick-eval/pipeline/genome/<ключ>.json`. Старый геном координатора лежит в
  `/private/tmp/claude-501/-Users-agolubenko-Desktop-Development-HR-Helper-v2/a2130889-8d90-4e03-b87c-d3682093c5e8/scratchpad/coord.before.json`.
- Старые сессии не закрывайте до «сдано: ок»: пока они живы, к ним можно вернуться.
