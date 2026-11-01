# Капсула: release

**Цель.** Роль 5 «Контроль» Т3: мёржи по одному с --match-head-commit (мёрж = деплой прода), вердикт = sha+base в m-пункте, проба прода после деплоя; DevOps/безопасность, VPS, бэкапы.

**Приёмка.**
- m-442 влит владельцем → деплой success → проба (health/ready, 5 адресов 200, закрытые ручки 401) → c-huntflow-check-440 владельца
- #433: новая голова от 6f закрывает обход скобками; линзы заново; второй вердикт безопасности — роль 2; только потом sha в m-433-merge-guard ([skip ci])
- Волна 2 по одному: #448 [skip ci] → #449 → #446 (Telegram/ПДн, отдельно, свежий бэкап БД до мёржа); #439 Dependabot вне пакета

**Решения.**
- Волна 1 на проде: #432 #444 #372 #451 #443 [skip ci] + #417 baa79a3b1, деплой 41113741348 success 19:46Z, проба 22:47 ок; m-444/443/417 done (oq m-417)
- m-442 planned: свой деплой, откат ref baa79a3b1, голова 6739c74de, слияние с baa79a3b1 чистое; ci-* build красны и на main (oq m-442)
- #433 changes на 5176136e3: скобки у git/gh не раскрываются — gh pr {merge,} 1 и git push origin HEAD:{main,x} проходят (PR #433 issuecomment-6531944616)
- d-rbac-lost-roles-3010: s-пункт ставит db (роль 1) по «Найти»; черновик отдан (handoff/2026-10-30/release/s-rbac-lost-roles-3010.draft.md)
- Тревога «НЕРВ МОЛЧИТ» трижды ложная: pid 43499 жив, пульс свежий — kickstart не делать, сверять heartbeat (supertick-eval/nerve/state/heartbeat)

**Механика.**
- /Users/agolubenko/Desktop/Development/HR_Helper-v2/worktrees/review/pr433 [detached] 5176136e3, грязных 0
- /Users/agolubenko/Desktop/Development/HR_Helper-v2/worktrees/fix/clickhouse-backup-export [fix/clickhouse-backup-export] 0d82fbf55, грязных 0

**Следующий шаг.** Прочитать work_state release-t3 и oq_list checks (m-442, m-433-merge-guard, d-rbac-lost-roles-3010). Если m-442 влит — gh run list deploy-contabo, дождаться success, проба, «влито #442 <sha>, проба ок» → db и 4c. Новая голова #433 — зонд handoff/2026-10-30/release/merge-guard-probe (README), тесты в worktrees/review/pr433.

**Не делать.**
- не вливать самому и не ставить sha без всех линз на текущей голове (gh pr view N --json headRefOid)
- не писать владельцу — только через db; статусы m-пунктов ведёт роль 5
- не kickstart нерва по одной тревоге; ночью без активной задачи — без мониторов
- не печатать токены; PSK OPS-14 и wg-*.sh не трогать; --hard в checkout владельца нельзя

**Оригиналы.**
- supertick-eval/prompts/launch-3010/roles/5-release.md
- work_state release-t3
- handoff/2026-10-30/release/
