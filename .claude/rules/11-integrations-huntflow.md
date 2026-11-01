---
paths:
  - apps/backend/src/modules/integrations/huntflow/**
  - apps/frontend/src/**/huntflow/**
  - docs/api/**
---

# Huntflow — интеграция

## Спеки

| Документ | Назначение |
|----------|------------|
| `docs/api/huntflow-openapi-spec.json` | HTTP API Huntflow v2 |
| `docs/api/HUNTFLOW_INTEGRATION_TOKENS_DATA_SYNC.md` | Токены, refresh, sync, безопасность (канон продукта) |
| `docs/api/README.md` | Карта файлов + пути кода |

## Код

- `apps/backend/src/modules/integrations/huntflow/`
- Company: `/company-settings/integrations/huntflow`
- User tokens: `/accounts/profile/huntflow-*`
- Migration: `/company-settings/integrations/huntflow/migration/runs`

## Правила (кратко)

1. Endpoint — из OpenAPI; токены/401 — из `HUNTFLOW_INTEGRATION_TOKENS_DATA_SYNC.md`.
2. HTTP в `*-remote.util.ts`; один refresh + один retry на 401.
3. Bulk import → BullMQ `huntflow-migration`; резюме → MinIO + `resume-parse`.
4. Sync (view/workflow) отдельно от migration run.
5. Секреты не в логах и не в JSON ответах API.
6. `INT-ERP-2` (полный bidirectional) — не реализован; есть MVP sync + ATS→HF feedback.
