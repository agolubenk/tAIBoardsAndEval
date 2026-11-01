# Вендоренные скиллы — происхождение, локальные патчи, зеркала

Скиллы ниже взяты из стороннего репозитория и доступны **любой модели и любому агенту** проекта,
а не только Claude Code.

## Источник

| | |
|---|---|
| Репозиторий | [emilkowalski/skills](https://github.com/emilkowalski/skills) |
| Коммит | `d16ebe60d09a5ba2afcb7054ede9d0a10c9f6128` (2026-09-24) |
| Лицензия | MIT, текст ниже |
| Скиллы | `animate` · `animate-expo` · `animation-vocabulary` · `apple-design` · `ask-sonner` · `emil-design-eng` · `find-animation-opportunities` · `improve-animations` · `mobile-native` · `pick-ui-library` · `prototype` · `review-animations` · `write-swift` |

## Где лежат

Канон — `.claude/skills/<name>/` (Claude Code, включая субагентов на любой модели). Остальные
каталоги — **копии** (не симлинки: часть загрузчиков перебирает каталоги через
`is_dir()`/`Dirent.isDirectory()` и пропускает симлинки на каталоги):

| Каталог | Кто читает |
|---|---|
| `.claude/skills/` | Claude Code (канон) |
| `.agents/skills/` | Codex, Cursor, Gemini CLI, GitHub Copilot, OpenCode, Cline |
| `.continue/skills/` | Continue (в т.ч. локальные модели) |
| `.windsurf/skills/` | Windsurf |

Руками зеркала не править. После правки канона запустить синк, дрейф проверяется `--check`:

```bash
.claude/scripts/sync-agent-skills.sh            # канон → все зеркала
.claude/scripts/sync-agent-skills.sh --check    # exit 1, если зеркало разошлось с каноном
.claude/scripts/sync-agent-skills.sh --from-upstream /path/to/emilkowalski-skills-clone
```

`--from-upstream` берёт `skills/<name>` из клона апстрима, накладывает локальные патчи и
раскладывает по зеркалам. Если в апстриме появился новый скилл, скрипт напишет об этом. Чтобы
вендорить его, добавьте имя в `SKILLS` в скрипте.

## Локальные патчи (накладываются скриптом, в апстриме их нет)

1. **`disable-model-invocation: true` снят** у `pick-ui-library`, `prototype`, `review-animations`.
   С этим флагом Claude Code не даёт модели вызывать скилл, работает только слэш-команда
   пользователя. Субагенты и другие модели не могли им воспользоваться даже по прямой просьбе.
   Описания не менялись: там по-прежнему сказано «only runs when explicitly invoked», и модель
   вызывает эти три скилла только по явной просьбе.

## Какой скилл когда (кратко)

- iOS / SwiftUI UI и движение: `apple-design` (пружины, жесты, материалы, типографика),
  `emil-design-eng` (решение «анимировать ли», кривые, press-feedback), `write-swift` (Swift 6,
  concurrency, Swift Testing).
- Анимации: `animate` (сделать), `review-animations` (строгое ревью), `improve-animations`
  (аудит кодовой базы → планы), `find-animation-opportunities` (где движения не хватает),
  `animation-vocabulary` (как это называется).
- Веб: `mobile-native` (веб на телефоне как нативное), `ask-sonner` (тосты Sonner),
  `pick-ui-library` (выбор библиотеки), `prototype` (несколько вариантов UI с переключателем).
- React Native / Expo: `animate-expo` (в проекте RN не используется, скилл оставлен для полноты
  набора).

## Лицензия апстрима

```
MIT License

Copyright (c) 2026 Emil Kowalski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
