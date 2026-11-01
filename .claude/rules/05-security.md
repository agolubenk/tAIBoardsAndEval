---
paths:
  - apps/backend/**
---

# Безопасность backend

## Обязательно (базовые)

- Публичные endpoints (без JWT) → `@Throttle()`
- Tenant isolation: `companyId` в каждом `where`
- Глобальный `ValidationPipe`: `whitelist`, `forbidNonWhitelisted`, `transform`
- `helmet()` + CORS из config
- Секреты и URL — `ConfigService`, не `process.env` в сервисах

## Валидация входных данных — НИКОГДА unknown

```typescript
// ❌ КРИТИЧНО — ValidationPipe не применяется к unknown, whitelist обходится
@Post()
create(@Body() body: unknown) { return this.service.create(body as any) }

// ✅ ОБЯЗАТЕЛЬНО
@Post()
@ApiBody({ type: CreateCandidateDto })
create(@Body() dto: CreateCandidateDto) { return this.service.create(dto) }
```

## MCP — запрет query param

```typescript
// ❌ API key в query param попадает в nginx/proxy access logs
// mcp-auth.guard.ts:72–74 — убрать fallback
const key = req.query.apiKey  // УДАЛИТЬ

// ✅ Только Authorization: Bearer
const auth = req.headers.authorization
if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException()
const key = auth.slice(7)
```

## HMAC подписи — timingSafeEqual

```typescript
// ❌ Timing attack
if (sig === computed) { ... }

// ✅
import { timingSafeEqual } from 'crypto'
const a = Buffer.from(received), b = Buffer.from(computed)
if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenException()
```

Применять: webhook receivers, API key validation, TOTP comparison.

## npm audit — блокирующий CI шаг

```yaml
# .github/workflows/security-scan.yml — добавить блокирующий шаг
- name: Security audit
  run: npm audit --audit-level=high
  # Не --audit-level=critical — high уже блокирует
```

Порядок: сначала снизить остаток до нуля high и critical, потом ставить гейт — красный с рождения гейт научит его
игнорировать. `npm audit fix --force` с мажорным даунгрейдом (`exceljs` → 3.4.0) не принимать. `speakeasy` и
`lru-cache` закрыты, в список не возвращать. Срез и причины — `docs/engineering/antipatterns.md`.

## XSS — DOMPurify (frontend security rule)

```tsx
// ❌ dangerouslySetInnerHTML без sanitize → XSS
// ✅ DOMPurify.sanitize() обязателен — см. .claude/rules/03-frontend.md
```

## Новые поверхности (MCP / Plugin API / Webhooks, Фазы D–E)

- API-ключи (`McpApiKey`, `PluginOAuthClient`) → хранить **только хэш** (sha256/bcrypt), plaintext показать один раз
- Webhook-доставка → `X-HrHelper-Signature` HMAC на каждый payload, получатель обязан проверять
- `requiresApproval`/`requiresHITL` → единый `AutomationRunLog` для всех каналов
- Детали: `phase-d.md` (git-история) §7`, `docs/plans/roadmap/phase-e.md §2–3`

## SSE auth — ticket pattern

Новый канал реалтайма — WS handshake-auth, не этот паттерн (B-64, канон + статус
миграции — `.claude/rules/14-realtime.md`). Ниже актуально для `/mcp/sse`
(постоянно) и оставшихся немигрированных SSE-каналов.

```typescript
// ❌ Bearer token в URL query param
GET /watch?token=eyJhbGciOiJIUzI1NiJ9...

// ✅ Одноразовый ticket (TTL 30s, Redis GETDEL)
POST /auth/sse-ticket → { ticket: 'uuid' }
GET /watch?ticket=<uuid>
```

## Приём файлов — только через `@UploadPolicy`

Любой эндпоинт с `FileInterceptor`/`FilesInterceptor` обязан объявить политику — **над**
`@UseInterceptors(...)`, а лимиты multer задавать через `uploadLimits()`:

```typescript
// ❌ Нет политики → глобальный UploadPolicyInterceptor отклонит multipart (415, fail-closed)
// ❌ @UploadPolicy НИЖЕ @UseInterceptors → проверка встанет раньше multer → тоже 500
// ❌ limits: { fileSize } без uploadLimits → fieldArrayIndexLimit = Infinity (GHSA-535w)
@Post('upload')
@UploadPolicy(UPLOAD_PRESETS.images(10 * 1024 * 1024))
@UseInterceptors(FileInterceptor('file', { limits: uploadLimits(10 * 1024 * 1024) }))
upload(@UploadedFile() file: Express.Multer.File) {}
```

Почему порядок: декораторы применяются снизу вверх, интерсептор проверки (`UploadPolicyCheckInterceptor`)
должен встать в цепочку **после** multer. До 2026-10-10 проверка жила в глобальном интерсепторе, который
Nest выполняет раньше интерсепторов метода: `req.file` был пуст, и с 2026-08-16 не проверялась ни одна
загрузка. Проводку всех эндпоинтов держит тест `common/upload/upload-policy.wiring.spec.ts`, порядок
во время запроса — сама проверка (тело не прочитано multer → 500).

Пресеты (`common/upload/upload-policy.decorator.ts`): `documents` (pdf/ooxml/legacy/rtf/text),
`images` (jpeg/png/gif/webp — **без SVG**), `tabular` (csv/xlsx), `media`, `attachments` (широкий набор).

Что проверяется **всегда**: размер · внешние OOXML-связи на сетевые адреса (http/UNC/`file://хост`; локальный
шаблон Word — не риск) с лимитами разбора zip · разметка (SVG/HTML) в разделах только для картинок и медиа.
Тип вне пресета, нераспознанный тип, разметка в документах и вложениях и расхождение содержимого с заявленным
MIME — отказ только при `UPLOAD_POLICY_STRICT_TYPES=true`, иначе предупреждение в лог
(«принято вне политики»): клиенты шлют то, чего нет в пресетах (картинки-резюме, ODF, видео в Telegram),
пресеты выравниваются по логу, затем строгий режим включается. Тип определяется **по сигнатуре**, а не по
расширению и не по `mimetype` клиента.

**SVG нет в `images` намеренно** — `<svg>` со скриптом, отданный `inline`, это stored XSS.

`bypassReason` — единственный законный обход, с обязательной причиной; пишется в лог на каждом запросе.

## Находишь баг/уязвимость прямо сейчас?

Фиксируй карточкой t-boards в «Ошибки» сразу (канон открытого, `.claude/rules/17-notion-board.md`) — не откладывай и не проходи мимо молча.
