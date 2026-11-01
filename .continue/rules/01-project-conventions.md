---
name: Code conventions (apps/packages)
description: Детали конвенций кода HR Helper v2 — DRY/SOLID, куда класть файл, доменные Never по backend/Telegram/агентам/FSD. Запрашивать при написании или правке кода в apps/* и packages/*
globs: "{apps,packages}/**/*.{ts,tsx,js,jsx,prisma,proto}"
alwaysApply: false
---

Короткий список Never/Always — в корневом руле, он уже загружен. Здесь то, что в него не влезло.

## DRY / SOLID

- Тип/DTO в 2+ местах → `packages/types`. Утилита в 2+ местах → `packages/utils`.
  Не дублировать логику backend↔frontend — контракт через `packages/`.
- Сервис >300 строк или метод >80 строк → декомпозиция. Файл >500 строк — жёсткий лимит.
- Новая интеграция/провайдер = новый класс, не ветвление внутри существующего.
- Перед написанием нового хелпера — grep: нет ли уже такого. Дубль хуже лишнего импорта.

## Доменные Never

- **Telegram:** новая операция мимо Session Manager RPC (whitelist `B8_LEGACY_GRAMJS_OPERATIONS`
  только сокращать, не расширять) · потеря `parse_mode` на любом пути отправки
  (text / quote-reply / edit / caption файлов / notifications) · трактовка
  `406 AUTH_KEY_DUPLICATED` как «сессия недействительна» — это конфликт владения, а не разлогин.
- **Агенты:** новый агент без `registerQueueAgent()` в `agent-invoker-bootstrap.service.ts` —
  молча недостижим через `AgentInvokerService`. Четыре шага регистрации обязательны целиком.
- **MCP:** API key только из `Authorization: Bearer`, никогда из query param (попадает в
  access-логи nginx). Ключи `McpApiKey`/`PluginOAuthClient` — только хэш, plaintext показать
  один раз при создании.
- **HITL:** каналы MCP и Extension не получают bypass — тот же `AutomationRunLog` со статусом
  `PENDING_APPROVAL`, что у UI и чата.
- **Frontend:** FSD — `shared/` не импортирует из `features/` · статический импорт
  `exceljs`/`pdfjs-dist` (только динамический) · `dangerouslySetInnerHTML` без DOMPurify.
- **БД:** `$transaction` только callback-форма с опциями; batch-форма `$transaction([...])`
  опций не принимает — это не баг, а сигнатура · новые поля в WHERE → `@@index` в
  `schema.prisma` · после записи читать в той же транзакции (лаг реплики 50–500 мс).

## Куда класть файл

Код приложения → `apps/<app>/src/` · shared без Nest/React → `packages/` ·
фикстуры/mock → `examples/` или `__mocks__/` (не в `features/`) · инфраструктура → `infra/` ·
артефакты → `artifacts/`. Доменная логика в `common/` запрещена — там только инфраструктура Nest.

## Документация — читать, новые файлы не создавать

Канон открытых задач и багов — **t-boards** («Задачи» / «Ошибки»), не git; Notion — архив только для чтения.
`docs/plans/archive/FIX.md` и `docs/plans/BACKLOG.md` **заморожены с 2026-08-12** — это снимок на дату
миграции: не читать их для скоупа открытой работы и не дописывать туда.
Канон закрытого — `docs/plans/done/<модуль>.md` (оглавление и формат — `docs/plans/DONE.md`): туда компактная запись при закрытии пункта.

Найден баг или уязвимость — сказать об этом пользователю явно и предложить текст карточки для
t-boards «Ошибки». Не заводить новых plan/fix/архив-файлов в `docs/`.

## Роли

Continue не подгружает вложенные `CLAUDE.md` сам: перед работой в каталоге прочитай ближайшую карточку роли
(`apps/backend/CLAUDE.md`, `apps/frontend/src/locales/CLAUDE.md`, `docs/qa/CLAUDE.md`, …) — там логика решений,
проверенные команды и гейт. Карта ролей — корневой `CLAUDE.md`; знания роли — `docs/<папка>/` (`docs/README.md`).
