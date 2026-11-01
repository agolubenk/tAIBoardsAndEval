---
description: Use when working with NestJS services, modules, controllers, DTOs, guards, pipes, interceptors, Prisma access, and backend tests (vitest).
---

# NestJS Service

Project rules come first: the root CLAUDE.md «Never»/«Always» lists (typed DTO, `HttpClientService`, `$transaction` with `{timeout, maxWait}`, `take` ≤ 100, `PrismaReadService` for SELECT, config only via `ConfigService`) and `apps/backend/CLAUDE.md`.

- Follow the module architecture, validate DTOs with class-validator, raise typed exceptions, and put auth in guards.

## Before designing

- A feature area described as "not built yet" or "a placeholder" — in docs, a backlog snapshot, even the task brief — may already exist. Run `git log --oneline -- <module dir>` and grep `schema.prisma` for its models before designing new schema or services.
- When a locally installed package behaves differently from its documentation, read its source in `node_modules` after the first failed hypothesis, not the fifth: the code that runs is the specification.

## Two validation layers

- When a controller DTO (class-validator) mirrors a Zod schema validated in the service, a field added to the schema is added to the DTO in the same PR, and every such pair has a parity spec. Drift is silent until a user gets a 400: the global ValidationPipe runs with `whitelist` and `forbidNonWhitelisted`.

## Tests under vitest

- vitest/esbuild emits no decorator metadata, so the global ValidationPipe and constructor injection do not run in HTTP tests. Assert body strictness at the Zod/schema layer, or use the unplugin-swc setup for that suite.
- `afterEach(vi.restoreAllMocks)` wipes module-level `vi.fn().mockReturnValue(...)`. Shared fixtures that must survive are plain functions; per-test mock behaviour goes in `beforeEach` or a factory.
- On the first red run, a new test and the code it tests are both unproven. Check whether the assertion encodes the invariant (ordering, monotonicity, provenance) or merely the size of the fixture before changing the code.
