# Task brief — ai-council-backlog

**GOAL:** выгрузить из Notion (Задачи `256853cd`, Ошибки `714f2a2f`) все карточки, связанные
с ИИ-консилиумом (AI Council, `docs/specs/ai-council.md`) и сервисами/решениями вокруг него,
и сформировать локальный перечень в файле BACKLOG.md.

**CONSTRAINTS:**
- `docs/plans/BACKLOG.md` заморожен (правило 17) — НЕ трогать; новый файл `docs/plans/ai-council/BACKLOG.md`.
- Notion остаётся каноном открытых задач — файл это сгенерированный снимок-перечень, не источник правды.
- Доступ — REST internal token (`.claude/council/.notion-key`), паттерн `infra/ai-council/notion.py`; только чтение.
- Никаких LLM-вызовов облака; фильтрация детерминированная (regex) + ручная кураторская проверка.
- Обе базы читаются ЦЕЛИКОМ (все статусы), тела карточок включительно — критерий «все» важнее скорости.

**SCOPE (что считается «связанным»):**
- Сам консилиум: council/консилиум, ai-council, протокол/роли/верификатор, planner, notion-sync, gateway, learning.
- Экосистема dev-AI: DAMS RAG-индекс, Headroom-прокси, Ollama (ростер/свопы), GLM/Z.AI Coding Plan + fallback, Gemini-лимиты, graphify, ai-pipeline/ai-tooling, дашборд, MCP-тулинг (serena/headroom/claude-mem), Continue-правила про модели — если карточка именно про них.
- НЕ скоуп: продуктовые AI-фичи (Telegram AI, Interview Copilot, resume parsing) — если карточка не про консилиум/dev-тулинг.

**ACCEPTANCE:**
1. Файл `docs/plans/ai-council/BACKLOG.md` существует, разбит на открытые/закрытые, каждая позиция: название, приоритет/severity, модуль, статус, ссылка на карточку, краткое пояснение.
2. Покрытие проверяемо: сырой дамп всех карточек с матчем/без — `raw.json`, решение по каждой матчнутой — `matches.json` (+отвергнутые с причиной).
3. Замороженный `docs/plans/BACKLOG.md` не изменён (git diff пуст по нему).
4. Адверсариальное ревью перечня — `review.md` в этой папке.