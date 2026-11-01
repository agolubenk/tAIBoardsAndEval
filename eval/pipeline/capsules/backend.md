# Капсула: backend

**Цель.** Роль 4 (backend, Т3): довести PR #433 (merge-guard) до мёржа Контролем; до сброса лимита чт 05.11 19:00 — только #433 (решение владельца 31.10).

**Приёмка.**
- Вердикты на голове 1d19a0268 в PR: QA (роль 1, hr-helper-v2-fb) — ок, issuecomment-6540997267 (остаток против намеренного обхода записан в тело r18); безопасность (роль 2, hr-helper-v2-ac) — A–D после 05.11 19:00; Контроль (роль 5, hr-helper-v2-b7) — B/C/D после 05.11 19:00 или по «да» владельца
- Тесты 1115 = 506 + 609 rc 0; мутанты r23 15/15, r22 12/12, r21 30/30, r19 17/18; корпус 3000 — 25 = 25; обход 759 — 15 = 15; все файлы хука < 500 строк

**Решения.**
- Вывод $(cat f)/$(< f)/`cat f` в eval, sh -c, emulate -c и на месте имени команды — текст f (маркер с номером SUBST_AT, subst_code); нет файла или переписан — как source f; вывод программы — остаток (1d19a0268, subst_code в merge_guard_shell.py, eval_code/subst_files в хуке)
- Fail-closed на любую нечитаемую подстановку в eval/-c не взят: противоречит приёмке роли 1 (eval "$(ssh-agent -s)" — проход) (тело r17, круг 14)
- Остаток против намеренного обхода (вывод программы: head/sed/base64/python os.system/xargs sh -c, "$G" "$S" из профиля) принят QA роли 1 и записан в тело; страховка — шлюз деплоя (d-gh-pro-3010), не хук (тело r18, «Остаточные риски», первый пункт)
- Имя команды задано невидимо в набранной команде (source/./eval/export $(…) — любые, read/mapfile — прочитанные, имя из $(…)) → guess="blind": голый push на main — отказ (d9d2f9647, BLIND в merge_guard_vars.py, hidden в classify_argv)
- Для скрипта с диска строгость не действует: иначе +42 ложных отказа в обходе и +2 в корпусе (критерий роли 2 — не больше 2) (whole[2] в classify_argv)
- "$G" "$S"; echo ok — остаток «профиль пользователя»: состояние shell между вызовами Bash не живёт (тело r16, остатки)
- Снята эквивалентная проверка ANY + "config.yml" в gh_alias (merge_guard_gh.py)

**Механика.**
- /Users/agolubenko/Desktop/Development/HR_Helper-v2/worktrees/fix/merge-guard [fix/merge-guard] 1d19a0268, грязных 0

**Следующий шаг.** Ждать вердиктов ролей 1, 2, 5 комментариями в PR #433 на 1d19a0268; на changes — тесты, которые падают на голове, правка, мутанты, корпус и обход, тело r18 и комментарий автора, push, сообщение трём ролям.

**Не делать.**
- Не вливать (только Контроль, --match-head-commit; мёрж = деплой прода)
- Не писать владельцу (только Координатор); субагенты/workflow/model/fast — только по «да» владельца
- git только git -C <worktree>, push только git -C <wt> push origin fix/merge-guard; WT_DEPS_CHECK=0 перед python в worktree
- Другие PR (449, 448, 446, 439, 398, 341, 332, 320) не трогать; в Notion не писать

**Оригиналы.**
- PR #433 тело r18 (tools/r24/433-body-r18.md), комментарии автора issuecomment-6540987919 (круг 14) и r18
- changes QA роли 1: issuecomment-6540828484 (на d9d2f9647), issuecomment-6540664200 (на 8e6609611)
- handoff/2026-10-31/backend/handoff-fd-433-r12.md
- handoff/2026-10-31/backend/tools/r23 (mutants23.py, 433-body-r17.md, 433-comment-r17.md); r22 (mutants22.py); r21 (mutants21.py); 6f (sweep433.py, mutants19.py, c20-new.jsonl); corpus.py
