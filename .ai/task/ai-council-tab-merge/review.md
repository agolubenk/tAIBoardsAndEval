# Адверсариальное ревью — ai-council-tab-merge

> Канон: `.continue/rules/06-adversarial-review.md`. Ревью — попытка сломать решение
> контрпримерами до ответа пользователю, не согласование. Автор не ревьюит себя.

## Материал

- **Что ревьюится:** commit `a09d62478b408e90ecc6a3ec595a26bfad7ad250` (branch `main`) —
  "feat(ai-council): merge dashboard tabs into Обзор/Качество/Лента/Знания"
  - `infra/ai-council/ui/index.html` (841 lines changed)
  - `infra/ai-council/gateway.py` (52 lines changed)
  - `docs/specs/ai-council.md` (5 lines changed — tab-name reference only)
- **Условия задачи:** merge 9 dashboard tabs → 7 (Обзор+Управление, Качество+Обучение,
  Прогоны→Лента+live feed, Знания+Граф), `TAB_ALIASES`/`DOC_JOIN` backward-compat bridges,
  partial re-render on poll tick / SSE to avoid clobbering user input and graph3d re-init.
- **Дата:** 2026-08-21

## Рецензент

- **Модель/роль:** Claude Sonnet 5 — independent reviewer (adversarial), invoked via
  Task tool for this review specifically.
- **Независимость:** не автор правок — commit authored by Andrei Golubenko +
  "Claude Sonnet 5" co-author trailer; this review session did not touch any code,
  read-only inspection of the diff, current file state (post-commit), and gateway.py
  route dispatch/exception handling.

## Протокол атаки

| # | Угол атаки | Результат |
|---|---|---|
| 1 | Границы (пустые множества, null, граничные значения, 10× данных) | Не сломано по большинству путей (см. разбор ниже) — но см. Находку №1 (стейл-race на partial-render, тоже граничный/конкурентный случай). `ld.error`/`ld.settings` deliberately traced end-to-end through `gateway.py`'s `learning()` (line 1307-1358) and the global `do_GET` exception wrapper (line 1748-1751): every exception thrown before `learning()`'s `return` is converted to a non-2xx response with `{"error": ...}`, so the client's `.catch()` always fires and `ld.settings`/`ld.signals` are never dereferenced except on a genuine 200 where they are unconditionally present. `DOC_JOIN[name].map(k => tabs[k])` guarded by `tabs = g.tabs || {}` and `.filter(Boolean)` — empty/malformed `/api/guide` degrades to blank `#tab-doc`, no throw. `feedCountCards`/`ovStatsGrid` default every field with `|| 0`/`|| {}`. Malformed hash (`#%zz`) pre-verified intact (7121d80a6). |
| 2 | Конкурентность (два воркера, повторная доставка события) | **Находки №1 и №2** — traced two genuine races: (a) rapid tab-switch before `/api/graph` resolves leaves an orphaned `requestAnimationFrame` loop running in a hidden tab; (b) status-filter change racing an in-flight SSE-triggered `renderRunsTable()` can clobber the freshly-filtered table with stale rows. Both confirmed by code trace (not just inspection-only guess) of `startGraph3d`'s unconditional `requestAnimationFrame(frame)` (line 2258) and `renderRunsTable`'s unguarded `$("#runs-wrap").innerHTML = ...` (line 1180) against the same-id element that `renderFeed()` recreates on every filter change. |
| 3 | Обратная совместимость (потребители контракта) | Не сломано. `grep` across the full post-commit `index.html` and `gateway.py` for the four retired tab ids (`control`, `learning`, `runs`, `graph`) as DOM selectors / `data-tab` / `tab=` kwargs / dict-literal `"tab":` values found zero leftover references outside comments — every call site was updated. `TAB_ALIASES` + `tabFromHash()` cover all four old deep-links; `DOC_JOIN` bridges `/api/guide` regardless of whether `gateway.py` has been restarted, confirmed by tracing `TAB_DOC`'s dict-literal diff: the four old keys are structurally *deleted* (not aliased/duplicated), so the author's own flagged worry ("could `tabs["graph"]` and `tabs["knowledge"]` coexist post-restart and double-concatenate") cannot occur — a Python module reload is atomic, there is no partial/hybrid `TAB_DOC` state. |
| 4 | Безопасность (auth, PII, HMAC, секреты в логах) | Неприменимо для auth/PII/секретов, потому что (как указано в задании) это локальный dev-only dashboard без аутентификации и без внешних пользователей — `gateway.py` binds to `127.0.0.1:8790` only, no PII fields anywhere in this diff. XSS regression check (still relevant, done anyway): every new/refactored template-building function touched by this commit (`ovStatsGrid`, `ovSvcRows`, `feedCountCards`, `runsTableHtml`/`runRow`, the merged learning section inside `renderQuality`) was diffed field-by-field against the existing `esc()` helper (line 263) — every server-sourced string field is wrapped in `esc(...)`; only genuinely numeric fields (`s.cards.total`, `q.running`, token counts, etc.) are interpolated raw. No missing-`esc()` regression found. |
| 5 | Never-паттерны корневого рула (`.claude/rules/00-antipatterns.md` / `.continue/rules/00-continue-root.md`) | Неприменимо для backend Never-list (`body: unknown`, `$transaction` без timeout, `findMany` без `take`/`take>100`, `async .map()` без `Promise.all`, HMAC `===`, MCP key in query param, `process.env` вне `config/`) — verified the entire `gateway.py` diff (52 lines) touches only two plain Python dict literals (`TAB_DOC` tuples and the numbered `steps` list) and one kwarg value change (`tab="runs"→"tab="feed"`); zero lines touch request handling, DB access, subprocess, hashing, or auth. `infra/ai-council` is a standalone Python `http.server` tool outside the NestJS/Prisma stack these rules target — `api("/api/runs?limit=200")` (pre-existing, unchanged by this commit — confirmed via `git show a09d62478^:...`) queries this tool's own local SQLite store, not Prisma/Postgres, so the "`take>100` → CRITICAL" rule does not apply to it. Module-scope JS caches (`guideCache`, `setupCache`, `graph3d`) resemble the "mutable singleton, lazy init" antipattern in shape, but are pre-existing single-tab browser state (no DI container, no concurrent-request race target) untouched by this diff — not a new instance of the pattern this rule targets. |

Молчаливо пропущенный угол — не проверенный. «Неприменимо» требует причины.

## Находки

### Находка №1 — orphaned `requestAnimationFrame` loop on rapid Знания→other tab switch before `/api/graph` resolves

- **Severity:** MEDIUM
- **File:Line:** `infra/ai-council/ui/index.html:328-333` (leave-guard in `selectTab`), `infra/ai-council/ui/index.html:1892-1897` (`renderKnowledge` fires `renderGraph()` without awaiting), `infra/ai-council/ui/index.html:2286-2292` (`renderGraph`), `infra/ai-council/ui/index.html:2419` (`graph3d = startGraph3d(...)` assignment happens only after the awaited fetch), `infra/ai-council/ui/index.html:2258` (`requestAnimationFrame(frame)` fired unconditionally inside `startGraph3d`, synchronously on construction)
- **Pattern:** stale-async-response race / un-cancellable fire-and-forget promise vs. teardown guard that only fires on the *next* tab-leave transition
- **Why:** `startGraph3d` (line 2258) calls `requestAnimationFrame(frame)` immediately when constructed — there is no "am I still the active tab" check anywhere in the animation loop itself. `renderKnowledge()` calls `renderGraph()` fire-and-forget (comment at line 1896: "асинхронно заполнит #graph-pane"). `renderGraph()` calls `stopGraph3d()` synchronously *before* its own `await api(...)` — but if the user navigates to Знания and away again *before* that `/api/graph` fetch resolves, `selectTab`'s leave-guard (line 332: `if (activeTab === "knowledge" && name !== "knowledge") stopGraph3d();`) fires while `graph3d` is still `null` (a no-op: `stopGraph3d` at line 1975-1977 is `if (graph3d) { graph3d.stop(); graph3d = null; }`). When the pending fetch later resolves — possibly seconds later, while the user is now on a completely different tab — `renderGraphPane` (line 2419) still unconditionally does `graph3d = startGraph3d(...)`, which starts a fresh, unguarded `requestAnimationFrame` loop. Because `graph3d` only became non-null *after* the leave-transition already happened, no future guard exists to stop this loop until the user visits Знания a second time and leaves it again. Between those two events, the loop runs indefinitely in a hidden tab, doing O(n²) spatial-hash physics steps (line 2029-2076) every frame — a real, continuous CPU/battery cost, not merely wasted event-loop ticks.
  Note: this exact hazard pattern (un-awaited `render()`/`renderGraph()` racing `selectTab`'s leave-guard) already existed before this commit — the old "graph" tab was registered directly as `RENDERERS.graph = renderGraph`, called via `await RENDERERS[activeTab]()` inside an un-awaited `render()`. The merge does not introduce the race from scratch, but it explicitly touches this exact code path (rewriting the leave-guard condition and its comment at lines 330-332) without closing it, and the task brief specifically asked to verify this scenario — so it is reported here rather than silently passed over.
- **Fix:** add a per-invocation token, e.g. `let graphToken = 0;` at module scope; in `renderGraph()`, do `const myToken = ++graphToken;` before the `await api(...)`, and immediately after it resolves check `if (myToken !== graphToken) return;` before calling `renderGraphPane` (which is what assigns `graph3d` and starts the rAF loop). This makes any earlier in-flight `renderGraph()` call a no-op once a newer one (or a tab-leave) has superseded it.

### Находка №2 — filter-change race clobbers `#runs-wrap` with stale SSE-triggered `renderRunsTable()` result

- **Severity:** MEDIUM
- **File:Line:** `infra/ai-council/ui/index.html:1176-1184` (`renderRunsTable`), `infra/ai-council/ui/index.html:1169` (`$("#f-status").onchange = (e) => { runFilter = e.target.value; renderFeed(); }`), `infra/ai-council/ui/index.html:2703-2708` (SSE `appendFeed` triggers `renderRunsTable()` on matching events)
- **Pattern:** out-of-order async DOM write — no request sequencing/AbortController between a partial update (`renderRunsTable`) and a full re-render (`renderFeed`) that recreates the same-id target element
- **Why:** `renderRunsTable()` captures `runFilter` into its `api("/api/runs?limit=200"+...)` URL at call time, then on resolution does `wrap.innerHTML = runsTableHtml(rows)` where `wrap = $("#runs-wrap")` (a plain `querySelector`, matching whatever `#runs-wrap` element currently exists in the DOM — it does not check whether the element it targets is the "same" one it was invoked for). `renderFeed()` — invoked synchronously by the status-filter `onchange` handler — rebuilds the *entire* `#tab-feed` innerHTML, including a brand-new `#runs-wrap` element rendered with the *new* filter. If an SSE event fires `renderRunsTable()` (line 2707: `if (activeTab === "feed") renderRunsTable();`) with the OLD filter baked in, and the user changes the filter dropdown before that fetch resolves, the sequence is: (1) old-filter fetch starts, (2) user changes filter → `renderFeed()` runs synchronously, replacing `#tab-feed` and `#runs-wrap` with fresh, correctly new-filtered rows, (3) the old-filter fetch resolves and does `$("#runs-wrap").innerHTML = <old-filter rows>` — finding the *new* `#runs-wrap` element (same id) and overwriting its correct content with stale, wrong-filter data. The `<select>` still visually shows the new filter selected, but the table now shows rows from the old filter/old snapshot until the next SSE event or 5s poll corrects it.
- **Fix:** capture a generation/version counter (or the `runFilter` value itself) at the top of `renderRunsTable()` before the `await`, and bail out without touching the DOM if `runFilter` (or a monotonically incremented "feed render generation" counter, bumped inside `renderFeed()`) no longer matches what was captured — e.g. `async function renderRunsTable() { const myFilter = runFilter; const rows = await api(...); if (runFilter !== myFilter) return; ... }`.

## Опровергнутые аргументы

- Автор явно попросил проверить: "what if, post-restart, `tabs["knowledge"]` exists as the new merged text but `tabs["graph"]` also still exists for some transitional reason — would you get an awkward double-concatenation?" — **опровергнуто**: `git diff` на `gateway.py`'s `TAB_DOC` dict-literal показывает, что все четыре старых ключа (`control`/`learning`/`runs`/`graph`) буквально удалены из словаря (не задублированы, не заалиасены на стороне сервера) — `/api/guide`'s `"tabs"` строится напрямую из `TAB_DOC.items()` (gateway.py:814-815), значит после рестарта старые ключи физически отсутствуют в ответе, `DOC_JOIN`'s `.filter(Boolean)` их безопасно отбрасывает, двойной конкатенации нет ни в одном достижимом состоянии процесса (Python module reload атомарен — гибридного состояния между "до" и "после" не существует).
- Автор отметил, что не тестировал живым форсированным падением `/api/learning`: код-трейс (не просто чтение) через `gateway.py:1307-1358` + `do_GET`'s общий exception handler (`gateway.py:1748-1751`) подтверждает, что любое исключение до `return` превращается в non-2xx с `{"error": ...}` — то есть `ld.settings`/`ld.signals` разыменовываются только тогда, когда сервер гарантированно вернул полный словарь (все ключи строятся безусловно в одном `return`). Заявленная деградация (`ld.error` ветка) реально покрывает все достижимые пути отказа этого конкретного эндпоинта — контрпримера не найдено.

## Вердikт

- [ ] APPROVED
- [x] CHANGES_REQUESTED — 2 находки (MEDIUM/MEDIUM), обе воспроизводимые через конкретный
      сценарий гонки, а не мнение. Ни одна не блокирует базовую функциональность мержа вкладок
      (переименования, алиасы, DOC_JOIN, XSS-эскейпинг — всё подтверждено корректным), обе —
      про edge-case конкурентности в rAF-жизненном цикле графа и в partial-render живой ленты.
      Достаточно узкие фиксы (токен поколения рендера) для обеих находок.

Правки по CHANGES_REQUESTED применяет только Executor; после правок — повторное ревью
(можно сокращённое, по исправленным местам) до первого APPROVED.

---

## Повторное ревью (сокращённое) — commit 058f03e51

> Канон: `.continue/rules/06-adversarial-review.md`. Скоуп по заданию — ТОЛЬКО два места,
> закрытые коммитом `058f03e51619cd84c0b4ce1abe8f873be650e216` ("fix(ai-council): close
> tab-merge race и graph token + feed filter guard"). Остальная часть коммита-мержа
> (a09d62478) в этом заходе не пересматривается — она остаётся в статусе, зафиксированном
> в разборе выше, за вычетом двух находок. Рецензент — новый инстанс, не автор коммита
> `058f03e51`; live-проверка через Playwright против реально работающего шлюза
> `http://127.0.0.1:8790` (тот же процесс, что использовал автор), не только чтение диффа.
> **Дата:** 2026-08-21

### Материал

`git show 058f03e51 -- infra/ai-council/ui/index.html` подтверждён построчно (9 добавленных
+ 1 изменённая строка) и сверен с текущим состоянием файла (`Read` на месте) — диф
применён именно так, как описано в задании: `let graphToken = 0`, `graphToken++` внутри
`stopGraph3d()`, `const myToken = graphToken` + пост-await guard в `renderGraph()` и
`renderGraphDrill()`, `const myFilter = runFilter` + пост-await guard в `renderRunsTable()`.

### Протокол атаки (сокращённый — только пересечение с зоной фикса)

| # | Угол атаки | Результат |
|---|---|---|
| 1 | Находка №1 (исходный скоуп) — orphaned rAF при leave-до-resolve | **Закрыто для описанного сценария.** Код-трейс: `stopGraph3d()` в начале `renderGraph()` бампает `graphToken` и ТОЛЬКО ПОТОМ `myToken` его захватывает — нет off-by-one, `renderGraph()` не видит сам себя устаревшим (см. п.2 разбора ниже). Live-Playwright (не только код-трейс): свежая загрузка страницы даёт rAF-baseline **0** за 2с без единого захода на «Знания» (подтверждает, что rAF в приложении используется исключительно графом — других источников нет, значит все дальнейшие ненулевые счётчики однозначно относятся к graph3d). |
| 2 | Конкурентность — bump-then-capture ordering (off-by-one в `renderGraph()`) | **Не сломано.** Последовательность `stopGraph3d()`(++token)→`myToken = graphToken` гарантирует, что `renderGraph()` «забирает себе» именно свежий (после собственного бампа) токен; любой ПОСЛЕДУЮЩИЙ `stopGraph3d()` (leave-guard или новый рендер) бампает снова и корректно инвалидирует именно этот in-flight вызов, независимо от порядка резолва промисов (проверено рассуждением по всем перестановкам двух конкурентных вызовов). |
| 3 | Конкурентность — `renderGraphDrill()` без своего `stopGraph3d()`, гэп vs `renderGraphPane()`'s `graph3d = startGraph3d(...)` без остановки предыдущего | **НОВАЯ НАХОДКА (см. ниже), live-verified.** Именно тот гэп, о котором спросило задание, — реален и НЕ является «отдельной вне-скоуповой проблемой»: он напрямую сводит на нет общий класс бага, который Находка №1 была призвана закрыть. |
| 4 | Другие вызовы `renderGraphPane`/`graph3d` в обход guard'а | Прямых вызовов `renderGraphPane` вне `renderGraph()`/`renderGraphDrill()` нет (`grep` подтверждает единственную точку присвоения `graph3d =` — строка 2427); `bindGraphBuild()`'s poll вызывает `renderGraph()` (safe). Но сам guard (token-check) решает только проблему «не отрисовать устаревшие ДАННЫЕ», а не проблему «не оставить предыдущий INSTANCE висеть» — это две разные гарантии, и вторая не дана нигде, см. Находку A. |
| 5 | Находка №2 (исходный скоуп) — stale renderRunsTable | **Закрыто для описанного сценария** (код-трейс: `myFilter` захватывается до await, guard после — корректно отсекает устаревшую запись в `#runs-wrap`). Но сама предпосылка автора («`renderFeed()` — полная замена контейнера, поэтому там гонка не нужна») **не выдерживает проверки** — см. Находку B: `renderFeed()` читает мутабельный `runFilter` ДВАЖДЫ (для URL — до await, для `opts`/выбранной опции — после await), и при двух конкурентных `renderFeed()` порядок резолва промисов не гарантированно совпадает с порядком вызова. |
| 6 | Регрессии обычного пути (переключение вкладок / загрузка графа / смена фильтра) | **Не сломано.** Добавленные строки — чистые early-return guard'ы на equality-check, в несостязательном случае условие всегда истинно и веток не меняет; подтверждено и код-чтением (нет побочных эффектов на success-path), и live: обычная загрузка «Знания» (68763 узлов, 3090 сообществ), обычный drill-down (680 узлов в сообществе), обычная начальная отрисовка «Ленты» (44 прогона, пустой фильтр) — все отработали штатно до того, как я начала намеренно провоцировать гонки. |
| Границы / обратная совместимость / безопасность / Never-паттерны | **Неприменимо для этого захода** — диф `058f03e51` это 10 строк чистых guard'ов в клиентском JS локального dev-инструмента без auth/PII/контрактов; уже покрыто исходным ревью выше и не меняется этим коммитом. |

### Находка A — `renderGraphDrill()` не гасит предыдущий `graph3d` перед пересозданием: orphaned rAF loop БЕЗ какой-либо гонки, на каждом обычном drill-down

- **Severity:** MEDIUM
- **File:Line:** `infra/ai-council/ui/index.html:2301-2311` (`renderGraphDrill` — нет вызова `stopGraph3d()` ни в начале функции, ни где-либо ещё), `infra/ai-council/ui/index.html:2427` (`graph3d = startGraph3d(...)` — безусловное присвоение поверх предыдущего `graph3d` без `graph3d.stop()`), `infra/ai-council/ui/index.html:2453` (переключение чекбокса `.g-rel` в режиме drill повторно вызывает `renderGraphDrill()` — тот же гэп, второй независимый триггер)
- **Pattern:** resource leak via reference reassignment without teardown — фикс Находки №1 закрыл ОДИН путь попадания в это состояние (гонка leave-vs-fetch), но не закрыл сам механизм (переприсвоение `graph3d` без `.stop()` предыдущего), и есть второй, полностью детерминированный (не гоночный) путь в тот же механизм.
- **Why:** Live-репро через Playwright против реально работающего `http://127.0.0.1:8790` (не только код-трейс):
  1. Свежая загрузка страницы, НИКАКОГО захода на «Знания» — `requestAnimationFrame` заинструментирован (обёрнут счётчиком), 2 секунды ожидания → **0** вызовов. Это подтверждает, что rAF в приложении используется ИСКЛЮЧИТЕЛЬНО графом — нет других источников, которые могли бы дать ложноположительный счёт ниже.
  2. `selectTab('knowledge')` → граф уровня «сообщества» (`graphPrefs.limit === "all"` из localStorage → `isCommunities = true`, 3090 узлов-сообществ) отрисован, `graph3d` = инстанс A (rAF-цикл A запущен).
  3. Один клик по ссылке "Сообщество ?" (обычный, документированный workflow — «клик по сообществу открывает его детальный срез») → `renderGraphDrill()` → сообщество из 680 узлов успешно отрисовано (`#g-back` появился), `graph3d` = инстанс B. Инстанс A **не был остановлен** (`renderGraphDrill()` ни разу не вызывает `stopGraph3d()`), просто потерян как ссылка.
  4. `selectTab('home')` — уход с «Знания» на полностью другую вкладку. Leave-guard (`index.html:332`) срабатывает и вызывает `stopGraph3d()` — но это останавливает ТОЛЬКО то, на что `graph3d` указывает СЕЙЧАС (инстанс B, drill), а не потерянный инстанс A.
  5. Счётчик rAF обнулён, 2 секунды ожидания на вкладке «Главная» (граф нигде не виден, никакого нового рендера не запущено) → **986 вызовов** (повторный прогон дал 928 — тот же порядок величины). Поскольку п.1 доказал rAF-baseline = 0 без графа вообще, эти ~950-990 вызовов/2с могут быть объяснены только одним: инстанс A всё ещё крутит свой `requestAnimationFrame(frame)` вечно (`frame()` строка 2255-2262 планирует себя безусловно каждый кадр, независимо от `dirty`/`alpha`, и остановится только если `running=false`, что выставляется исключительно методом `.stop()`, который для инстанса A никогда не был вызван).
  6. Каждый дальнейший drill-down (или переключение чекбокса `rel` в режиме drill, строка 2453 — тот же паттерн, тоже без `stopGraph3d()`) добавляет ЕЩЁ один навсегда работающий O(n²)-цикл физики (spatial-hash отталкивание по всем парам узлов сообщества, строки 2036-2080) — утечка растёт линейно с числом навигаций внутри сессии и не лечится уходом с вкладки, только F5.
  Это означает: Находка №1 закрыла узкий гоночный сценарий (уйти ДО резолва фетча), но НЕ закрыла общий класс «orphaned rAF loop» — тот же наблюдаемый симптом (цикл переживает уход со вкладки «Знания») воспроизводится детерминированно, без единой миллисекунды искусственной задержки, на полностью штатном пути использования графа.
- **Fix:** Надёжнее чинить в одной точке, а не в каждом вызывающем: в `renderGraphPane()` (`infra/ai-council/ui/index.html:2427`) заменить `graph3d = startGraph3d(...)` на:
  ```js
  if (graph3d) graph3d.stop();
  graph3d = startGraph3d($("#g-canvas"), d, showSelected);
  ```
  Это закрывает выход и из `renderGraph()`, и из `renderGraphDrill()`, и из любого будущего вызова `renderGraphPane()` одним изменением, не требуя от каждого нового caller'а помнить про `stopGraph3d()`. (Альтернативный, более узкий фикс — добавить `stopGraph3d()` первой строкой `renderGraphDrill()`, зеркально `renderGraph()`, и на строке 2453 перед повторным `renderGraphDrill()` — рабочий, но два места вместо одного, разъезжается при следующем новом caller'е.)

### Находка B — `renderFeed()` читает мутабельный `runFilter` дважды (до и после await): дропдаун может показать фильтр, для которого таблица ещё не отрисована

- **Severity:** MEDIUM
- **File:Line:** `infra/ai-council/ui/index.html:1144-1150` (`renderFeed()`: URL строится с `runFilter` до `await Promise.all(...)`, список `opts` — с `runFilter` ПОСЛЕ await)
- **Pattern:** тот же класс "out-of-order async DOM write", что и (уже закрытая) Находка №2, но на уровень выше — `renderFeed()` сама не получила filter-capture guard, хотя по логике задания именно про неё спросили явно ("should renderFeed() also increment some generation marker").
- **Why:** `renderFeed()` не является безусловно безопасной просто потому, что она "полностью заменяет контейнер" — это верно только если предположить, что конкурентные вызовы `renderFeed()` всегда резолвятся в том же порядке, в котором были запущены (FIFO), а для двух независимых HTTP-запросов это не гарантировано (разная селективность фильтра → разное время ответа бэкенда, сетевой джиттер). Конкретный сценарий: вызов A (`runFilter=""`, помедленнее) стартует; пока A летит, пользователь меняет фильтр на `"failed"` → `runFilter = "failed"`, вызов B (быстрее) стартует и резолвится первым — рисует корректно (таблица по `failed`, дропдаун `failed`). Когда A наконец резолвится, её собственный `opts` строится с ТЕКУЩИМ (уже "failed") `runFilter` — то есть дропдаун снова покажет "failed" как выбранный, — но `rows` внутри A это результат ЕЁ СОБСТВЕННОГО запроса, сделанного ещё с `runFilter=""` (нефильтрованные строки). Итог: `$("#tab-feed").innerHTML` перезаписывается на несогласованное состояние — дропдаун показывает "failed", таблица — все нефильтрованные прогоны. В отличие от Находки №1/A этот баг не самокорректируется следующим тиком `refresh()` (тот дергает только `/api/state`, полный `renderFeed()` не перевызывает, см. `index.html:2733-2750`) — несоответствие держится, пока пользователь вручную не тронет фильтр ещё раз или не уйдёт и не вернётся на вкладку.
  **Оговорка по методу проверки:** пыталась воспроизвести live через Playwright тем же приёмом, что и автор (патч `window.api` с искусственной задержкой нефильтрованного вызова + программный вызов `renderFeed()` + смена фильтра через `#f-status`), но `http://127.0.0.1:8790` — реально работающий процесс с живым SSE-потоком настоящих прогонов консилиума, и параллельный фоновый трафик (`appendFeed` → `refresh()`/`renderRunsTable()` на реальных событиях) конфликтовал с контролируемой постановкой внутри сессии ревью, не дав чисто изолированного повторения. Нахожу это находкой на основании прямого код-трейса (двойное чтение мутабельной глобальной переменной `runFilter` до и после await безусловно и не зависит от исхода конкретной гонки, чтобы существовать как дефект), а не как live-подтверждённый прогон, в отличие от Находки A.
- **Fix:** в `renderFeed()` захватить `const myFilter = runFilter;` перед `Promise.all(...)`, и после резолва либо `if (runFilter !== myFilter) return;` (симметрично фиксу `renderRunsTable()`), либо строить `opts`/`selected` из ЗАХВАЧЕННОГО `myFilter`, а не из живого `runFilter`, — так `<select>` и таблица внутри одного вызова `renderFeed()` всегда согласованы между собой, а устаревший вызов никогда не перетирает более новый.

### Опровергнутые аргументы (для этого захода)

- Формулировка задания предполагала, что вопрос о `renderGraphDrill()`/`renderGraphPane()` может быть "отдельной вне-скоуповой проблемой, не взаимодействующей с этим фиксом" — **опровергнуто живым прогоном**: это не вне-скоуповая проблема, это тот же наблюдаемый симптом (orphaned rAF после ухода с «Знания»), который Находка №1 была призвана устранить, всё ещё воспроизводимый — просто через другой, более лёгкий в достижении (детерминированный, не гоночный) триггер.
- Предположение, что `renderFeed()` не нуждается в guard'е, потому что делает полную замену DOM — **опровергнуто код-трейсом**: полная замена контейнера защищает только от "устаревший `renderRunsTable()` пишет в чужой/новый узел"; она не защищает от того, что САМА `renderFeed()` дважды читает мутабельный `runFilter` (до и после await) и потому может нарисовать внутренне несогласованное состояние из одного вызова.

### Вердикт

- [ ] APPROVED
- [x] CHANGES_REQUESTED — обе ИСХОДНО заявленные находки (граф-токен для сценария
      leave-до-resolve, filter-guard в `renderRunsTable()`) корректно и без побочных
      эффектов закрыты — подтверждено и код-трейсом, и live Playwright против реального
      шлюза. Но проверка именно тех вопросов, которые задание попросило задать в этой же
      зоне (п.3 и п.5 задания), вскрыла, что базовая проблема — "orphaned rAF после ухода
      с «Знания»" — **не закрыта полностью**: Находка A воспроизводится детерминированно
      (без всякой гонки) на полностью штатном пути (один клик drill-down + переход на
      другую вкладку), а Находка B — тот же класс гонки на уровень выше, который автор
      явно предположил закрытым по неверной причине ("renderFeed — полная замена, гонка
      невозможна"). Обе находки — узкие однострочные/двухстрочные фиксы (см. Fix выше),
      не требуют пересмотра остальной архитектуры.

Правки применяет только Executor; после них — следующий заход сокращённого ревью
(по Находкам A и B) до первого APPROVED.

---

## Повторное ревью (сокращённое, round 3) — commit 02429b0b5

> Канон: `.continue/rules/06-adversarial-review.md`. Скоуп по заданию — ТОЛЬКО Находки A и B,
> закрытые коммитом `02429b0b548fb197517b9c8986bad876e2ff4a58` ("fix(ai-council): close
> remaining orphaned-rAF and stale-filter races (review round 2)"). Рецензент — новый
> инстанс, не автор коммита `02429b0b5`. Диф прочитан через `git show 02429b0b5:...`
> (рабочее дерево на момент ревью содержит несвязанный WIP — удаление кнопок «Лента»/
> «Облако» в пользу header-пиллов — вне скоупа, не читался как часть этого коммита).
> Live-проверка — через Playwright против реально работающего `http://127.0.0.1:8790`
> (тот же процесс, код на диске = коммит `02429b0b5` + несвязанный клиентский WIP).
> **Дата:** 2026-08-21

### Материал

`git show 02429b0b5 -- infra/ai-council/ui/index.html` подтверждён построчно (5 добавленных
+ 2 изменённые строки) и сверен с `git show 02429b0b5:infra/ai-council/ui/index.html` —
диф применён ровно так, как описано в задании:
- `renderFeed()` (строки 1144-1150 коммита): `const myFilter = runFilter;` перед
  `Promise.all(...)`, `if (runFilter !== myFilter) return;` сразу после await и до любой
  сборки `opts`/записи в DOM, `opts` строится из `myFilter`, а не из живого `runFilter`.
- `renderGraphPane()` (строка 2429 коммита, прямо перед строкой 2430
  `graph3d = startGraph3d(...)`): добавлена ровно одна строка `if (graph3d) graph3d.stop();`.

`grep` по всему файлу подтверждает единственную точку присвоения `graph3d =` (строка 2430,
внутри `renderGraphPane`) и единственный вызов `startGraph3d(` вне его же определения — то
есть централизованный фикс действительно перехватывает вход и из `renderGraph()`, и из
`renderGraphDrill()`, и из будущих вызывающих без необходимости помнить про `stopGraph3d()`
в каждом из них (п.2 задания — подтверждено).

### Протокол атаки (сокращённый — только пересечение с зоной фикса + явные вопросы задания)

| # | Угол атаки | Результат |
|---|---|---|
| 1 | Находка A (исходный скоуп) — `renderGraphDrill()` не гасит предыдущий `graph3d` | **Закрыто.** Live-Playwright: свежая загрузка → 0 rAF/2с без графа (базовая линия); заход на «Знания» (сообщества) → клик по «Сообщество 5» (обычный drill, без гонки) → рендер корректен (393 узла, `#g-back` есть) и граф анимируется (rAF-счётчик ненулевой, ~800-1200/1.5с — тот же порядок величины, что и baseline «один живой инстанс» из round-2 отчёта). После `selectTab('home')` (уход со «Знания») — rAF-счётчик за следующие 2с на несвязанной вкладке = **0**. Утечка инстанса из Находки A не воспроизводится. |
| 2 | Находка B (исходный скоуп) — `renderFeed()` дважды читает мутабельный `runFilter` | **Закрыто для описанного двухзначного сценария.** Live-Playwright (не только код-трейс, в отличие от round-2, где автор сам не смог изолировать живой прогон от SSE-шума): `window.api` патчен так, что ТОЛЬКО точный URL `/api/runs?limit=200` (без `&status=`) резолвится с задержкой 4000мс; вызван `renderFeed()` при `runFilter=""`, затем **в той же синхронной задаче** (без межтуловой задержки, которая испортила попытку автора в round 2) программно сменён `#f-status` на `"failed"` — быстрый фильтрованный вызов резолвится первым и корректно рисует `failed`/2 строки; спустя ~4с медленный неф ильтрованный вызов резолвится, `runFilter("failed") !== myFilter("")` → **guard сработал, `return` до записи в DOM** — финальный DOM остался `selected="failed"`, 2 строки. Событийный лог: `unfiltered-start@155448.3` → `unfiltered-resolve@159458.1` (4010мс, как и ожидалось) → финальный `#f-status.value === "failed"`, `#runs-wrap` не тронут. |
| 3 | Прямые вызовы `renderGraphPane`/`graph3d` в обход централизованного guard'а | **Не найдено.** `grep -n "graph3d *="` во всём файле даёт ровно 3 совпадения: объявление (`let graph3d = null`, 1976), `stopGraph3d()`'s `graph3d = null` (1982), и `renderGraphPane`'s `graph3d = startGraph3d(...)` (2430) — сразу после нового `if (graph3d) graph3d.stop();` (2429). `grep -n "startGraph3d("` — 2 совпадения: определение функции (2006) и этот же единственный вызов (2430). Других путей создания/переприсвоения `graph3d` нет. |
| 4 | `.stop()` на живом инстансе без промежуточного `null` — висящий closure/таймер? | **Не сломано.** `startGraph3d`'s `stop()` (2267-2273) выставляет `running=false` (замыкание per-инстанс, не общая переменная) и снимает 4 listener'а со СВОЕГО `canvas`-узла. Поскольку `$("#graph-pane").innerHTML = ...` (полная замена, строка 2356) выполняется РАНЬШЕ вызова `.stop()` (2429) в порядке кода, к моменту `.stop()` старый `<canvas>` уже отсоединён от DOM — снятие listener'ов с отсоединённого узла безвредно. Уже запланированный (но не выполнившийся) `requestAnimationFrame(frame)` старого инстанса выполнится максимум ещё один раз, увидит `running=false` и не перепланирует себя — цикл гарантированно останавливается за один кадр, JS однопоточен, гонки между `.stop()` и переприсвоением `graph3d =` на следующей строке нет (синхронный код). |
| 5 | Регрессия обычного пути (одиночная смена фильтра / одиночная загрузка графа/drill) | **Не сломано**, live-подтверждено независимо от самоотчёта автора: обычная смена `#f-status` → `"failed"` без всякой гонки — dropdown и таблица (2 строки) синхронно обновились. Обычный клик по «Сообщество 5» без искусственных гонок — корректный рендер + анимация (см. строку 1). |
| 6 (по заданию, п.6) | Взаимодействие фикса Находки A с `graphToken`-guard'ом (058f03e51) — double-stop/use-after-stop на двух перекрывающихся `renderGraph()`/`renderGraphDrill()` | **Double-stop/use-after-stop не найден** (см. строку 4) — но именно здесь обнаружена НОВАЯ Находка C: `renderGraphDrill()` никогда не бампает `graphToken` (бампает только `stopGraph3d()`, а `renderGraphDrill()` его не вызывает), поэтому ДВА перекрывающихся `renderGraphDrill()`-вызова (клик по одному сообществу, затем — до резолва — по другому) не инвалидируют друг друга через токен: итог определяется порядком РЕЗОЛВА, а не порядком КЛИКА. Live-verified ниже. |
| Границы / обратная совместимость / безопасность / Never-паттерны | **Неприменимо для этого захода** — диф `02429b0b5` это 2 однострочные guard'а в клиентском JS локального dev-инструмента без auth/PII/контрактов, тот же вывод, что и в предыдущих раундах, этим коммитом не меняется. |

### Находка C — `renderGraphDrill()` не бампает `graphToken`: два перекрывающихся drill-клика инвалидируются по порядку РЕЗОЛВА, а не по порядку КЛИКА — устаревший клик может перетереть свежий

- **Severity:** MEDIUM
- **File:Line:** `infra/ai-council/ui/index.html:2303-2314` (`renderGraphDrill` — захватывает `myToken = graphToken`, но нигде не инкрементирует `graphToken` сам, в отличие от `renderGraph()`, которая начинается с `stopGraph3d()`, то есть `graphToken++`), `infra/ai-council/ui/index.html:1978-1983` (`graphToken`/`stopGraph3d` — единственное место, где токен бампается)
- **Pattern:** тот же класс "out-of-order async DOM write", что и (уже закрытая) Находка B, но в графовой, а не ленточной, ветке — токен-guard защищает только от «внешней» инвалидации (уход со вкладки, новый `renderGraph()`), не от двух конкурирующих вызовов ОДНОЙ и той же функции без внешнего триггера.
- **Why:** Live-репро через Playwright против `http://127.0.0.1:8790` (не только код-трейс): патчен `window.api` так, что запрос сообщества `community:1` резолвится с задержкой 3000мс, а запрос `community:2` — сразу. Вызван `renderGraphDrill("community:1", "…STALE")`, затем (через 80мс, ДО резолва первого) `renderGraphDrill("community:2", "…FRESH")`. `community:2` (535 узлов, свежий клик) резолвится первым и корректно рисует свою панель. Спустя ~3с резолвится `community:1` (618 узлов, устаревший клик) — токен-проверка `myToken !== graphToken` не срабатывает (ни один из двух вызовов `renderGraphDrill` не бампал `graphToken`, он как был, так и остался равным исходному значению, `tokenBefore === tokenNow === 1` подтверждено логом) — функция НЕ делает `return`, и `renderGraphPane` перерисовывает панель данными `community:1`. Финальное состояние, подтверждённое чтением реального DOM и независимым запросом обеих панелей: `graphDrill.communityId === "community:1"`, `graphDrill.label === "…STALE"`, `#graph-pane .sub` показывает «618 узлов» (это размер `community:1`, не `community:2` — проверено прямым вызовом `/api/graph/community/community:1` → `community_size:618` и `/api/graph/community/community:2` → `community_size:535`). То есть пользователь кликнул по сообществу 2 последним, увидел его на мгновение, а затем без какого-либо его действия панель молча откатилась на сообщество 1 — без единой ошибки в консоли (`browser_console_messages` — 0 warning/0 error за всю сессию), то есть баг полностью silent.
  Утечки ресурса здесь НЕТ (Находка A закрыта корректно даже в этом сценарии — проверено: после этого, уход на другую вкладку и 2с ожидания дают rAF-счётчик 0, то есть промежуточный инстанс для `community:2`, хоть и был подменён устаревшими данными, был корректно остановлен централизованным `if (graph3d) graph3d.stop()` перед созданием инстанса для устаревшего `community:1`) — проблема исключительно в ПРАВИЛЬНОСТИ отображаемых данных, не в утечке.
- **Fix:** либо (а) добавить бамп токена в `renderGraphDrill()` самостоятельно (`const myToken = ++graphToken;` вместо просто чтения — тогда любой новый `renderGraphDrill()`/`renderGraph()` корректно инвалидирует предыдущий in-flight drill независимо от исхода гонки резолва), либо (б), раз обе функции и так вызывают `renderGraphPane`, вынести инкремент токена туда же, где теперь стоит централизованный `graph3d.stop()`-фикс, — но это неверно, потому что к моменту вызова `renderGraphPane` токен-проверка уже прошла (нужно бампать ДО фетча, не после) — поэтому единственно рабочее место — начало `renderGraphDrill()`, симметрично тому, что уже делает `renderGraph()` через `stopGraph3d()`. Дополнительно: тот же паттерн повторяется на строке 2456 (`cb.onchange` чекбокса `.g-rel` в drill-режиме вызывает `renderGraphDrill(graphDrill.communityId, graphDrill.label)` повторно) — двух быстрых переключений чекбокса достаточно для того же самого сценария без единого клика по разным сообществам.

### Находка D — `renderFeed()`: guard по равенству значения (не по монотонному счётчику) не защищает от возврата к ПОВТОРЯЮЩЕМУСЯ значению фильтра во время гонки из трёх вызовов

- **Severity:** MEDIUM (но см. оговорку — идентичный паттерн уже используется и был одобрен для `renderRunsTable()` в предыдущих раундах; это не новый дефект, внесённый этим коммитом, а более глубокая грань уже принятого паттерна, вскрытая при целевой проверке п.4 задания)
- **File:Line:** `infra/ai-council/ui/index.html:1144-1150` (`renderFeed()`), для сравнения `infra/ai-council/ui/index.html:1178-1187` (`renderRunsTable()` — идентичный паттерн, не входит в скоуп этого коммита)
- **Pattern:** guard на основе сравнения "текущее значение общей переменной == значение, захваченное при старте" распознаёт только "значение СЕЙЧАС ДРУГОЕ", но не "для этого же значения уже был запущен и завершился более свежий рендер" — при цикле A(v)→B(v2)→C(v) с переупорядочиванием (A медленный, резолвится последним) guard молчит, потому что `runFilter` на момент резолва A снова равен `v`.
- **Why:** Live-репро (не теоретическое построение — воспроизведено фактическим прогоном через Playwright с внедрёнными маркерными строками, чтобы отличить содержимое A от C при одинаковом значении фильтра `""`): `window.api` патчен так, что ПЕРВЫЙ вызов точного URL `/api/runs?limit=200` резолвится через 6000мс с маркерной строкой `MARKER-A-STALE-ROW`, а КАЖДЫЙ последующий такой вызов резолвится немедленно с маркерной строкой `MARKER-C-FRESH-ROW`. Последовательность: `runFilter=""` → `renderFeed()` (вызов A, захватывает `myFilter=""`, стартует медленный фетч) → синхронно `#f-status→"failed"` (вызов B, `runFilter="failed"`, резолвится быстро и корректно) → синхронно `#f-status→""` (вызов C, `runFilter=""` снова, резолвится немедленно, корректно рисует `MARKER-C-FRESH-ROW`). Через ~6с вызов A наконец резолвится: guard `runFilter !== myFilter` → `"" !== ""` → **false**, `return` НЕ срабатывает, `$("#tab-feed").innerHTML` перезаписывается на данные вызова A → финальный DOM показывает `MARKER-A-STALE-ROW` (устаревшую строку из вызова, сделанного ДО того, как пользователь на секунду переключился на «failed» и вернулся обратно), хотя `#f-status.value` корректно показывает `""` — то есть ровно тот же класс несогласованности dropdown/таблица, что описан в исходной Находке №2, просуществовавший через слой `renderFeed()`. Событийный лог подтверждает порядок: `unfiltered-start-#1@227412.5` (A) → `unfiltered-start-#2@233295.6` / `unfiltered-resolve-#2(FRESH)@233295.6` (C, резолвится мгновенно) → `unfiltered-resolve-#1(A-STALE)@233413.8` (A, резолвится последним и клобберит).
- **Оговорка:** этот паттерн («сравнение значения», а не «монотонный счётчик поколений») — тот же самый, что уже используется в `renderRunsTable()` (одобрен ревью в предыдущих раундах) и который явно рекомендован как образец в Fix-секции самой Находки B выше («мирroring the pattern already used and approved in renderRunsTable()»). То есть это не регрессия, внесённая коммитом `02429b0b5`, а ранее не замеченная граница ПРИНЯТОГО паттерна — воспроизводится идентично и в `renderRunsTable()` тем же приёмом (не перепроверялось живым прогоном в этом заходе, чтобы не выходить за скоуп, но логика идентична и падает под тот же код-трейс аргумент). Указываю как находку, а не как отказ засчитать фикс Находки B: сам фикс корректен для сценария, который был явно заявлен и специфицирован (два значения, не три с возвратом) — но у обеих функций-сестёр общая, более узкая слабость.
- **Fix:** заменить сравнение по значению на монотонный счётчик поколений, общий для `renderFeed()` и `renderRunsTable()` (раз они делят один и тот же класс гонки и одну и ту же DOM-цель `#runs-wrap`): `let feedGen = 0;` → в начале каждой из двух функций `const myGen = ++feedGen;`, после await — `if (myGen !== feedGen) return;`. В отличие от сравнения `runFilter`, счётчик монотонно растёт при КАЖДОМ вызове независимо от того, совпадает ли новое значение фильтра со старым, поэтому «возврат к прежнему значению» никогда не даёт двум разным вызовам одинаковый ключ инвалидации.

### Опровергнутые аргументы (для этого захода)

- Предположение задания, что взаимодействие фикса Находки A с `graphToken`-guard'ом может дать «double-stop/use-after-stop» — **не подтверждено**: инструментальная проверка (п.4 таблицы выше) показывает, что порядок «полная замена DOM (и, следовательно, отсоединение старого `<canvas>`) → `.stop()` старого инстанса → присвоение нового» безопасен при любом соотношении времени, JS однопоточен, `stop()` идемпотентен по построению (`running=false` — установка в `false` дважды безвредна). Вместо double-stop обнаружена смежная, но иная по природе Находка C (гонка корректности ДАННЫХ, не ресурса).
- Самоотчёт автора по Находке B (успешный live-прогон с задержкой 2500мс на нефильтрованном вызове) — **подтверждён независимо**, с более чистой изоляцией (обе программные мутации `runFilter`/`renderFeed()` выполнены в одном синхронном evaluate-вызове, а не через два отдельных tool-round-trip'а, которые в моей первой попытке случайно растянули гонку на секунды и дали ложно-безопасный результат — см. промежуточный лог этого ревью). Для заявленного двухзначного сценария (`""` → `"failed"`, без возврата) — фикс работает корректно.

### Вердикт

- [ ] APPROVED
- [x] CHANGES_REQUESTED — Находки A и B из round 2 подтверждены закрытыми корректно и без
      побочных эффектов для ИХ заявленных сценариев (double-stop/use-after-stop-гонок в
      месте фикса Находки A не найдено; ранняя проверка `runFilter !== myFilter` в
      `renderFeed()` для Находки B действительно останавливает запись в DOM до какой-либо
      мутации — подтверждено и код-трейсом, и живым Playwright-прогоном с чистой
      изоляцией). Но целевая проверка именно тех вопросов, которые задание попросило
      задать в этой же зоне (п.6 задания — взаимодействие фикса A с `graphToken`-guard'ом),
      вскрыла НОВУЮ Находку C: `renderGraphDrill()` никогда не бампает `graphToken`, из-за
      чего два перекрывающихся drill-клика инвалидируются по порядку РЕЗОЛВА, а не КЛИКА —
      живой контрпример воспроизведён детерминированно (искусственная задержка одного из
      двух запросов, без которой на быстром локальном API окно гонки просто уже, но не
      закрыто теоретически). Попутно (п.4 задания — проверка «нет наблюдаемых побочных
      эффектов между await и guard'ом») обнаружена Находка D — та же в своей основе гонка
      «возврат к повторяющемуся значению», живо воспроизведённая маркерными строками,
      затрагивающая одинаково `renderFeed()` и уже одобренный `renderRunsTable()` (общая
      слабость выбранного паттерна «сравнение значения», не регрессия этого коммита).
      Обе новые находки — silent (без единой ошибки в консоли за всю сессию проверки),
      обе не самокорректируются без явного действия пользователя (смена фильтра/уход-
      приход на вкладку). Обе — узкие фиксы (счётчик поколений вместо сравнения значения/
      токена), не требуют пересмотра остальной архитектуры; Находка D одинаково применима
      к сестринской функции, фикс уместно делать для обеих сразу одним общим счётчиком.

Правки применяет только Executor; после них — следующий заход сокращённого ревью
(по Находкам C и D) до первого APPROVED.

---

## Повторное ревью (сокращённое, round 4) — commit 87b1a2c02

> Канон: `.continue/rules/06-adversarial-review.md`. Скоуп по заданию — ТОЛЬКО Находки C и D,
> закрытые коммитом `87b1a2c028e910c2366192d79cd507e07d011d46` ("fix(ai-council): close
> renderGraphDrill token-bump and feed/runs generation-counter races (review round 3)").
> Рецензент — новый инстанс, не автор коммита. Диф и состояние файла читаны ТОЛЬКО через
> `git show 87b1a2c02 -- …` / `git show 87b1a2c02:infra/ai-council/ui/index.html`; живая
> страница на диске сверена через `Function.prototype.toString()` pristine-функций — guard-строки
> обеих функций и `renderGraphDrill` соответствуют коммиту, различия с диском = только чужой
> несвязанный nav-pill WIP (`setFeedConn()`, `#feed-conn`), который guard-код не трогает и который
> вне скоупа (не ревьюился, не репортируется). Live-проверка выполнена: Playwright против
> работающего `http://127.0.0.1:8790`, все сценарии ниже — фактические прогоны с событийными
> логами. **Дата:** 2026-08-21.

### Материал

`git show 87b1a2c02 -- infra/ai-council/ui/index.html` подтверждён построчно (7+/3−, 4 хунка,
один файл) и сверен с `git show 87b1a2c02:…`:
- строки 1117-1118: `let feedGen = 0;` + 2 строки комментария после `let runFilter = "";`;
- `renderFeed()` (1146-1153): `const myGen = ++feedGen;` после захвата `myFilter`; guard
  `if (myGen !== feedGen) return;` сразу после `Promise.all` и до любой записи в DOM, `opts`
  строится из `myFilter`;
- `renderRunsTable()` (1181-1188): то же; при этом `if (!wrap) return;` остался ДО `++feedGen`;
- `renderGraphDrill()` (2311): `const myToken = ++graphToken;` вместо `const myToken = graphToken;`.

Карта инвариантов (grep по состоянию коммита): `runFilter` пишет ровно один сайт — 1174
(`#f-status.onchange → runFilter = e.target.value; renderFeed()`); `feedGen` бампают ровно два
сайта (1151, 1185); `graphToken` бампают ровно два пути — `stopGraph3d()` (1985, вызывается из
`renderGraph` 2297 и из `selectTab` 332 при уходе со «Знаний») и новый `++` в `renderGraphDrill`
(2311); `graphDrill` пишут ровно два сайта — `null` в `renderGraph` (2298, синхронно на старте)
и `{communityId, label}` в `renderGraphDrill` (2316, после guard). Триггеры: `renderFeed` —
из `RENDERERS` при `selectTab` (2761) и из onchange (1174); `renderRunsTable` — только SSE
`appendFeed` при `activeTab==="feed"` (2722); каунтеры — `updateFeedCounts` из `refresh()`
(2753, 5-секундный интервал + SSE), независимо от `feedGen`.

### Протокол атаки (сокращённый — только пересечение с зоной фикса)

| # | Угол | Результат |
|---|---|---|
| 1 | Находка C закрыта (два перекрывающихся drill, итог по клику, не по резолву) | **Закрыто, live.** Патч `window.api` (матчинг по `decodeURIComponent` — важно: `encodeURIComponent("community:1")` = `community%3A1`): c1-задержка 3000мс, c2 — немедленно, вызовы через 83мс. Лог: `token-before=5` → `c1-start@…2135` (myToken=6) → `c2-start@…2218` (myToken=7) → `c2-resolve@…2227 size=15`, guard `7===7` → рисует (`graphDrill={community:2,"FRESH-LABEL"}`, sub «показан связный кусок из 15», big 15) → `c1-resolve@…5145` (через 3010мс, size=180), guard `6!==7` → **return, панель не перетёрта**; финал неизменен, консоль чистая (0 pageError). |
| 2 | Собственный бамп `++graphToken` — все пары + off-by-one | **Не сломано.** drill→drill — п.1; drill→renderGraph: `renderGraph` начинается с `stopGraph3d()` (token++), in-flight drill отбрасывается (`T !== T+1`); renderGraph→drill: drill бампает после захвата renderGraph'а → renderGraph отбрасывается; leave-guard: `selectTab` (332) → `stopGraph3d()` → in-flight drill отбрасывается; `.g-rel` в drill-режиме (2460) — два быстрых переключения = два `renderGraphDrill` = тот же механизм п.1. Off-by-one: `++` префиксный → сразу после строки `myToken === graphToken`, вызов не считает сам себя устаревшим (подтверждено фактом: c2, единственный свежий, нарисовал); два вызова получают различные монотонные значения, деление токена невозможно. `renderGraph` симметричен: захватывает `myToken` ПОСЛЕ бампа `stopGraph3d()` (2297-2299, синхронно, гонки нет). `renderGraphPane` сам токен не бампает — и не должен: вызывается только после guard-прохода, оба пути бампнули ДО фетча (верное место — Fix round 3 отверг бамп внутри `renderGraphPane` именно поэтому). |
| 3 | Находка D закрыта (A("")→B("failed")→C(""), A медленнее всех) | **Закрыто, live.** Патч: первый вызов точного URL `/api/runs?limit=200` — 6000мс + маркер `MARKER-A-STALE-ROW` (клон реальной строки), каждый последующий — 0мс + `MARKER-C-FRESH-ROW`. Весь сценарий в ОДНОМ синхронном evaluate: `renderFeed()` → `#f-status`="failed" → onchange → "" → onchange. Лог: `start-#1@…7780 delay=6000` / `start-#2@…7780 delay=0` (та же мс) → `resolve-#2(C-FRESH)@…7789 rows=45` → C рисует (45 строк: клон+44) → `resolve-#1(A-STALE)@…12790` (через 6010мс) → **отброшен**. Финал: `hasCFresh=true, hasAStale=false, rowCount=45, #f-status.value=""`, fcount «45 прогонов». Старый guard дал бы `"" !== ""` → false → A перетёр бы DOM. |
| 4 | Общий `feedGen` на обе функции (ключевой вопрос раунда) | **Не сломано; «старый фильтр у последнего поколения» недостижим.** Формально: если `myGen(R) === feedGen` на резолве `renderRunsTable` R, то после старта R не стартовал ни один feed-рендер; но единственный писатель `runFilter` (1174) меняет значение ТОЛЬКО вместе со стартом `renderFeed` (бамп gen) ⇒ `runFilter` на резолве R равен `myFilter` R — контрпримера не существует, это инвариант, а не удача. Оба реальных порядка перекрытия проверены live: (4a) F стартует первым (3000мс), R вторым (0мс) → R рисует таблицу (44 строки, маркер предыдущего теста затёрт — перерисовка реальная), F отброшен, вкладка консистентна (селектор "", `#feed` жив, fcount синхронен); (4b) R первым (3000мс), F вторым (0мс) → F рисует всю вкладку, R отброшен и не пишет в отсоединяемый `wrap`. Сравнение с до-коммитным поведением: случай «R стартал, затем сменился фильтр» ловили ОБА guard'а (старый — по значению, новый — по gen); случай «возврат к тому же значению» (Находка D) ловит только новый; случай «F и R одного фильтра, R последний» старый guard пропускал F к полной перерисовке, новый — отбрасывает — но потери нет: feed-counts обновляются `updateFeedCounts` (5с-тик/SSE), селектор самопоследователен (его value = `runFilter`, писатель — сам пользователь через него), лента жива через `appendFeed` (`feedEl` остаётся валиден — вкладка не пересоздана), таблица свежая от R. Регрессии нет. |
| 5 | Ложные отбрасывания свежих вызовов / устаревший DOM надолго | **Не найдено.** SSE R → смена фильтра → F: R отброшен, таблица свежая от F. F (заход на вкладку) → SSE R позже: F отброшен, но R рисует таблицу, остальное — независимые каналы (п.4). Первый заход на вкладку защищён порядком кода: `if (!wrap) return;` стоит ДО `++feedGen` — R не может «съесть» поколение первоначального `renderFeed`. Самокоррекция: любое SSE-событие run.*/verdict/status → R, 5с-тик → каунтеры, повторный заход → F. Пути «отбрасывание оставляет устаревший DOM надолго без самокоррекции» не построено. |
| 6 | Регрессии обычного пути | **Не сломано, live:** одиночная смена фильтра "failed" → 2 строки (совпадает с каунтером «с ошибкой: 2»), обратно "" → 44 строки, селектор синхронен в обе стороны; одиночный drill без гонки — рисует (п.1, c2); загрузка «Знаний» и SSE-лента при открытой вкладке — события приходили в течение всей сессии проверки, `renderRunsTable`-механизм использует тот же guard, 0 ошибок консоли за все прогоны. |
| 7 | Границы / обратная совместимость / безопасность / Never-паттерны | **Неприменимо для этого диффа, по причинам:** 7 строк клиентского JS локального dev-инструмента без auth/PII/контрактов/миграций; границы данных — пустой `rows` покрыт существующим `emptyRow`-fallback в `runsTableHtml`; обратная совместимость — сигнатуры и глобальные имена не менялись, внешних потребителей нет; Never-паттерны (`process.env`, raw `fetch` вне `HttpClientService`, `$transaction`, ClickHouse и пр.) — к браузерному JS страницы неприменимы; конкурентность здесь — только event-loop, именно для неё guard и написан. |
| + | Расширение по усмотрению: `.g-rel`-обработчик при `graphDrill === null` | **Новая находка, LOW, pre-existing, вне скоупа** (см. ниже) — не связана с Находками C/D, код строки коммитом не менялся. |

### Находки

Новых находок В ЗОНЕ фикса (Находки C, D) — нет. Одна находка вне скоупа, для следующей задачи:

- **Severity:** LOW
- **File:Line:** `infra/ai-council/ui/index.html:2460` (в нумерации коммита `87b1a2c02`; round 3
  ссылался как 2456) — `opts.drill ? renderGraphDrill(graphDrill.communityId, graphDrill.label) : renderGraph();`
- **Pattern:** null-deref в обработчике `.g-rel` во время in-flight `renderGraph()` — «живой DOM
  мёртвого состояния»: `renderGraph()` синхронно ставит `graphDrill = null` (2298), но панель
  drill (и её чекбоксы) остаётся в DOM до резолва фетча; клик по `.g-rel` в этом окне вычисляет
  `graphDrill.communityId` от `null`.
- **Why:** Live-подтверждено прямым вызовом обработчика при `graphDrill = null` (drill-панель с
  17 чекбоксами `.g-rel` реального графа): `THREW: Cannot read properties of null (reading
  'communityId')`. Окно гонки — между кликом `#g-back` (или иным стартом `renderGraph()`) и
  резолвом `/api/graph` — на локальном API десятки мс, но при `limit=all` (25000 узлов) — секунды.
  Эффект: uncaught TypeError + тихий рассинхрон — `graphPrefs.rel` уже сохранён, но URL летящего
  `renderGraph` построен до клика, т.е. граф нарисуется по старому набору связей при новых
  галочках. **Pre-existing относительно `87b1a2c02`** (строка 2460 и `graphDrill = null` в
  `renderGraph` этим коммитом не менялись), к Находкам C/D отношения не имеет — C была про два
  drill-вызова, это про drill-чекбокс против in-flight `renderGraph`. Вердикт по скоупу раунда
  не блокирует.
- **Fix:** в `renderGraph()` не обнулять `graphDrill` до перерисовки (перенести `graphDrill = null`
  после guard, рядом с `renderGraphPane`), либо в обработчике 2460: `opts.drill && graphDrill
  ? renderGraphDrill(graphDrill.communityId, graphDrill.label) : renderGraph()`.

### Опровергнутые аргументы (для этого захода)

- Подозрение «общий `feedGen` на две функции — регрессия: последний-gen `renderRunsTable`
  перезапишет `#runs-wrap` устаревшим фильтром» — **опровергнуто инвариантом writer'а** (п.4
  таблицы): смена `runFilter` без старта `renderFeed` в этом коде невозможна (единственный сайт
  записи 1174 всегда бампает gen в том же тике), поэтому «последнее поколение со старым фильтром»
  — состояние недостижимое, а не просто маловероятное. Оба достижимых порядка перекрытия
  проверены live (4a/4b) — без потерь и без клобберинга.
- Подозрение off-by-one («`myToken = ++graphToken` — вызов сам себя считает устаревшим» или
  «два вызова делят токен») — **опровергнуто** семантикой префиксного инкремента и live-фактом
  п.1 (c2 — свежий одиночный — нарисовал; c1 — предыдущий — отброшен; `token-before=5` →
  финальный `token=7`, по бампу на вызов).
- Методологическое (для протокола): первый live-прогон Находки D в этом заходе дал
  ложноотрицательный результат по инструментальной причине ревьюера — патч ожидал ответ
  `/api/runs` в виде `{rows: [...]}`, фактически API возвращает **прямой массив** (`Array.isArray
  === true`, проверено `fetch("/api/runs?limit=5")`), маркер не добавлялся вовсе и наблюдение
  ничего не доказывало. После исправления патча сценарий D воспроизведён чисто (п.3). Аналогично
  первый прогон C не перехватывал запросы из-за `encodeURIComponent`-кодирования `:` в
  `community%3A1`; матчинг по `decodeURIComponent` исправил — задержка 3010мс подтверждена логом.

### Вердикт

- [x] APPROVED
- [ ] CHANGES_REQUESTED

Находки C и D закрыты корректно и подтверждены независимыми live-прогонами против реального
шлюза (с детерминированными задержками и маркерными строками, с событийными логами старта/
резолва каждого вызова): C — устаревший drill-клик (резолв через 3010мс, 180 узлов) не перетёр
свежий (15 узлов), финальное состояние — по последнему КЛИКУ; D — медленный вызов A (резолв
через 6010мс) отброшен поколенческим guard'ом при возврате фильтра к тому же значению, финальный
DOM — от C. Ключевой вопрос раунда (общий `feedGen` на `renderFeed`/`renderRunsTable`)
разобран с инвариантом: сценарий «самое свежее поколение со старым фильтром» недостижим, так
как единственный писатель `runFilter` всегда бампает счётчик в том же тике; оба реальных порядка
перекрытия функций live-проверены без потерь. Регрессий обычного пути не найдено. Побочная
LOW-находка (null-deref `.g-rel` при in-flight `renderGraph`) — pre-existing, вне скоупа
раунда, вердикт не определяет; рекомендуется завести отдельной правкой (Fix выше) в следующей
задаче, не под mixing с этим коммитом.

Первый APPROVED в цикле fix→commit→review — цикл закрыт.

LOW-находка заведена карточкой в Notion «Ошибки» (Severity low, статус «открыто»):
[ai-council UI: TypeError в обработчике .g-rel при уходе из drill во время in-flight renderGraph()](https://app.notion.com/p/3c3dd207a825813db9f4e818e7991c3a) — отдельная задача, не смешивать с этим циклом.
