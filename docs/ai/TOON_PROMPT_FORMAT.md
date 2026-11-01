# TOON — формат промпта для HR Helper

> **TOON** (Token-Oriented Object Notation) и **TRON** — синтаксисы компактной сериализации для LLM-промптов. Это **не** имена моделей Ollama. Локальные модели: [`LOCAL_OLLAMA_MODELS.md`](./LOCAL_OLLAMA_MODELS.md).

## Зачем

- Меньше символов в user-payload при сохранении структуры (RAG-пары, сообщения панели).
- Стабильный system-блок с правилами чтения TOON; данные — только в `user`.
- Offline-индекс wiki → runtime: 1 запрос к `wiki_rag_chunks` + top-K, без 40× parse markdown.

## Синтаксис

### Tabular (массив однотипных записей)

```text
<name>[<count>]{<field1>,<field2>,...}:
  <v1>,<v2>,...
  <v1>,<v2>,...
```

- `count` — число строк данных (не включая заголовок).
- Поля разделены запятой; значения в строке — в том же порядке.
- Строки данных с отступом (2 пробела) — опционально, для читаемости.

### Null

Значение `~` означает null / отсутствует.

### Escape полей

Если значение содержит `,`, перевод строки, `\` или `"` — оборачивать в двойные кавычки и экранировать `\`, `"`, `\n`, `\r`.

Пример: `hello, world` → `"hello, world"`.

## Примеры для Telegram ИИ-панели

### RAG chunks

```text
chunks[2]{id,q,a}:
  softnetix_office,Где офис?,Минск Немига и Варшава. Full-time офис...
  softnetix_remote,Удалёнка?,Не поддерживается. Исключения — отпуск за свой счёт.
```

### Сообщения панели

```text
msgs[3]{dir,ts,text}:
  in,2026-06-02T10:00,Здравствуйте! Интересует вакансия Frontend
  out,2026-06-02T10:05,Добрый день! Расскажу про условия...
```

- `dir`: `in` (кандидат) | `out` (рекрутер).
- `ts`: ISO 8601 локальное или UTC (краткая форма без пробелов в поле — предпочтительно `T`).

### System (split D)

Фиксированный блок (~15 строк): что такое TOON, как читать `name[N]{fields}:`, ответ — **только plain text** кандидату (без markdown и пояснений). Реализация: `TELEGRAM_AI_TOON_SYSTEM_PROMPT` в backend.

## Acceptance criteria (AI-OPT v1)

- [x] Промпт TG draft (`message_draft`) использует TOON для RAG + `msgs`.
- [x] Runtime wiki: не более **1** list query к индексу + top-8 (не 40× parse).
- [x] Стиль переписки — прежний текстовый формат (`formatCommunicationProfileForPrompt`).
- [x] Unit-тесты serializer: кириллица, запятая в поле, `~` null.

## Кодовые точки

| Компонент | Файл |
|-----------|------|
| Serializer | `packages/utils/src/toon/` |
| Wiki parse (сохранить) | `apps/backend/.../telegram-rag.util.ts` |
| Offline index | `apps/backend/.../wiki-rag-index.service.ts` |
| Draft prompt | `apps/backend/.../telegram-ai-suggestion.service.ts` |
| RAG-lite (опц.) | `apps/backend/.../ai-rag-lite.service.ts` |

## Вне scope

- Resume/CV, vision, голос.
- TOON для `telegram-communication-style` (v1 без изменений).
