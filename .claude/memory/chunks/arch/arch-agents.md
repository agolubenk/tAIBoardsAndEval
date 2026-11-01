# Агенты и MCP

> Источник: бывший `CLAUDE.md §Агенты и MCP`. Детали: `.claude/rules/13-agents-mcp.md` (грузится по paths) · канон: `docs/agents/ARCHITECTURE.md` + `CATALOG.md`.

**Архитектура:** Trigger → `AgentsTriggerService` → `AgentInvokerService` → `AgentQueueService` (BullMQ) → `AgentProcessor` → `BaseAgent.run()`

## Регистрация агента — 4 шага (обязательно)

1. `class extends BaseAgent<TPayload, TResult>`
2. `get agentKey()` → `AGENT_NAMES.X`
3. `AGENT_NAMES.X` в `agent-registry.constants.ts`
4. `registerQueueAgent()` в `agent-invoker-bootstrap.service.ts` ← **пропустить = агент молча не работает**

## MCP

- Bearer header только; никаких API key в query param (попадают в access logs)
- Инструменты через `Map<string, handler>`
- Ключи `McpApiKey`/`PluginOAuthClient` — хранить только хэш (sha256/bcrypt), plaintext показывать один раз при создании

## HITL

- `approvalDeadlineAt` обязателен при `requiresApproval`; scheduler проверяет истёкшие
- MCP и Extension каналы НЕ получают bypass: тот же `AutomationRunLog` со статусом `PENDING_APPROVAL`, что и UI/чат — единая точка контроля

## AI-модели (актуальные)

`claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`

## Известные особенности (см. memory)

- `invoke()` — fire-and-forget; событийные триггеры вне onboarding — гэп (AGT-EVT в BACKLOG)
- Уведомления агентов — напрямую через `NotificationsService` (в `_legacy` mail — дубль-ловушка)
