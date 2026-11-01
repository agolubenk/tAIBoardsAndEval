# Recruiting — кандидаты, вакансии, интеграции ATS

> Тонкий чанк-роутер: детали живут в reference/specs/rules — грузить только нужный срез.

## Куда смотреть

| Что нужно | Файл |
|---|---|
| Prisma-модели домена | `docs/architecture/reference/prisma-models.md` · RAG: `--type prisma_model` |
| REST-роуты и API-карта | `docs/architecture/reference/frontend-api-map.md`, `frontend-routes.md` · RAG: `--type api_route` |
| Backend-модули | `docs/architecture/reference/backend-modules.md` |
| Доменная модель | `docs/architecture/reference/domains.md`, `docs/specs/sourcing-module.md`, `recruiting-analytics-rework.md`, `resume-parsing-llm.md` |
| Huntflow | `.claude/rules/11-integrations-huntflow.md` + `docs/api/huntflow-openapi-spec.json` + `HUNTFLOW_INTEGRATION_TOKENS_DATA_SYNC.md` |
| hh.ru / rabota.by | `.claude/rules/12-integrations-hh.md` + `docs/api/hh-openapi-spec.yml` |

## Ключевые правила домена

- Candidates/vacancies read-path — через Connect RPC (`candidates.proto`, `vacancies.proto`, `applications.proto`); новые read-heavy эндпоинты не в REST
- Huntflow: все HTTP в `*-remote.util.ts`; один refresh + один retry на 401; bulk import → BullMQ `huntflow-migration`; **лимит 400 imports/company/day** (Redis-counter `hf:import:{companyId}:{YYYY-MM-DD}`)
- hh.ru: все HTTP через `hh-remote.util.ts`; обязателен `User-Agent`/`HH-User-Agent` (иначе 400); rabota.by — отдельные auth/api base через `HhAliasResolverService`; scan/import — очередь `hh-sync`, daily limit 400
- Резюме → MinIO + очередь `resume-parse`
- Кэш списков вакансий: `vac:list:{companyId}:{userId}` TTL 30s; инвалидация после мутации
