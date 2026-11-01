---
description: Use when creating, running, verifying or reviewing database migrations with Prisma, or proving that a change does not touch the schema.
---

# Database Migration

Canon: `.claude/rules/08-database-prisma.md` (commands, `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, `take` ≤ 100) and the root CLAUDE.md Definition of Done: a change to `schema.prisma` needs an explicit plan and the owner's review before merge; migrations run only through CI/CD, never at runtime.

- Create migration files with Prisma Migrate, test data migrations before applying, and have a rollback for critical changes.

## Verify a committed migration, or prove a change is schema-inert

Prisma 7 removed `--from-schema-datamodel` / `--to-schema-datamodel`. A schema-to-schema diff that touches no database, run from `apps/backend`:

```bash
git show <sha>^:apps/backend/prisma/schema.prisma > /tmp/schema-before.prisma
git show <sha>:apps/backend/prisma/schema.prisma > /tmp/schema-after.prisma
npx prisma migrate diff --from-schema /tmp/schema-before.prisma --to-schema /tmp/schema-after.prisma --script
```

Compare the output with the committed `migration.sql`. Identical schemas print `-- This is an empty migration.` — use that to prove a refactor PR leaves the schema alone.

## Recipes rot

Command recipes pinned in rules break on tool major upgrades. Run a recipe once before relying on it, and date it when you write it down.
