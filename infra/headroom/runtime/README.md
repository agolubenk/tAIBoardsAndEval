# Headroom runtime — сжатие контекста AI-задач (T-291)

Контейнер `headroom-runtime` (compose-профиль `headroom`, `infra/docker/docker-compose.yml`) для
`AiContextCompressionService` backend'а. Пилот — `wiki_ask` (Wiki RAG). Не путать с контуром разработчика
(`../developer/README.md`).

## Как устроено

- Сжатие вызывает `AiTaskOrchestratorService` для пилотных задач. Системные сообщения в runtime не уходят и не
  сжимаются.
- `shadow` (по умолчанию) — сжатие считается параллельно вызову, провайдеру уходит оригинал, ответ не ждёт.
- `enforce` — провайдеру уходит сжатый текст, если сохранились все защищённые значения (UUID, даты, числа и суммы,
  цитаты `[n]`, email, URL) и форма сообщений. Иначе — оригинал. Ответ ждёт runtime не дольше
  `AI_CONTEXT_COMPRESSION_TIMEOUT_MS`.
- Любой сбой (таймаут, 4xx/5xx, разомкнутый breaker `HeadroomRuntimeCircuit`: 5 сбоев → пауза 30 с) — провайдеру
  уходит оригинал. Вызов задачи из-за сжатия не падает никогда.
- Не сжимаются ни при каком env: оценка встреч, переходы по статусам, оффер и отказ, юридические сценарии
  (`AI_CONTEXT_COMPRESSION_EXCLUDED_TASKS`), задачи с классификацией `restricted` (T-290), контекст короче
  `AI_CONTEXT_COMPRESSION_MIN_CHARS`, сообщения с изображениями и файлами, вызовы без `companyId`.

## Включить (локальный стек)

Переменные — в `infra/docker/.env` (в git не попадает) или в окружении shell. Токен один на оба конца.

```bash
# 1. Токен и адрес; MODE не задан = shadow
echo "HEADROOM_RUNTIME_TOKEN=$(openssl rand -hex 32)" >> infra/docker/.env
echo "HEADROOM_RUNTIME_URL=http://headroom-runtime:8787" >> infra/docker/.env

# 2. Runtime: без токена контейнер не стартует
docker compose -f infra/docker/docker-compose.yml --profile headroom up -d headroom-runtime

# 3. Backend пересоздать, не restart: env читается при создании контейнера
docker compose -f infra/docker/docker-compose.yml up -d backend
```

Проверка:

- в логе backend при старте: `Сжатие контекста AI (T-291): режим shadow, задачи wiki_ask, runtime headroom-runtime:8787`;
  ошибка вместо неё — URL указывает на dev-прокси или внешний хост, либо не задан токен (сжатие остаётся выключенным);
- метрика `hr_helper_ai_context_compression_total{task,mode,outcome}`;
- аудит: `ai_task_audit_logs.metadata_json → contextCompression` — только числа и метки, без текста.

## Выключить без деплоя

`AI_CONTEXT_COMPRESSION_MODE=off` (или убрать `HEADROOM_RUNTIME_URL`) и пересоздать backend:
`docker compose -f infra/docker/docker-compose.yml up -d backend`. Остановка самого `headroom-runtime` тоже
безопасна: исход `unavailable`, провайдеру уходит оригинал. Сузить пилот — `AI_CONTEXT_COMPRESSION_TASKS`
(`none` — ни одной задачи).

## Исходы в метрике и аудите

| outcome | что значит | что делать |
|---|---|---|
| `compressed` | сжатие принято (в `enforce` — ушло провайдеру) | — |
| `no_gain` | токенов не стало меньше | норма для прозы, см. замер ниже |
| `lost_protected` | пропало защищённое значение — ушёл оригинал | норма; доля растёт → не включать `enforce` |
| `shape_mismatch` | изменились число или роли сообщений | баг runtime, ушёл оригинал |
| `short` / `multimodal` / `restricted` / `invalid_context` | в runtime не отправляли | — |
| `skipped` | Headroom пропустил сжатие (`skipReason`, напр. `compression_timeout`) | частые таймауты → поднять `TIMEOUT_MS` или ресурсы |
| `unauthorized` | 401: токен backend ≠ токену контейнера | выровнять `HEADROOM_RUNTIME_TOKEN`, пересоздать оба |
| `not_found` | 404: `/v1/compress` закрыт для не-loopback | нет `HEADROOM_COMPRESS_ALLOW_REMOTE=1` у контейнера или неверный URL |
| `http_error` | иной не-2xx (503 — сбой сжатия) | смотреть лог контейнера; тело ответа backend не читает (там может быть фрагмент текста) |
| `invalid_response` | ответ не JSON или неожиданной формы | версия образа сменилась? образ закреплён по digest |
| `unavailable` | таймаут, сеть или открытый breaker | контейнер жив? `docker compose ps headroom-runtime` |
| `internal_error` | исключение в нашем коде | в логе backend только имя ошибки — воспроизводить на синтетике |

## Замер и почему `shadow`

Синтетика, образ по digest из compose, запросы из контейнера backend по docker-сети (2026-10-01):

| вход | токены | преобразование | задержка |
|---|---|---|---|
| проза (русский HR-текст) | 697 → 697 (0 %) | `router:noop` | ~20 мс |
| JSON-массив из 80 записей | 1773 → 1147 (−35 %) | `router:smart_crusher` | ~20 мс |
| первый запрос после старта контейнера | — | ленивая инициализация | ~6 с |

Прозу конвейер без Kompress не сжимает, а контекст Wiki RAG — в основном проза: от пилота A ждём в основном
`no_gain`. Выигрыш — на JSON, таблицах и логах. Поэтому `shadow`: сначала метрика на реальном трафике, `enforce` —
только когда доля `compressed` и экономия того стоят. В `enforce` каждая пилотная задача ждёт runtime до
`TIMEOUT_MS`.

Повторный замер при переходе 0.34.0 → 0.41.0 (2026-10-15, `contract_check.py`, контейнер с env из compose,
запросы с хоста; другой текст, чем в таблице выше):

| вход | 0.34.0 | 0.41.0 |
|---|---|---|
| проза, 917 токенов | 917 → 917, `router:noop` | 917 → 917, `router:noop` |
| JSON из 80 записей, 3448 токенов | → 1726 (−50 %), все 80 UUID на месте | → 1705 (−51 %), все 80 UUID на месте |
| первый запрос после старта | 4045 мс | 134 мс |
| память после запросов | 454 МиБ | 272 МиБ |
| чужой токен | 401 | 401 |

У 0.41.0 первый запрос укладывается в `TIMEOUT_MS` — одиночного `unavailable` после старта больше нет.

## Обновление образа

Образ закреплён по digest мультиархитектурного индекса (подходит и для arm64 Mac, и для amd64 VPS). Перед сменой:

```bash
TOK=$(openssl rand -hex 16)
docker run -d --rm --name hr-runtime-test -p 127.0.0.1:8798:8787 --entrypoint sh \
  -e HEADROOM_PROXY_TOKEN="$TOK" -e HEADROOM_COMPRESS_ALLOW_REMOTE=1 -e HEADROOM_STATELESS=1 -e HEADROOM_OFFLINE=1 \
  -e HEADROOM_SKIP_UPSTREAM_CHECK=1 -e HEADROOM_BEACON=off -e HEADROOM_TELEMETRY=off -e DO_NOT_TRACK=1 \
  -e HEADROOM_DISABLE_KOMPRESS=1 -e HEADROOM_DISABLE_KOMPRESS_FALLBACK=1 -e HEADROOM_WORKSPACE_DIR=/home/nonroot/.headroom \
  --tmpfs /home/nonroot/.headroom --cap-drop ALL --security-opt no-new-privileges:true \
  ghcr.io/headroomlabs-ai/headroom@sha256:<новый digest> -c 'exec headroom proxy --host 0.0.0.0 --port 8787'
python3 infra/headroom/runtime/contract_check.py http://127.0.0.1:8798 "$TOK" <версия>
docker stop hr-runtime-test
```

Проходит, если: все ответы `схема OK` (та же проверка, что `CompressResponseSchema` в backend), проза не теряет
текст, все UUID в JSON на месте, чужой токен → 401. Затем — digest в `infra/docker/docker-compose.yml` и строка в
таблице замеров выше.

## Данные и изоляция

- Без состояния: `HEADROOM_STATELESS=1`; режим CCR backend не запрашивает, конвейер по умолчанию его не включает.
  Рабочий каталог — tmpfs: фрагменты текста не переживают рестарт. Поэтому tmpfs, а не volume.
- Офлайн: телеметрия и маяк выключены. Проверка upstream выключена — иначе `/readyz` и `/health` шлют HEAD на
  `api.anthropic.com` раз в 30 с. Kompress выключен (ML-модель с загрузкой).
- Порт не публикуется, доступ только по docker-сети и только с токеном (`cap_drop: ALL`, `no-new-privileges`).
  Исходящий трафик сетью пока не запрещён: `internal: true` требует подключить backend ко второй сети, а это
  изменение prod-топологии — сделать вместе с prod-контейнером.
- Healthcheck — `/livez` (без авторизации и без обращений наружу).

## Prod

В prod-compose (`docker-compose.prod.yml`, `docker-compose.contabo.yml`) сервис не добавлен, профиль `headroom` в
`contabo-compose.sh` не включён. В prod backend получает только пустые `HEADROOM_*` / `AI_CONTEXT_COMPRESSION_*`, а
это значит «выключено». Prod-контейнер — отдельная подзадача T-291, только с ОК владельца: internal-сеть, ресурсы,
read-only rootfs, решение о `enforce` по данным `shadow`.
