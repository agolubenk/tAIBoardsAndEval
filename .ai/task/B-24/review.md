# Адверсариальное ревью — B-24

> Канон: `.continue/rules/06-adversarial-review.md`. Ревью — попытка сломать решение
> контрпримерами до ответа пользователю, не согласование. Автор не ревьюит себя.

## Материал

- **Что ревьюится:** диф (уже в `main`) по Notion-карточке B-24 «Безопасность файлового
  контура: гейт стоит в 4 точках из 15, единой точки контроля нет». Два коммита:
  - `0ec7c91f5` — единый слой политики приёма файлов (`@UploadPolicy` + fail-closed
    `UploadPolicyInterceptor`, `fileSignature.ts` детектор).
  - `0fdfbe2f4` + `69ab2e102` + `fdac710f0` (два последних — авто-коммиты пайплайна с
    сообщением «+», известная особенность, не находка сама по себе) — вторая половина:
    Content-Type объекта по сигнатуре при хранении, `Content-Disposition: attachment`
    на presigned-редиректах бинарных документов, безопасная отдача Telegram-медиа.
- **Файлы:** `packages/utils/src/files/fileSignature.ts` (+test),
  `apps/backend/src/modules/integrations/telegram/controllers/telegram-media-response.util.ts`
  (+spec), `apps/backend/src/common/upload/upload-policy.{decorator,interceptor}.ts`,
  `candidate-photos.service.ts`+`.controller.ts`, `candidate-resumes.service.ts`+`.controller.ts`,
  `hr-document-template.service.ts`, `hr-document-version.service.ts`,
  `hr-absence-attachments.service.ts`, `hr-pr-media.service.ts`,
  `hh-resume-photo.util.ts`, `telegram-messages.controller.ts`,
  `telegram-media-download.service.ts`, `TelegramMessageMedia.tsx`, `tgMediaBlobCache.ts`.
- **Вне скоупа (по решению владельца, не переоткрывается без нового факта):** выбор
  AV-сканера (отдельный пункт, ждёт замеров), не-HTTP пути приёма контента
  (Telegram-ingest не через этот контроллер, hh.ru/Huntflow import) — «уже разобраны
  отдельно как безопасные на практике». Ниже по hh.ru-фото поднят **новый** факт,
  узкоспециальный для файла `candidate-photos.service.ts`, — не пересчёт закрытого спора.
- **Условия задачи:** GOAL — единая точка контроля приёма (fail-closed) + безопасная
  отдача (Content-Type по содержимому, не по заявленному клиентом/отправителем значению).
- **Дата:** 2026-08-19

## Рецензент

- **Модель/роль:** `security-expert` subagent (Claude Sonnet 5), независимый ревьюер.
- **Независимость:** не автор правок — коммиты `0ec7c91f5`/`0fdfbe2f4`/`69ab2e102`/`fdac710f0`
  подписаны `Claude Opus 5 (1M context)` в паре с владельцем; я не участвовал в их создании.

## Протокол атаки

| # | Угол атаки | Результат |
|---|---|---|
| 1 | Границы (пустой буфер, polyglot, valid-signature-wrong-ext) | Смешанно — см. Находка 3 (buffer-absent = silent skip) и позитив ниже. Позитив: `fileSignature.test.ts` 40/40 (запущено `npx vitest run --root packages/utils fileSignature`) покрывает пустой буфер, PNG+HTML polyglot (`refineZip`/сигнатуры по приоритету), OLE2-под-видом-PNG, SVG-как-PNG, атрибут-only XSS-пейлоад классифицируется как `text`, не `html`. Пустой (0 байт) файл в интерсепторе: `size = file.size ?? buffer?.length ?? 0` проверяется **до** buffer-check (`upload-policy.interceptor.ts:85-90`) — 0 байт не содержит атаки, пропуск content-check для него не риск. Не проверено отдельно: polyglot конкретно ZIP(OOXML)+HTML в одном файле против `refineZip` — не нашёл сценарий, где это меняет вывод (`refineZip` ищет `[Content_Types].xml`/`_rels/.rels` в первых `SIGNATURE_PROBE_BYTES=4096` байт, HTML-суффикс после этого окна не переклассифицирует zip в html). |
| 2 | Конкурентность (два воркера, повторная доставка) | Не сломано, потому что: `candidate-photos.service.ts#objectKey` (`:38-45`) хэширует `Date.now()+companyId+candidateNumber+originalName` — конкурентные загрузки одного кандидата получают разные `storageKey`, коллизии перезаписи нет. MinIO upload — одна операция на объект, гонки «читатель видит частично записанный Content-Type» нет (S3-подобное API атомарно на уровне объекта). Отдача Telegram-медиа не имеет разделяемого мутируемого состояния — `resolveChatMediaServeHeaders` чистая функция на каждый запрос. |
| 3 | Обратная совместимость (существующие потребители) | Смешанно. `safeServeHeaders`/Telegram-путь пересчитывают заголовки НА КАЖДЫЙ запрос (не кэшируют вывод старого кода) — старые записи автоматически получают новую логику при следующей отдаче, включая старые Telegram-сообщения (DB `mimeType` не пересчитывается, но заголовок формирования — да). Для presigned-редиректов (`candidate-photos`, `hr-document-*`) Content-Type — это МЕТАДАННЫЕ ОБЪЕКТА В MinIO, выставленные В МОМЕНТ ЗАГРУЗКИ; для объектов, загруженных **до** `fdac710f0` (когда `candidate-photos.service.ts` безусловно доверял `mimeType.split(';')[0]`), Content-Type в MinIO остаётся старым (потенциально спуфнутым) и фикс его не пересчитывает ретроактивно — не переоткрываю как отдельную находку (переобход требует ре-аплоада или бэкфилл-джобы, разумный компромисс), но фиксирую как честное ограничение, не «полностью починено». Для `hr-document-template`/`hr-document-version` риск ниже: там `attachmentDispositionReqParams` форсит `attachment` НЕЗАВИСИМО от того, что хранится в Content-Type объекта — старые объекты защищены форсингом диспозиции, а не пересчётом типа. `candidate-photos` такого форсинга не имеет вообще (см. Находка 2) — там нет compat-сетки ни для старых, ни для новых объектов. |
| 4 | Безопасность (auth, PII, секреты в логах) | См. Находки 1 и 2 (stored XSS). Логи интерсептора (`upload-policy.interceptor.ts`) пишут имя файла/тип/причину отказа — не пишут содержимое буфера или секреты. `bypassReason` логируется на каждый запрос (замысел — не дать «временно отключил» пройти незаметно) — подтверждено чтением, работает как описано. IDOR: везде проверенные сервисы фильтруют по `companyId` из `where` (`candidate-photos.service.ts` — `companyId_candidateNumber`, `hr-absence-attachments.service.ts` аналогично) — не сломано. |
| 5 | Never-паттерны корневого рула | `body: unknown` — не найдено в проверенных контроллерах (DTO типизированы). MCP key в query param — не относится к этому дифу. `timingSafeEqual` — не относится (нет HMAC-сравнений в этом дифе). Приём файлов без `@UploadPolicy` — фикс именно про это, подтверждено fail-closed поведением (`InternalServerErrorException` без политики, `upload-policy.interceptor.ts:60-67`) — не сломано. **Нарушение найдено**: собственное правило `.claude/rules/05-security.md` — «SVG нет в `images` намеренно... Разрешать только вместе с `Content-Disposition: attachment`» — нарушено в Находках 1 и 2 ниже, каждая в своём файле. |

Молчаливо пропущенный угол — не проверенный. «Неприменимо» требует причины.

## Находки

### Находка 1 — HIGH — Telegram inline-медиа: SVG проходит как «безопасный» тип

> **Статус (повторное ревью 2026-08-19): ЗАКРЫТО** для продемонстрированного вектора
> (`image/svg+xml` точно, с параметром, любой регистр). Новый узкий edge-case (не
> тот же вектор, не переоткрывает HIGH) — см. Находку 4 ниже.

- **File:Line:** `apps/backend/src/modules/integrations/telegram/controllers/telegram-media-response.util.ts:12`
- **Pattern:**
  ```ts
  const CHAT_MEDIA_INLINE_SAFE = /^(image\/|video\/|audio\/|application\/pdf$)/i;
  ```
  Префиксный regex засчитывает ЛЮБОЙ `image/*` как inline-safe, включая `image/svg+xml`.
  Контраст: `fileSignature.ts` в этом же дифе явно исключает svg
  (`INLINE_UNSAFE_KINDS = new Set(['html', 'svg'])`, `INLINE_SAFE_MIME` — закрытый список
  `pdf|jpeg|png|gif|webp` без svg) — то есть автор дифа знал о риске SVG и закрыл его в
  одном файле, но не во втором.
- **Why:** `declaredMime` — атрибут `mimeType` документа MTProto, выставляет
  **отправитель** (собственный doc-comment файла, строки 14-17, прямо называет это тем же
  классом риска, что и client mimetype на HTTP-загрузке — но не упоминает svg как
  исключение). Проверено эмпирически:
  ```
  node -e "console.log(/^(image\/|video\/|audio\/|application\/pdf$)/i.test('image/svg+xml'))"
  → true
  ```
  Цепочка атаки: атакующий (любой Telegram-контакт жертвы, доступ к переписке не нужен —
  достаточно быть в диалоге) отправляет документ `mimeType: image/svg+xml`,
  `<svg onload="fetch('/api/...', {credentials:'include'})"><script>...</script></svg>`.
  `telegram-media-download.service.ts` (`openMessageMediaStream`) кладёт `row.mimeType` в
  БД как есть при инжесте и отдаёт его без переверификации при каждом просмотре.
  `telegram-messages.controller.ts` `GET /integrations/telegram/media/:chatId/:messageId`
  — same-origin, JWT-cookie-аутентифицированный (`AuthGuard('jwt')`,
  `CompanyUserOnlyGuard`) эндпоинт бэкенда — НЕ редирект на внешнее хранилище, контент
  стримится напрямую (`pipeReadableToResponse`, `body.pipe(res)`), заголовки выставляет
  сам бэкенд. При прямой навигации жертвы на этот URL (ссылка от того же контакта в чате,
  закладка, будущее изменение фронтенда) SVG отдаётся `Content-Type: image/svg+xml` БЕЗ
  `Content-Disposition` (regex засчитал как «safe») → исполнение в origin приложения с
  доступом к живой сессии. Текущий фронтенд (`TelegramMessageMedia.tsx`) сам по себе
  безопасен — весь путь идёт через `tgGetOrFetchMediaUrl` (`fetch`→`.blob()`→
  `URL.createObjectURL`), никогда не грузит `<img src>` напрямую с raw backend URL —
  но это защита UI, не эндпоинта; эндпоинт остаётся уязвим для прямой навигации.
  `telegram-media-response.util.spec.ts` (8/8 прошло, `npx vitest run
  telegram-media-response` из `apps/backend`) покрывает `text/html`, `text/plain`,
  `image/jpeg`, `video/mp4`, `audio/ogg`, `application/pdf`, `application/msword` — **нет
  теста на `image/svg+xml`**, пробел не пойман тестами так же, как и кодом.
- **Fix:**
  ```ts
  const CHAT_MEDIA_INLINE_SAFE = /^(image\/(?!svg\+xml)|video\/|audio\/|application\/pdf$)/i;
  ```
  и регресс-тест по образцу существующего `text/html`-репро:
  ```ts
  it('РЕПРО: image/svg+xml не отдаётся inline (та же угроза, что text/html)', () => {
    const { res, headers } = mockResponse();
    pipeReadableToResponse(res, emptyStream(), {
      mimeType: 'image/svg+xml',
      cacheControl: 'private, max-age=3600',
    });
    expect(headers['Content-Type']).toBe('application/octet-stream');
    expect(headers['Content-Disposition']).toBe('attachment');
  });
  ```

### Находка 2 — MEDIUM — Фото кандидата: SVG проходит внутренний гейт, отдаётся без forced-attachment

> **Статус (повторное ревью 2026-08-19): ЧАСТИЧНО ЗАКРЫТО.** Пункт (a) —
> `isAllowedImageMime` сужен до закрытого списка — закрыт полностью, проверено
> чтением. Пункт (b) — forced-attachment — закрыт только на неиспользуемом
> эндпоинте, реальные точки выдачи URL остаются без него. См. разбор ниже.

- **File:Line:** `apps/backend/src/modules/candidate-photos/candidate-photos.service.ts:12-15`
  (`isAllowedImageMime`), `:172` (гейт в `uploadBufferForCompany`), `:245-256`
  (`getPhotoFileRedirect`, отсутствие `attachmentDispositionReqParams`)
- **Pattern:**
  ```ts
  function isAllowedImageMime(mime: string): boolean {
    const m = mime.toLowerCase();
    return m.startsWith('image/') || [...].includes(m);   // пропускает image/svg+xml
  }
  // ...
  async getPhotoFileRedirect(...): Promise<string> {
    // ...
    return this.minio.presignedGetUrl(row.storageKey, 300); // без attachmentDispositionReqParams
  }
  ```
- **Why:** `uploadBufferForCompany()` — внутренний, НЕ-HTTP вход, в обход
  `UploadPolicyInterceptor` целиком (это признаёт сам код в комментарии на строках
  186-189: «внутренние вызовы... идут в обход интерсептора»). `storeBuffer()` внутри
  корректно вызывает `detectFileSignature(buffer)` (добавлено этим же дифом,
  `fdac710f0`) — для настоящего SVG-контента детектор ПРАВИЛЬНО распознаёт
  `kind:'svg', mime:'image/svg+xml'` и сохраняет как есть (это не баг детекции). Баг —
  что (а) `isAllowedImageMime` пропускает svg на вход ДО детектора вообще, и (б) на
  отдаче нет defense-in-depth: `getPhotoFileRedirect` не форсит `attachment`, в отличие
  от `hr-document-template.service.ts:200-204` и `hr-document-version.service.ts:78-84`
  в этом же дифе, которые форсят. Прямой HTTP-путь (`POST .../photos`,
  `@UploadPolicy(UPLOAD_PRESETS.images(...))`, без `allowUnknown`) — БЕЗОПАСЕН,
  интерсептор отклоняет svg-сигнатуру раньше сервиса. Из двух вызывающих
  `uploadBufferForCompany`: `candidate-resumes.service.ts` (импорт фото из резюме) — НЕ
  эксплуатируем для настоящего SVG: буфер уже прошёл гейт `@UploadPolicy(documents)`
  самой загрузки резюме, а `documents`-пресет не включает `svg` в `allow` — интерсептор
  отклонит SVG-контент раньше, чем он дойдёт до этого кода. `hh-resume-photo.util.ts`
  (импорт фото кандидата с hh.ru) — единственный реалистичный путь: `mime` берётся из
  `Content-Type` HTTP-ответа CDN hh.ru, гейтится только `startsWith('image/')` — узкая
  предпосылка (нужно, чтобы hh.ru когда-либо отдал `image/svg+xml` для фото-URL,
  вне контроля HR Helper) — новый факт, специфичный для ревьюируемого файла
  `candidate-photos.service.ts`, не пересчёт закрытого спора про безопасность hh.ru-импорта
  в целом.
  **Смягчающий фактор (честно, не для занижения без основания):** `getPhotoFileRedirect`
  отдаёт presigned URL на MinIO/S3-хост
  (`MINIO_ENDPOINT`/`MINIO_PUBLIC_ENDPOINT`, `infra/docker/docker-compose.yml:51,57` —
  `minio`/`localhost`, отдельный порт 9000 от бэкенда), НЕ origin приложения — проверено:
  `infra/nginx/nginx.prod.conf` не проксирует MinIO под путём приложения (нет
  `location`-блока), явного cross-subdomain `Domain=` на auth-cookie в коде не найдено.
  То есть эксплуатация этой находки — inline-исполнение SVG в ОТДЕЛЬНОМ origin
  хранилища, без доступа к сессионной cookie приложения (в отличие от Находки 1,
  same-origin). Реальный риск в текущей топологии — фишинг/подмена контента в origin
  хранилища, не прямая кража сессии; риск становится равным Находке 1, если хранилище
  когда-либо будет проксироваться под тем же origin (частый паттерн для CDN-кэширования,
  не проверено как отсутствующий по архитектурному решению, а не по факту нынешней
  конфигурации).
- **Fix:** (a) сузить `isAllowedImageMime` до закрытого списка (`jpeg|png|gif|webp`,
  без bare `image/`-префикса), оставив `detectFileSignature` как основную проверку; (b)
  форсить `attachmentDispositionReqParams` на `getPhotoFileRedirect` для любого типа вне
  `INLINE_SAFE_MIME` из `fileSignature.ts` — по образцу `hr-document-template.service.ts`.
  `<img src>`-встраивание на фронтенде не сломается: `Content-Disposition` не влияет на
  рендер `<img>`-тега в браузерах (он значим только при top-level навигации), но это
  стоит подтвердить регресс-тестом на UI перед мержем.

### Находка 3 — LOW — UploadPolicyInterceptor: отсутствующий буфер тихо пропускает content-check

- **File:Line:** `apps/backend/src/common/upload/upload-policy.interceptor.ts:93-97`
- **Pattern:**
  ```ts
  const buffer = file.buffer;
  if (!buffer || buffer.length === 0) {
    this.log.warn(`[upload] ${where}: файл «${name}» без буфера в памяти — проверка содержимого пропущена`);
    return;
  }
  ```
- **Why:** ветка срабатывает и для настоящих 0-байтных файлов (безопасно — нечему быть
  вредоносным), и для НЕПУСТЫХ файлов на `diskStorage()` (буфер физически недоступен) —
  код не различает эти два случая. Размер (`file.size ?? buffer?.length ?? 0`,
  строка 85) проверяется РАНЬШЕ и не зависит от буфера — лимит размера не обходится.
  Но сигнатура/mismatch/OOXML-проверки — единственная содержательная защита этого
  дифа — превращаются в `logger.warn` без отказа для любого будущего эндпоинта на
  `diskStorage()`. Проверено (`grep -rn "diskStorage\|storage:"`): все 15 текущих
  контроллеров используют `memoryStorage()` — **не эксплуатируемо сегодня**. Но
  обещание коммита («забыть больше нельзя по построению, а не по дисциплине»)
  формально не выполняется для этой конфигурации — она не отклоняется, а тихо
  деградирует до пройденной policy-presence проверки без содержательной.
- **Fix:** отличить «действительно пусто» (`file.size === 0`) от «буфер недоступен при
  size > 0» — во втором случае `throw new InternalServerErrorException` (тот же класс
  ошибки, что и «эндпоинт без политики» — архитектурная, не клиентская проблема), а не
  `warn`+`return`. Опционально: явный флаг `policy.allowUnbufferedStorage` для
  осознанного обхода, по образцу `bypassReason`.

## Опровергнутые аргументы

Нет — это первый проход ревью по данному дифу.

## Повторное ревью (правки Executor'а по Находкам 1 и 2)

- **Дата:** 2026-08-19. **Рецензент:** тот же `security-expert` subagent, независимый
  от Executor'а (не автор ни оригинального дифа, ни этих точечных правок).
- **Материал:** незакоммиченные изменения в
  `telegram-media-response.util.ts`(+`.spec.ts`) и `candidate-photos.service.ts` —
  прочитаны целиком заново (не по пересказу).
- **Скоуп:** только углы 1 (границы) и 4 (безопасность) для изменённых мест — угол 2
  (конкурентность) и 5 (Never-паттерны) не затронуты этими правками, вывод первого
  прохода (строки 44, 47 этого файла) наследуется без повторной проверки. Угол 3
  (обратная совместимость) частично пересчитан ниже (он прямо относится к тому, что
  именно осталось непокрытым в Находке 2).

### Угол 1 (границы) — regex `CHAT_MEDIA_INLINE_SAFE`, повторно на реальных данных

Проверено эмпирически (`node -e`, не поверил регексу на глаз):

```
image/svg+xml                    → false (не inline)  ✓ основной вектор закрыт
IMAGE/SVG+XML                    → false               ✓ регистр закрыт (флаг /i)
image/svg+xml; charset=utf-8     → false               ✓ параметр не помогает обойти
' image/svg+xml' (leading space) → false (fail-safe: не матчит image/ вовсе → unsafe)
image/svg+xml\n                  → false
image/jpeg                       → true (inline, не сломано)
image/svg xml   (ПРОБЕЛ вместо +) → TRUE — ПРОХОДИТ КАК INLINE-SAFE
image/svg2, image/svgz           → true (ожидаемо — не svg+xml, безопасно неважно)
```

**Новый контрпример, который негативный lookahead не ловит:** `(?!svg\+xml)` — это
проверка «сразу после `image/` НЕ идёт буквально `svg+xml`», а не «это НЕ SVG». Если
отправитель (недоверенный MTProto `mimeType`, задаёт **клиент** Telegram — не
обязательно официальный) укажет `image/svg xml` (пробел вместо `+`) или любой другой
вариант, где буквальная подстрока `svg+xml` не стоит непосредственно после `image/`,
lookahead **проходит** → `resolveChatMediaServeHeaders` отдаёт `Content-Type:
image/svg xml` inline, без `Content-Disposition: attachment`.
**Понижающий фактор (честно, не для сокрытия):** `X-Content-Type-Options: nosniff`
выставляется в этой функции **безусловно**, для любой ветки (строка 52,
`pipeReadableToResponse`) — `image/svg xml` не является синтаксически валидным media
type (пробел недопустим в HTTP token/subtype), современные браузеры (Chrome/Firefox)
при `nosniff` + нераспознаваемом как валидный Content-Type для top-level навигации,
по спецификации Fetch MIME-sniffing, не сниффают тело как HTML/SVG и это не тот же
детерминированный live-exploit, что был для точного `image/svg+xml` (не проверено
против реального браузера в этом окружении — нет live Telegram-стенда/Playwright для
Telegram, см. честная оговорка в `.claude/rules/16-telegram.md`). Классифицирую как
**новую Находку 4, LOW** (не HIGH) — см. таблицу находок ниже. Не блокирует, потому
что: (а) требует нестандартного MTProto-клиента для отправки заведомо невалидного
`mime_type`, (б) `nosniff` — тот же safety net, что уже стоит перед этой находкой
для всех прочих веток, (в) итоговый вектор — деградация до неопределённого поведения
рендеринга «сломанной картинки», не подтверждённое исполнение скрипта.

Тест-файл (`telegram-media-response.util.spec.ts`, прочитан целиком) — 9/9 тестов,
регресс на `image/svg+xml` присутствует (строки 100-110), но **нет** теста на
`image/svg xml` (пробел) или иные near-miss варианты — пробел в покрытии тот же
класс, что закрывает Находка 4.

### Угол 4 (безопасность) + угол 3 (обратная совместимость) — Находка 2, реальные потребители

Проверено не на веру автору правок, а трассировкой вызывающего кода:

- `candidate-photos.service.ts` содержит **четыре** места, вызывающих
  `this.minio.presignedGetUrl(...)` для фото кандидата:
  1. `resolvePrimaryPhotoUrlsBatch` — `:109` — **без** `attachmentDispositionReqParams`
  2. `listPhotos` — `:139` — **без** `attachmentDispositionReqParams`
  3. `storeBuffer` (сразу после аплоада) — `:224` — **без** `attachmentDispositionReqParams`
  4. `getPhotoFileRedirect` — `:265-269` — **С** `attachmentDispositionReqParams`
     (правка этого цикла)

  Executor исправил только #4. Трассировка потребителей:
  - `listPhotos` → REST `GET /candidates/:num/photos` → frontend
    `listCandidatePhotos` (`apps/frontend/src/shared/api/candidates.ts:887-896`) →
    `useAtsCandidatePhotos.ts:36-41` (`photo.url = p.url`, из #2 выше) →
    **`AtsPhotoDialog.tsx:113-114` — `<img src={photo.url}>` напрямую.**
  - `resolvePrimaryPhotoUrlsBatch` (из #1 выше) — три вызывающих в бэкенде:
    `telegram-dialogs-ats-avatar.service.ts:57,96`,
    `application-enrichment.service.ts:33` — питает аватарки кандидатов в
    ATS-списке/Telegram-диалогах.
  - **`getPhotoFileRedirect` (#4, единственное исправленное место) — эндпоинт
    `GET /candidates/:num/photos/:photoId/file` — grep по `apps/frontend/src`,
    `apps/extension/src` не находит ни одного вызывающего с фронтенда**; единственное
    упоминание пути — автосгенерированный `schema.d.ts` (OpenAPI-контракт, не
    фактический вызов). Т.е. правка защитила эндпоинт, который приложение сегодня не
    использует, и оставила без защиты два эндпоинта, которые использует.

  **Вывод:** Находка 2, пункт (b) (forced-attachment для defense-in-depth против
  legacy-объектов с отравленным Content-Type в MinIO) **не закрыта** для реального
  пути показа фото пользователю — она закрыта только для «мёртвого» с точки зрения
  фронтенда роута. Практический риск остаётся на том же уровне, что описан в
  оригинальной Находке 2 (cross-origin с MinIO, `<img>` не читает
  `Content-Disposition` — поэтому сам рендер превью не ломается и не был бы сломан,
  если бы фикс применили к правильным местам), т.е. это не эскалация до HIGH и не
  новый вектор — это **неполный фикс той же находки**, не блокирующий отдельно по
  тем же основаниям, что и оригинал.

  Механизм `attachmentDispositionReqParams` там, где он применён, реально работает —
  проверено: `packages/utils/src/files/fileSignature.ts:256-259` возвращает
  `{ 'response-content-disposition': 'attachment; filename*=...' }`, и
  `StorageAdapter.presignedGetUrl(objectKey, expirySeconds?, reqParams?)`
  (`apps/backend/src/common/storage/storage-adapter.ts:32-36`,
  `minio.service.ts:173-181`) прокидывает `reqParams` напрямую в
  `presignClient.presignedGetObject` (стандартный S3-style override) — механизм
  фикса корректен, вопрос только в охвате мест применения.

  Регресс-теста на `isAllowedImageMime`/`getPhotoFileRedirect` не добавлено — в
  модуле `candidate-photos` вообще нет `.spec.ts` (проверено `find`), несмотря на то,
  что Находка 2 сама по себе рекомендовала «подтвердить регресс-тестом... перед
  мержем». Не блокирует (модуль и раньше был без тестов, `06-testing.md` относит это
  к P1/P2, не P0), но стоит зафиксировать вместе с Находкой 4/остатком Находки 2(b).

- Typecheck перепроверен независимо: `npx tsc --noEmit -p apps/backend/tsconfig.json`
  → чисто (0 строк вывода, exit 0) — подтверждает заявление Executor'а, не просто
  доверие пересказу.
- Тесты перепроверены независимо: `npx vitest run --root apps/backend
  telegram-media-response` → **9/9 passed** (сам прогнал, не поверил цифре из
  пересказа).

## Обновлённые находки (сводка)

| # | Severity | Статус после повторного ревью |
|---|---|---|
| 1 | HIGH | **ЗАКРЫТО** для продемонстрированного вектора. Тест на регрессию добавлен и проходит. |
| 2 | MEDIUM | **ЧАСТИЧНО**: (a) `isAllowedImageMime` — закрыто полностью. (b) forced-attachment — исправлено только на неиспользуемом фронтендом эндпоинте (`getPhotoFileRedirect`); `listPhotos:139` и `resolvePrimaryPhotoUrlsBatch:109` (реальные источники `<img src>`/аватарок) остаются без него. Не блокирует по тем же основаниям, что в оригинале (cross-origin MinIO, `<img>` не читает `Content-Disposition`) — но не должно закрываться в Notion как «сделано» без этой оговорки. |
| 3 | LOW | Не тронуто в этом цикле (по решению владельца) — статус не изменился. |
| 4 (новая) | LOW | `CHAT_MEDIA_INLINE_SAFE` — негативный lookahead пропускает near-miss варианты `image/svg+xml` с искажённым разделителем (напр. `image/svg xml`) как inline-safe. Смягчено безусловным `nosniff`, эксплуатируемость в современных браузерах не подтверждена (нет live-стенда). Fix: заменить lookahead на явное сравнение `declaredMime.split(';')[0].trim().toLowerCase() !== 'image/svg+xml'` внутри allow-класса — как уже сделано в `isAllowedImageMime` (закрытый список / точное сравнение, не substring-паттерн). |

## Опровергнутые аргументы

Нет — это первый проход ревью по данному дифу.

## Вердикт

- [x] APPROVED — блокирующая Находка 1 закрыта и подтверждена независимо
  (regex-тесты на исходном и новых контрпримерах, `vitest` 9/9, чтение кода).
  Находка 2 закрыта частично (пункт a — полностью, пункт b — только на
  неиспользуемом эндпоинте) — этого достаточно, чтобы не блокировать мерж
  **на тех же основаниях, на которых сам оригинал уже относил Находку 2 к
  «не блокирует отдельно»** (cross-origin MinIO, отсутствие того же
  same-origin-with-session риска, что был у Находки 1). Находка 3 — прежний
  статус, не блокирует.
- [ ] CHANGES_REQUESTED

**Обязательные follow-up (зафиксировать в Notion «Ошибки» как отдельные карточки,
не заново открывать B-24 CHANGES_REQUESTED ради них — ни одна не HIGH):**
  1. Находка 2(b), остаток — форсить `attachmentDispositionReqParams` на
     `listPhotos:139` и `resolvePrimaryPhotoUrlsBatch:109` (реальные потребители),
     не только на `getPhotoFileRedirect`; либо явно задокументировать, почему
     оставлено как есть, если владелец решит, что риск для двух cross-origin URL
     незначителен.
  2. Находка 4 (новая) — ужесточить `CHAT_MEDIA_INLINE_SAFE` до точного сравнения
     вместо negative-lookahead-substring; добавить regression-тест на near-miss
     варианты (`image/svg xml`, лишние символы сразу после `image/`).
  3. Находка 3 (из первого прохода) — не переоткрыта, прежний статус.
  4. Тестовое покрытие `candidate-photos.service.ts` (модуль без единого `.spec.ts`)
     — добавить хотя бы `isAllowedImageMime`/`getPhotoFileRedirect` регресс при
     следующем touch файла.

Правки по CHANGES_REQUESTED применяет только Executor; после правок — повторное ревью
(можно сокращённое, по исправленным местам) до первого APPROVED.

## Третий проход (2026-08-19) — закрытие остатка Находки 2(b)

Executor добавил `attachmentDispositionReqParams(path.basename(...))` третьим
аргументом ко всем оставшимся вызовам `this.minio.presignedGetUrl(...)` в
`apps/backend/src/modules/candidate-photos/candidate-photos.service.ts`. Проверено
независимо (файл прочитан заново целиком, не по диффу):

1. **Все 4 вызова `presignedGetUrl` подтверждены** с `attachmentDispositionReqParams`
   третьим аргументом, каждый — `path.basename()` от корректной storageKey-переменной
   своей области видимости, без перекрёстного копипаста:
   - `resolvePrimaryPhotoUrlsBatch` (:109-113) → `path.basename(row.storageKey)`
   - `listPhotos` (:143-147) → `path.basename(r.storageKey)`
   - `storeBuffer` (:232-236) → `path.basename(storageKey)` (локальная переменная,
     не поле Prisma-записи — верно, `storeBuffer` ещё не имеет `row` на этом шаге)
   - `getPhotoFileRedirect` (:277-281) → `path.basename(row.storageKey)` (без изменений,
     это было закрыто ещё во втором проходе)
   Сигнатура-получатель совпадает: `StorageAdapter.presignedGetUrl(objectKey,
   expirySeconds?, reqParams?: Record<string,string>)` (`storage-adapter.ts:32-36`) —
   четвёртый вызов ничем не отличается по контракту от уже проверенного в прошлом
   проходе.

2. **Typecheck перепрогнан независимо** (не доверие пересказу Executor'а):
   `npx turbo run typecheck --filter=@hr-helper/nestjs-api-v2 --force` (форс, чтобы
   исключить stale cache-hit) → `5 successful, 5 total`, 0 ошибок.

3. **Превью `<img>` не ломается — перепроверено для ВСЕХ потребителей, не только
   `AtsPhotoDialog.tsx:114`**, т.к. теперь `attachment` форсится на всех 4 путях, а не
   на одном:
   - `AtsPhotoDialog.tsx:114` — `<img src={photo.url}>` (из `listPhotos`)
   - `CandidatesList.tsx:217` — `<img src={getCandidateAvatarUrl(c, c.avatarUrl)}>`
     (`avatarUrl` ← `primaryPhotoUrl` ← `resolvePrimaryPhotoUrlsBatch`)
   - `atsPrintDocument.ts:155` — `<img class="print-photo" src="${candidate.avatarUrl}">`
     (тот же источник, печатное окно — тоже subresource-контекст, не top-level nav)
   Все три — subresource-загрузка (`<img src>`), не top-level навигация; браузер
   уважает `Content-Disposition: attachment` только при top-level навигации/прямом
   переходе по URL, не при рендеринге `<img>` — тот же механизм, что уже задокументирован
   в комментарии `getPhotoFileRedirect` (:272-276) и был проверен во втором проходе для
   одного пути, теперь подтверждён для всех трёх реальных потребителей.

**Находка 2(b), остаток — ЗАКРЫТО.** Новых контрпримеров не найдено. Оговорка
«частично закрыто» из второго прохода снимается.

### Финальный вердикт

- [x] **APPROVED — без оговорок по Находке 2.**
- [ ] CHANGES_REQUESTED

Открытые follow-up из второго прохода (Находка 3 — не блокирует по решению владельца,
Находка 4 — LOW, тестовое покрытие модуля) остаются в силе как отдельные Notion-карточки,
не как условие для этого APPROVED.
