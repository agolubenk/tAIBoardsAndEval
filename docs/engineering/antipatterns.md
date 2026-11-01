# Антипаттерны — что ломают и где правило

> **Статус (2026-10-30):** сверено с `.claude/rules/*` на `origin/main` `3b846e6a6`. Для разработчика и агента: зачем
> существует каждый запрет. Примеры ❌/✅ — в правилах, здесь не повторяются. Статья попадает в блокнот t-boards
> (`t-boards/app/deploy/vps/mac/notebook-sync.mjs`, глоб `docs/**/*.md`) и ищется через `notebook_search`.

## Как устроены слои

- **Корневой `CLAUDE.md`, раздел Never** — однострочники, всегда в контексте.
- **`.claude/rules/NN-*.md` с `paths:`** — правило с примером. Грузится, когда агент открывает файл из этих путей.
  `00-antipatterns.md` — индекс «тема → правило», грузится в `apps/**` и `packages/**`.
- **Эта статья** — причина запрета, что ломается и срезы с командой проверки.

## Бэкенд

| Антипаттерн | Что ломается | Правило |
|---|---|---|
| `@Body() body: unknown` | `ValidationPipe` не знает тип: в сервис приходит любой JSON, проверки `class-validator` молча пропускаются | `04-type-safety`, `05-security` |
| Новый агент без `registerQueueAgent()` | Агент есть в модуле, но `AgentInvokerService` о нём не знает — вызов молча не доходит | `13-agents-mcp` |
| Клиент создаётся лениво в поле сервиса | Два параллельных запроса создают два клиента, состояние синглтона гоняется | `02-backend` |
| Голый `fetch()` | Нет таймаута, повторов, circuit breaker и срезания адреса в логах (`redactUrlForLog`) | `02-backend` |
| `FileInterceptor` без `@UploadPolicy` | Проверен только размер. Глобальный `UploadPolicyInterceptor` закрыт по умолчанию и отклонит эндпоинт. `file.mimetype` присылает клиент, а SVG, отданный inline, — stored XSS | `05-security` |
| MCP-ключ в query | Адрес с ключом оседает в логах nginx и прокси | `05-security`, `13-agents-mcp` |
| HMAC через `===` | Время сравнения выдаёт совпавший префикс подписи (timing attack) | `04-type-safety`, `05-security` |
| `$transaction(callback)` без `{timeout, maxWait}` | При взаимной блокировке транзакция висит и держит соединение пула | `08-database-prisma` |
| `findMany` без `take` или больше 100 | Память процесса растёт с данными. Большие выборки — курсором | `08-database-prisma` |
| `await rows.map(async …)` | N последовательных запросов вместо одного batch (N+1) | `08-database-prisma`, `01-base` |
| Вставка в ClickHouse без Zod | Строка с чужой схемой уходит в ReplacingMergeTree и всплывает в отчётах | `04-type-safety` |
| Обход Redis-адаптера Socket.io | При двух подах и больше событие не доходит до клиента на соседнем поде | `14-realtime` |
| SSE без heartbeat | Прокси рвёт соединение через 30–60 с. Heartbeat — каждые 25 с | `14-realtime` |
| Второй GramJS-клиент на тот же auth key при живом SM | `406 AUTH_KEY_DUPLICATED` и шторм переподключений у обоих владельцев | `16-telegram` (№1) |
| 406 считается «сессия недействительна» | Форс-релогин вместо разрешения конфликта владения | `16-telegram` (№1) |
| Потерян `parse_mode` на любом пути отправки | Получатель видит сырые теги | `16-telegram` (№2) |
| `getEntity` на свежем SM-клиенте без прогрева | «Пир не найден»: `StringSession` не хранит кэш сущностей | `16-telegram` (№3) |
| Outbox: `findMany` по статусу | Несколько подов берут одни записи — двойная обработка. Нужен `FOR UPDATE SKIP LOCKED` | `08-database-prisma`, `14-realtime` |
| `void redis.*` без `.catch` | Необработанный reject: ошибка теряется или роняет процесс | `09-cache-redis` |
| `process.env` вне `config/` | Конфиг без схемы и значений по умолчанию, тесты его не подменяют | `02-backend`, `04-type-safety` |

## Фронтенд

| Антипаттерн | Что ломается | Правило |
|---|---|---|
| `dangerouslySetInnerHTML` без DOMPurify | XSS из HTML сервера или пользователя | `03-frontend`, `05-security` |
| Новый объект в `value` у `Context.Provider` | Каждый рендер провайдера перерисовывает всех потребителей | `03-frontend` |
| Статический импорт `exceljs`, `pdfjs-dist`, `mammoth` в entry-чанк | Сотни КБ в главном бандле, холодный старт на 3G. Внутри компонента под `lazy()` со своим чанком импорт допустим. Проверка — `npm run bundle:check`, потолок entry 266 240 Б gzip | `03-frontend` |
| `shared/` импортирует из `features/` или `pages/` | Слой тянет вверх, `shared/` перестаёт быть переиспользуемым. Автоматически ловится только как цикл (`npm run deps:circular`); lint-зона есть лишь для `features/` → `pages/` (`eslint.config.js:73`) | `03-frontend` |
| Один `queryKey` для разных параметров | Два запроса делят кэш React Query и затирают друг друга | `03-frontend` |
| `exhaustive-deps: off`, `noUnusedLocals: false` глобально | Прячет устаревшие замыкания и мёртвый код | `03-frontend` |
| Список больше 50 элементов без виртуализации | DOM растёт с данными, на слабом Android прокрутка рвётся | `03-frontend` |
| `${var}` в `defaultValue` у i18next | Экстрактор пропускает шаблоны с `${…}` (`scripts/lib/extractTranslationDefaults.mjs`): строка не попадает в RU-бандл и локали, её нельзя перевести. До 2026-09-21 плейсхолдер был виден буквально, а соседний ключ получал чужой текст | `03-frontend` (§`${var}`) |

## Размер кода (срез 2026-10-30)

Лимиты — `01-base` и `03-frontend`:

| Что | Лимит |
|---|---|
| Сервис | 300 строк |
| Метод | 80–100 строк |
| Компонент или хук | 500 строк |
| Хук, после которого выносятся sub-hooks | 200 строк |
| Страница | 400 строк |

- Сервисов бэкенда длиннее 300 строк — **120**.
- Крупнейшие:

  | Сервис | Строк |
  |---|---|
  | `agents/agent-invoker-bootstrap.service.ts` | 946 |
  | `integrations/telegram/telegram-mtproto-pool.service.ts` | 733 |
  | `integrations/telegram/telegram-cache.service.ts` | 711 |
  | `onboarding/onboarding-instance.service.ts` | 702 |
  | `wiki/wiki.service.ts` | 611 |

- Проверка: `find apps/backend/src -name '*.service.ts' | xargs wc -l | awk '$2!="total" && $1>300' | wc -l`.

## Зависимости и `npm audit` (срез 2026-10-30)

- **`npm audit --json` → 43 находки:** 3 critical, 16 high, 17 moderate, 7 low.
  - Critical: `dompurify`, `vitest`, `tinypool`.
  - High, в том числе: `multer`, `@nestjs/platform-express`, `body-parser`, `prisma`, `zod`, `undici`, `nodemailer`,
    `pdfjs-dist`, `minio`.
  - Порядок исправлений — отдельной задачей.
- **Блокирующего шага `npm audit` в CI нет:** `grep -l "npm audit" .github/workflows/*` ничего не находит. Порядок из
  `05-security`: сначала снизить остаток, потом гейт `--audit-level=high`. Гейт, красный с рождения, научит его
  игнорировать.
- **`exceljs` и `uuid`** (moderate): `npm audit` предлагает даунгрейд `exceljs` до 3.4.0 с мажорной сменой версии.
  Не делаем.
- **Закрыто:**
  - `speakeasy` не установлен, 2FA работает на `otpauth` ^9.5.1 (`apps/backend/src/modules/accounts/totp.util.ts`);
  - `lru-cache` у бэкенда 11.5.3. Корневая копия 5.1.1 — транзитивная build-time зависимость чужого пакета, нашим
    кодом не резолвится.

**Связи:** индекс правил — `.claude/rules/00-antipatterns.md` · закон безопасности — `.claude/rules/05-security.md` ·
конвенции фронтенда — [`frontend/conventions.md`](frontend/conventions.md)
