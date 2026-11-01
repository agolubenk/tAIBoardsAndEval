---
paths:
  - apps/backend/src/modules/agents/**
  - apps/backend/src/modules/mcp/**
  - apps/backend/src/modules/hitl/**
  - apps/backend/src/modules/ai/**
  - apps/backend/src/modules/agent-registry/**
---

# Agents, MCP & Workflow

## Архитектура агент-слоя

```
Trigger (HTTP / Event / Scheduler / MCP Tool)
  └─> AgentsTriggerService       # проверяет enabled + trustLevel
        └─> AgentInvokerService  # реестр диспетчеров (Map<agentKey, dispatcher>)
              └─> AgentQueueService → BullMQ Job
                    └─> AgentProcessor (WorkerHost)
                          └─> ConcreteAgent.run(payload, ctx)
                                ├── AgentMemoryService (Redis hot + Prisma cold)
                                ├── AgentRunLogService (audit trail)
                                └── AgentHitlService (approval gate)
```

## Регистрация нового агента — обязательный чеклист

❌ Создать класс сервиса → провести в AgentsModule → ЗАБЫТЬ зарегистрировать в bootstrap = агент недостижим через invoker.

✅ При добавлении любого нового агента обязательно:

1. **Создать** `modules/agents/<name>/<name>-agent.service.ts` extends BaseAgent
2. **Добавить** в `AgentsModule` providers + exports
3. **Зарегистрировать** в `agent-invoker-bootstrap.service.ts`:

```typescript
// agent-invoker-bootstrap.service.ts
constructor(
  // ...
  private readonly newAgentQueue: NewAgentQueueService,
) {}

protected async onBootstrap(): Promise<void> {
  // ... existing registrations ...
  this.registerQueueAgent(
    AGENT_NAMES.NEW_AGENT_KEY,
    (p) => this.newAgentQueue.schedule(p as NewAgentJobPayload)
  )
}
```

4. **Добавить** `AGENT_NAMES.NEW_AGENT_KEY` в `agent-registry.constants.ts`
5. **Добавить** запись в `AgentRegistryEntry` таблицу (миграция или seed)

## BaseAgent — обязательный абстрактный класс

Каждый агент ОБЯЗАН наследоваться от `BaseAgent`, иначе нет гарантии HITL + RunLog + enabled-check.

```typescript
// common/agents/base-agent.ts
export abstract class BaseAgent<TPayload, TResult> {
  constructor(
    protected readonly registry: AgentRegistryService,
    protected readonly runLog: AgentRunLogService,
    protected readonly hitl: AgentHitlService,
    protected readonly logger: Logger,
  ) {}

  abstract get agentKey(): string
  abstract runImpl(payload: TPayload, ctx: AgentInvocationContext): Promise<TResult>

  async run(payload: TPayload, ctx: AgentInvocationContext): Promise<TResult> {
    await this.registry.assertEnabled(this.agentKey, ctx.companyId)
    const runId = await this.runLog.start(this.agentKey, ctx)
    try {
      if (await this.hitl.requiresApproval(this.agentKey, payload, ctx)) {
        await this.hitl.requestApproval(runId, payload, ctx)
        return null as TResult  // job suspended, resumes after approval
      }
      const result = await this.runImpl(payload, ctx)
      await this.runLog.success(runId, result)
      return result
    } catch (e) {
      await this.runLog.error(runId, e)
      throw e
    }
  }
}
```

## AI Providers — оба должны реализовывать chatStream()

❌ Сейчас: `ClaudeProvider` не имеет `chatStream()` → стриминг работает только при OpenAI
✅ Обязательно добавить в `claude.provider.ts`:

```typescript
async *chatStream(apiKey: string, model: string, messages: AiMessage[]): AsyncGenerator<string> {
  const client = new Anthropic({ apiKey })
  const stream = client.messages.stream({ model, messages, max_tokens: 8192 })
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
      yield chunk.delta.text
    }
  }
}
```

## Актуальный список моделей (обновлять при релизах Anthropic/OpenAI)

```typescript
// claude.provider.ts — актуальные модели на 2026-06-27
export const CLAUDE_MODELS = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
] as const

// openai.provider.ts
export const OPENAI_MODELS = [
  'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'
] as const
```

## AI Provider выбор — retry перед fallback

```typescript
// ai-execution-layer.service.ts — добавить transient retry
async execute(req: AiRequest): Promise<AiResponse> {
  for (const provider of [this.primary, ...this.fallbacks]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await provider.chat(req)
      } catch (e) {
        const isRateLimit = e.status === 429
        if (isRateLimit && attempt === 0) {
          const retryAfter = parseInt(e.headers?.['retry-after'] ?? '2', 10)
          await sleep(retryAfter * 1000)
          continue
        }
        break  // move to next provider
      }
    }
  }
  throw new ServiceUnavailableException('All AI providers failed')
}
```

## HITL — обязательный timeout + эскалация

❌ Сейчас: `PENDING_APPROVAL` статус без deadline → агент ждёт бесконечно

```typescript
// Добавить в schema.prisma
model AgentHitlAction {
  // ...
  approvalDeadlineAt DateTime?
}

// hitl.service.ts — установить deadline при создании
await this.db.agentHitlAction.create({
  data: {
    ...dto,
    approvalDeadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h
  }
})

// Добавить scheduler (каждые 5 минут)
@Cron('*/5 * * * *')
async escalateExpiredApprovals() {
  const expired = await this.db.agentHitlAction.findMany({
    where: { status: 'PENDING_APPROVAL', approvalDeadlineAt: { lt: new Date() } }
  })
  for (const action of expired) {
    await this.escalate(action)  // notify manager + optionally auto-reject
  }
}
```

## Workflow Engine — параллельные шаги

❌ Сейчас: все шаги sequential даже если независимы → лишнее время
✅ Определить зависимости между шагами, запускать независимые параллельно:

```typescript
// workflow-engine-agent.service.ts
async executeWorkflow(workflowDef: WorkflowDefinition, ctx: AgentInvocationContext) {
  const { independent, dependencyChain } = analyzeStepDependencies(workflowDef.steps)
  
  // Запустить независимые параллельно
  await Promise.all(independent.map(step => this.dispatchStep(step, ctx)))
  
  // Затем последовательные с зависимостями
  for (const step of dependencyChain) {
    await this.dispatchStep(step, ctx)
  }
}
```

## Workflow — checkpoint persistence

❌ Сейчас: перезапуск worker = workflow начинается заново
✅ Сохранять выполненные шаги:

```typescript
// При старте workflow job — проверить checkpoint
const completed = await this.getCompletedSteps(workflowRunId)
for (const step of workflow.steps) {
  if (completed.has(step.id)) continue  // пропустить завершённый
  await this.dispatchStep(step, ctx)
  await this.markStepCompleted(workflowRunId, step.id)
}
```

## Data Extraction Agent — структурированный вывод

❌ Сейчас: ненадёжный regex `/\{[\s\S]*\}/` на AI-ответ — захватывает лишнее JSON
✅ Использовать tagged output или Anthropic tool_use:

```typescript
// Вариант 1: tagged output
const systemPrompt = `Return extracted data wrapped in <json>...</json> tags. No text outside tags.`
const jsonMatch = response.match(/<json>([\s\S]*?)<\/json>/)
const extracted = ExtractionSchema.parse(JSON.parse(jsonMatch![1]))

// Вариант 2: Anthropic tool_use (рекомендуется)
const response = await client.messages.create({
  tools: [{ name: 'extract', input_schema: ExtractionSchema }],
  tool_choice: { type: 'tool', name: 'extract' }
})
const extracted = ExtractionSchema.parse(response.content[0].input)
```

## MCP — правила безопасности

```typescript
// ❌ ЗАПРЕЩЕНО — API key в query param попадает в access logs
const key = req.query.apiKey  // mcp-auth.guard.ts:72-74

// ✅ Только Authorization: Bearer header
const key = req.headers.authorization?.replace('Bearer ', '')

// SSE соединение: использовать одноразовый ticket из Redis (уже реализовано правильно)
// POST /mcp/sse-ticket → { ticket } → GET /mcp/sse?ticket=<one-time>
```

## MCP Tool Executor — type-safe dispatch

```typescript
// ❌ switch/case из 25+ ветвей без exhaustive check
switch (toolName) {
  case 'candidate_search': ...
  case 'vacancy_list': ...
  // забыть добавить новый tool — нет ошибки компиляции
}

// ✅ Map-based с compile-time completeness
const TOOL_HANDLERS = {
  candidate_search: (args: unknown) => this.candidates.search(CandidateSearchSchema.parse(args)),
  vacancy_list: (args: unknown) => this.vacancies.list(VacancyListSchema.parse(args)),
  // TypeScript: Record<ToolName, ToolHandler> — ошибка если ToolName не покрыт
} satisfies Record<ToolName, ToolHandler>
```

## Agent Memory — атомарный flush

```typescript
// ❌ Race condition при параллельных saveMemory() вызовах
const count = await this.redis.incr(countKey)  // не атомарно с flush-решением

// ✅ Lua script для атомарного инкремента и проверки порога
const luaScript = `
  local count = redis.call('INCR', KEYS[1])
  if count >= tonumber(ARGV[1]) then
    redis.call('DEL', KEYS[1])
    return 1  -- flush needed
  end
  return 0
`
const needsFlush = await this.redis.eval(luaScript, 1, countKey, FLUSH_THRESHOLD)
```

## Distributed traceId

При создании нового AgentInvocationContext (первый вызов в цепочке):

```typescript
// agent-invoker.types.ts
export interface AgentInvocationContext {
  companyId: string
  userId: string
  callerAgentKey?: string
  parentRunId?: string
  traceId: string  // UUID, создаётся единожды, пробрасывается во всю цепочку
}

// При invoke нового агента из агента — передавать traceId из родительского ctx
const childCtx: AgentInvocationContext = {
  ...ctx,
  callerAgentKey: this.agentKey,
  parentRunId: currentRunId,
  traceId: ctx.traceId,  // НЕ создавать новый
}
```
