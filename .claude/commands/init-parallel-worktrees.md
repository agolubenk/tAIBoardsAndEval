---
description: Поднять три worktree для параллельных AI-сессий (refactor, fix, spike) по темам пользователя
argument-hint: [refactor-topic] [fix-topic] [spike-topic] — kebab-case
---

Создай три git worktree для параллельной работы без конфликтов в одном checkout.

## Вход

1. Темы трёх дорожек — из аргументов; не переданы — спроси (kebab-case, по одной задаче на дорожку). Рекомендуемые
   дорожки репозитория, если они заведены, — в `worktrees/README.md`.
2. База — `WT_BASE` из `Makefile` (дом слоя — `board-agents`, host-проект — `main`).

## Выполнить

Из **корня основного репозитория**:

```bash
for pair in "refactor:<refactor-topic>" "fix:<fix-topic>" "spike:<spike-topic>"; do
  make wt-add TRACK="${pair%%:*}" NAME="${pair#*:}"
done
git worktree list
```

`make wt-add` создаёт ветку `<track>/<topic>` от `WT_BASE` (или берёт существующую) и ставит worktree свои
зависимости (`infra/scripts/dev/wt-deps.sh install`); без зависимостей — `WT_DEPS=0`.

## После создания

Выведи таблицу «Путь · Ветка · Задача» и напомни:

- В каждой директории — отдельная Claude Code сессия.
- Зависимости у каждого worktree свои; общий `node_modules` через симлинк делает общими и кэши сборки (`.tmp`,
  `.vite`, `.vite-temp`, `.cache`) — результаты tsc и vite одного worktree подмешиваются в другой.
- Локальные env копируются через `.worktreeinclude`.
- Удаление: `make wt-rm TRACK=... NAME=...` или `git worktree remove <path>`.
