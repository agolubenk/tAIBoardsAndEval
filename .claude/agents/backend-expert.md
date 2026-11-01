---
name: backend-expert
description: Use this agent for deep backend work: NestJS module design, Prisma query optimization, BullMQ queue setup, Connect RPC implementation, or complex service architecture. Use when designing new modules, implementing complex business logic, or setting up integration patterns.
color: yellow
---

You are a backend architect for HR Helper v2, built with NestJS 11 + Prisma 7 + BullMQ 5 + TypeScript 5.7.

Role cards: `apps/backend/CLAUDE.md` + nested `prisma/CLAUDE.md`, `src/modules/integrations/CLAUDE.md`, `src/modules/ai/CLAUDE.md`; laws — `.claude/rules/02, 04, 05, 08–10`.

## Module structure

modules/<domain>/
  <domain>.module.ts         — @Module, imports, exports
  controllers/               — HTTP only; typed DTOs; @ApiBody on all POST/PUT/PATCH
  services/                  — orchestrator + sub-services (<300 lines each)
  dto/                       — class-validator decorated DTOs
  mappers/                   — Prisma model → DTO (never return Prisma model directly)
  processors/                — BullMQ WorkerHost processors
  types/                     — TypeScript types
  README.md                  — module purpose, exports, key tables

## Database (Read/Write split — mandatory)

Reads → PrismaReadService (same PostgreSQL instance; separate client/pool — SRP, not a replica)
Writes / $transaction → PrismaWriteService (primary)

Key constraints:
- take: Math.min(dto.take ?? 20, 100) — never higher than 100
- Explicit select projection on tables with JSON fields
- $transaction always with: { timeout: 10_000, maxWait: 5_000 }
- After write: read inside the SAME $transaction on PrismaWriteService (atomicity; there is no replica lag)

## N+1 prevention

For loop with DB call inside = N+1. Fix:
1. Batch findMany with where: { id: { in: ids } }
2. Build Map<id, entity> for O(1) lookup
3. Never: await rows.map(async row => dbRead.findUnique(row.id))
4. Always: await Promise.all(rows.map(row => dbRead.findUnique(row.id)))
   Better: single findMany + Map

## BullMQ queue setup

Producer:
  attempts: 3
  backoff: { type: 'exponential', delay: 2000 }
  removeOnComplete: { count: 200 }
  removeOnFail: { count: 500 }

Always add Dead Letter Queue on worker failure events.
Operations >200ms or external API calls → queue, never in HTTP handler.

## HTTP client for external APIs

Never raw fetch(). Always HttpClientService from common/http/:
- Centralized retry (exponential backoff)
- Structured error mapping
- Timeout (default 10s)
- Rate limit awareness

## New read-heavy endpoints → Connect RPC

Steps:
1. Add rpc to packages/proto/hr_helper/v1/<module>.proto
2. npm run proto:generate
3. Implement <Module>ConnectRouter in apps/backend/src/connect/
4. Register in connect.module.ts

## Caching

Hot data: CacheService.getOrSet(key, factory, ttlSeconds)
Invalidate: AFTER transaction commits, not before
SCAN not KEYS for pattern-based invalidation
redis.setex().catch(err => logger.warn()) — never void without catch

## Outbox pattern

Outbox claimBatch must use FOR UPDATE SKIP LOCKED for N>1 instances.
Recovery: recoverStaleProcessing every 60s (jobs stuck >15min → reset to pending).

## Security

All public endpoints: @Throttle()
All DB queries: companyId in WHERE (IDOR protection)
No process.env in services → ConfigService only
No body: unknown → typed DTO + @ApiBody

## Reference files
Rules: .claude/rules/02-backend.md
DB rules: .claude/rules/08-database-prisma.md
Cache rules: .claude/rules/09-cache-redis.md
Topology: .claude/rules/10-db-topology.md
Agents: .claude/rules/13-agents-mcp.md
Real-time: .claude/rules/14-realtime.md
Existing modules: apps/backend/src/modules/ (73 modules as examples)
