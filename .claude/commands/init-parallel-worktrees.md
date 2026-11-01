---
description: Поднять три рекомендуемых worktree для параллельных AI-сессий (refactor, fix, spike)
---

Создай три git worktree для параллельной работы без конфликтов в одном checkout.

Выполни из **корня репозитория**:

```bash
mkdir -p worktrees/refactor worktrees/fix worktrees/spike

# Refactor: декомпозиция putVacancyFull
git worktree add worktrees/refactor/vacancy-save-split -b refactor/vacancy-save-split main 2>/dev/null || \
  git worktree add worktrees/refactor/vacancy-save-split refactor/vacancy-save-split

# Fix: N+1 в CandidateMergeService
git worktree add worktrees/fix/candidate-merge-n-plus-one -b fix/candidate-merge-n-plus-one main 2>/dev/null || \
  git worktree add worktrees/fix/candidate-merge-n-plus-one fix/candidate-merge-n-plus-one

# Spike: консолидация AI-модулей
git worktree add worktrees/spike/ai-module-consolidation -b spike/ai-module-consolidation main 2>/dev/null || \
  git worktree add worktrees/spike/ai-module-consolidation spike/ai-module-consolidation

git worktree list
```

## После создания

Выведи таблицу:

| Путь | Ветка | Задача |
|------|-------|--------|
| `worktrees/refactor/vacancy-save-split` | `refactor/vacancy-save-split` | God Method vacancies |
| `worktrees/fix/candidate-merge-n-plus-one` | `fix/candidate-merge-n-plus-one` | N+1 batch |
| `worktrees/spike/ai-module-consolidation` | `spike/ai-module-consolidation` | AiModule spike |

Напомни:

- В каждой директории — отдельная Claude Code сессия
- `npm install` в worktree при первом запуске
- Если зависимости общие через симлинки на один `node_modules`, общими становятся и кэши сборки (`.tmp`, `.vite`,
  `.vite-temp`, `.cache`): держи их в каждом worktree своими или не запускай сборки параллельно — иначе
  результаты tsc и vite одного worktree подмешиваются в другой
- Локальные env копируются через `.worktreeinclude`
- Удаление: `make wt-rm TRACK=... NAME=...` или `git worktree remove <path>`
