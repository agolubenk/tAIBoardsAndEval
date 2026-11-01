---
paths:
  - apps/backend/src/modules/integrations/hh/**
  - apps/frontend/src/**/hh/**
  - docs/api/**
---

# hh.ru / rabota.by — интеграция

## Спека

- `docs/api/hh-openapi-spec.yml` — HeadHunter API (OAuth2, employer, negotiations, resumes)
- `docs/api/README.md` — карта + статус реализации

## Код

- `apps/backend/src/modules/integrations/hh/`
- Tenant: `/integrations/hh/*`
- Platform OAuth app: `/platform/settings/hh`
- Company: `/company-settings/integrations/hh`
- Frontend: `/integrations/hh`

## Правила (кратко)

1. Все HH HTTP — через `hh-remote.util.ts`; region из `hh-integration.constants.ts`.
2. Обязателен `User-Agent` / `HH-User-Agent` (иначе 400 у HH).
3. OAuth secrets encrypted; platform secret не возвращать в GET.
4. Scan/import — очередь `hh-sync`; daily limit 400 imports/company/day.
5. rabota.by — отдельные auth/api base; alias через `HhAliasResolverService`.
6. **INT-JB-1** (расширение employer API) и HH Salary Bank OAuth — открытые хвосты, не MVP.
