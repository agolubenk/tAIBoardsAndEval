---
paths:
  - apps/backend/**
---

# Backend NestJS + Prisma

## Структура модуля

```
modules/<domain>/
  <domain>.module.ts
  controllers/     ← только HTTP; типизированные DTO; @ApiBody на каждом POST/PUT/PATCH
  services/        ← orchestrator + sub-services
  dto/
  mappers/         ← Prisma → DTO, не отдавать модель напрямую
  types/
```

## Контроллер

- Только typed DTO в `@Body()` — **НИКОГДА не `unknown`**
- `@ApiOperation`, `@ApiBody({ type: DtoClass })`, `@ApiResponse` на каждом endpoint
- `companyId` в WHERE (IDOR): `companyId_vacancyNumber`

## Сервис

- God Method → оркестратор + `*SectionsService` в `$transaction`
- `createMany` вместо цикла `create`
- Batch `findMany` + `Map` вместо N+1 в циклах
- **>300 строк** → декомпозиция (SRP)
- Запрет mutable singleton state — инициализировать в `onModuleInit`

## HTTP клиент — только через HttpClientService

❌ Прямой `fetch()` в сервисах (нет retry, timeout, structured error)
✅ Инжектировать `HttpClientService` из `common/http/`

```typescript
// common/http/http-client.service.ts (добавить если нет)
@Injectable()
export class HttpClientService {
  async get<T>(url: string, opts?: { timeout?: number; headers?: Record<string, string> }): Promise<T>
  async post<T>(url: string, body: unknown, opts?: { timeout?: number }): Promise<T>
}
// Внутри: retry (exponential backoff), timeout, structured error mapping
```

## AI-модули

Новый код в `modules/ai/`; провайдеры через `BaseAiProvider`.
Промпты: `prompts/templates/`. 
Все провайдеры обязаны реализовывать `chat()` И `chatStream()`.
Список актуальных моделей — в `.claude/rules/13-agents-mcp.md`.

## Агенты — обязательный чеклист при добавлении

1. Класс extends `BaseAgent`
2. Зарегистрирован в `agent-invoker-bootstrap.service.ts`
3. `AGENT_NAMES.X` добавлен в `agent-registry.constants.ts`
4. Запись в `AgentRegistryEntry`

Детали: `.claude/rules/13-agents-mcp.md`

## HITL — обязательные требования

- Поле `approvalDeadlineAt` обязательно при создании HITL-действия
- Scheduler проверки истёкших approval каждые 5 минут
- Единый `AutomationRunLog` для всех каналов (web/chat/MCP/extension)

## Notifications — не заглушки

```typescript
// ❌ ЗАПРЕЩЕНО — пустые методы
async sendInApp(params) { this.logger.log('...') }

// ✅ Реализовать полностью
// sendInApp → WebSocket broadcast (this.server.to('user:userId'))
// sendEmail → BullMQ queue
// sendTelegram → BullMQ queue
```

## Config

Только `ConfigService` в бизнес-логике. `process.env` — только в `config/*.ts`.
