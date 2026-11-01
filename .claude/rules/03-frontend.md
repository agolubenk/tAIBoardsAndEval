---
paths:
  - apps/frontend/**
---

# Frontend React + Vite

## FSD (Feature-Sliced Design)

`app/` → `pages/` → `features/` → `entities/` → `shared/`

**Зависимости только вниз:**
- `shared/` не импортирует из `features/` или `pages/`
- `features/` не импортирует из `pages/`
- Композиция лэйаута с feature-импортами живёт в `app/` (`app/AppLayout.tsx` уже там), не в `shared/`

**Не в `shared/`**: `recruiting/`, `org-structure/` — только инфраструктура (`ui/`, `hooks/`, `api/`, `utils/`, `query/`, `realtime/`).

## XSS — DOMPurify обязателен

```tsx
// ❌ ЗАПРЕЩЕНО — критическая XSS уязвимость
<div dangerouslySetInnerHTML={{ __html: content }} />

// ✅ ОБЯЗАТЕЛЬНО
import DOMPurify from 'dompurify'
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content, { USE_PROFILES: { html: true } }) }} />
```

Это правило без исключений для любого HTML от: сервера, пользователя, AI, внешних сервисов.

## Context.Provider — мемоизация обязательна

```tsx
// ❌ Пересоздаёт объект при каждом ре-рендере родителя → все потребители обновляются
<ThemeContext.Provider value={{ theme, setTheme, colors, fonts, size }}>

// ✅ Мемоизировать value
const contextValue = useMemo(
  () => ({ theme, setTheme, colors, fonts, size }),
  [theme, setTheme, colors, fonts, size]
)
<ThemeContext.Provider value={contextValue}>
```

## Тяжёлые импорты — только динамически

```ts
// ❌ exceljs 920KB в main bundle
import * as ExcelJS from 'exceljs'

// ✅ Динамически в обработчике
const handleExport = async () => {
  const { default: ExcelJS } = await import('exceljs')
  // ...
}
```

Правило распространяется на: `exceljs`, `pdfjs-dist`, `mammoth`. Никогда не в статических импортах `shared/`.

## Компоненты — размер

- Компонент/хук **>500 строк** → обязательная декомпозиция
- Хук **>200 строк** → вынести sub-hooks
- Page-компонент **>400 строк** → секционировать
- Декомпозиция: `ui/`, `hooks/`, `api/`, `sections/`

## Типизация

- Не `Record<string, unknown>` для form payload
- Импорт DTO из `@hr-helper/types` или локальный строгий interface

## Data — React Query

- `queryKeys` const (уникальный key включает все параметры), `api/` отдельно, не fetch в `useEffect`
- Дублирующиеся query keys в одном рендер-дереве → конфликт кэша → делать уникальными
- Не создавать `useEffect` для fetch → только `useQuery`

### staleTime / gcTime — конвенция по типу данных (FRONT-PERF-3, аудит 2026-07-26)

Глобальный дефолт (`shared/query/queryClient.ts`): `staleTime: 2 * 60_000`, `gcTime: 5 * 60_000`, `refetchOnWindowFocus: false`. Точечный оверрайд на `useQuery` — только когда конкретный запрос реально отличается от «обычных серверных данных» по категории ниже, не copy-paste:

| Категория | staleTime | Пример |
|---|---|---|
| Списки сущностей (вакансии, кандидаты, сотрудники) — меняются в человеческом масштабе | Без оверрайда (дефолт 2 мин) ИЛИ `30_000` для «живой» доски | `useEmployeesHubPage.ts` (без оверрайда), `VacanciesPage.tsx`/`HiringRequestsPage.tsx` (`30_000`) |
| Каталоги/справочники компании (custom-field defs, vacancy-types, hiring-stages, employee-lifecycle) — редко меняются, всегда в паре с `invalidateQueries` после сохранения | `5 * 60_000` — де-факто codebase-wide конвенция (~90 сайтов) | `VacancyFieldsSettings.tsx`, `VacancyTypesSettings.tsx`, `EmployeeLifecycleSettings.tsx`, `useWorkflowNewVacancyData.ts` |
| Cross-tenant справочник с длинным backend-кэшем (Redis L2 на часы) | Часы, синхронно с backend TTL | `useTelegramWallpaperCatalog.ts` (`60 * 60_000`, backend L2 24ч) |
| Live/часто-мутируемые данные (статус синка, активность кандидата, live time-status) — всегда в паре с `refetchInterval` | Короткий (`0`–`60_000`), staleTime ≈ половина `refetchInterval` | `useHhNegotiations.ts` sync-run poll (`staleTime:0`, `refetchInterval: 2_000/15_000`), `useAtsCandidateActivityHistory.ts` (`ATS_LIVE_POLL_INTERVAL_MS`), `useMyLiveTimeStatus.ts` |
| Одноразовый ресурс (POST создаёт session-токен, это не «данные» для кэширования) | `staleTime: 0, gcTime: 0` | `HrDocumentEditorDialog.tsx` (OnlyOffice editor session) |
| `useQuery` как non-data примитив (state, живущий в query-кэше; bootstrap-once триггер) | `Infinity` — инвалидация только вручную | `shared/query/useQueryBackedState.ts`, `useSpecializationsWorkspaceSync.ts` |

`refetchOnWindowFocus: true` — оправдан только когда: (а) данные меняются во внешней вкладке/попапе (OAuth-коннекты — `profileIntegrationsQuery.ts`), либо (б) это часть единого «live poll» паттерна вместе с `refetchInterval` (`useAtsCandidateList.ts`, `useAtsCandidateActivityHistory.ts`). Голый оверрайд без одной из этих двух причин — сигнал copy-paste, не оставлять непрокомментированным.

### Query-key factory — общий кэш между CRUD-страницей и read-only потребителями (FRONT-PERF-6, 2026-07-26)

Правильный `staleTime` не спасает от рефетча на каждую навигацию, если один и тот же справочник читается разными компонентами через **разные** query keys — React Query не видит связи между ними и держит отдельный cache entry на каждый. Симптом ровно тот, что просит проверять acceptance FRONT-PERF-6: «каталог не рефетчится при переключении вкладок» — ломается либо явной фрагментацией ключа (`['x']` в одном месте, `['x', companyId]` в другом), либо ещё чаще — read-only потребитель вообще не пользуется `useQuery`, а дёргает `fetch*` напрямую в `useEffect`, минуя чужой кэш целиком (хуже фрагментации: нет кэша вообще).

**Паттерн** — один `xQueryKeys.ts` (или колокейтед файл рядом с `api/`, если справочник кросс-фичевый) на домен справочника, все потребители импортируют оттуда, не пишут литерал инлайн:

```ts
// shared/api/companyRecruitingContentQueryKeys.ts — экспортирует функции-ключи + общий staleTime
export const candidateFieldsQueryKey = () => ['candidate-fields'] as const
export const COMPANY_RECRUITING_CATALOG_STALE_TIME_MS = 5 * 60_000
```

```ts
// и Settings CRUD-страница, и read-only форма — тот же ключ и staleTime:
useQuery({ queryKey: candidateFieldsQueryKey(), queryFn: fetchRecruitingCandidateFields, staleTime: COMPANY_RECRUITING_CATALOG_STALE_TIME_MS })
```

Эталон — `features/telegram/telegramQueryKeys.ts` + `useTelegramWallpaperCatalog.ts` (тонкий хук-обёртка `{catalog, isLoading, isError, refetch}` поверх `useQuery` с фабричным ключом). Уже применяется: `atsQueryKeys.ts`, `vacanciesQueryKeys.ts`, `specializationsQueryKeys.ts`, `entities/notification/model/queryKeys.ts`, `companyStructureSettingsQueryKeys.ts` (`companyGradesQueryKey()` — 11 потребителей, включая composite `queryFn` через `queryClient.fetchQuery({queryKey: ...})` там, где грейды — только часть комбинированного запроса, см. `docs/plans/archive/FIX.md` FRONT-PERF-6).

Живой пример находки FRONT-PERF-6: `fetchRecruitingCandidateFields`/`fetchRecruitingVacancyFields`/`fetchRecruitingCandidateSources`/`fetchCandidateFieldTemplates` читались CRUD-страницей (`CandidateFieldsSettings.tsx` и т.п., через `useQuery`) и параллельно — `useAtsVacancyData.ts`, `useVacancyOrgData.ts`, `useHuntflowPage.ts`, `VacancyEditModalEditTabPanels.tsx` через raw `fetch*` в `useEffect`/`Promise.all`, вообще без React Query — каждый маунт ATS-вакансии/модалки вакансии/страницы Huntflow гонял сетевой запрос за уже закэшированными Settings-страницей данными. Фикс — `shared/api/companyRecruitingContentQueryKeys.ts`, все 4+4 потребителя переведены на общий `useQuery` с одним и тем же ключом.

## Производительность

- Списки **>50 элементов** → `@tanstack/react-virtual` (установлен, использовать)
- `memo` + `useCallback` для дорогих рендеров в списках

## Client-state-only страницы — не выдавать за подключённые к бэкенду

Повторяющийся класс бага (найден независимо 4 раза — `docs/plans/archive/FIX.md`, «не везде источником правды является бэкенд»: `SourcingSourcesPage.tsx`, `WikiDetailHistory.tsx`, `/interviewers`, Company Settings → «Пользователи компании»): страница выглядит полностью рабочей (loading/error state, форма сохранения, toast «Сохранено») и даже использует правильный паттерн (`useQuery` с ключом и `staleTime`), но `queryFn` — это `mocks.ts` с искусственной `setTimeout`-задержкой, а «сохранение» — `queryClient.setQueryData(...)` без реального мутирующего запроса. Пользователь (в т.ч. HR-админ, меняющий доступ) уверен, что изменения применились, хотя после reload всё откатится к хардкоду.

```ts
// ❌ ЗАПРЕЩЕНО — правдоподобный React Query паттерн поверх мока, без явного маркера
useQuery({ queryKey: ['company-users'], queryFn: fetchCompanyUsersMock, staleTime: 30_000 })
// «сохранение» пишет только в кэш — реального запроса нет
queryClient.setQueryData(['company-users'], (old) => [...old, newUser])

// ✅ Пока реального API нет — явный статус вместо тихой имитации
// (баннер/бейдж «Демо-данные» + доступный трекинг: TODO со ссылкой на задачу в BACKLOG.md,
// не голый комментарий) — интерактив можно оставить, но пользователь не должен думать,
// что «Сохранено» означает персистентную запись
```

Не каждый `mocks.ts`/fallback-файл — этот баг: legacy-переименованный файл с одними типами (без факта подмены данных) или временный skeleton-fallback «до ответа API», переопределяемый настоящими данными по прибытии (`vacancyOrgMockData.ts`) — легитимны. Проверять: реально ли компонент когда-либо получает данные из `fetch`/`useQuery` с настоящим эндпоинтом, или единственный источник — хардкод-массив.

## Radix UI

Dialog с `Portal`, `Overlay`, `Title`, `aria-describedby`.

## tsconfig / eslint

```json
// tsconfig.app.json — включить
{ "noUnusedLocals": true, "noUnusedParameters": true }
```

```js
// eslint.config.js — НЕ отключать глобально
// 'react-hooks/exhaustive-deps': 'off'  ← запрещено
// Использовать eslint-disable-line только с комментарием WHY
```

## Компактный дропдаун — `AppSelect`, не Radix `DropdownMenu` (2026-09-09/10)

Живой репорт (реальная мышь, не Playwright-артефакт): Radix `DropdownMenu` в узкой колонке
ловил клики по пункту меню ненадёжно — открывался, но `onSelect` не всегда срабатывал.
`AppSelect` (`shared/components/select/AppSelect.tsx`) — свой велосипед на plain `onClick` +
локальный React state (не Radix Portal/`PointerEvent`-capture машинерия) — уже используется для
выбора модели, переиспользуется и как компактный переключатель режима (не обязательно «форма» с
персистентным значением — можно с `value=""` + `triggerContent` для чисто action-меню).

```tsx
// ❌ Radix DropdownMenu для компактного переключателя в узкой колонке — клик по пункту
// не долетает до onSelect надёжно (воспроизведено вживую)
<DropdownMenu.Root>
  <DropdownMenu.Trigger><IconButton>{icon}</IconButton></DropdownMenu.Trigger>
  <DropdownMenu.Content>
    <DropdownMenu.Item onSelect={() => onChange('a')}>A</DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>

// ✅ AppSelect — компактный, hideChevron для минимальной ширины
<AppSelect
  size="compact" menuStrategy="floating" plainTrigger hideChevron
  options={[{ id: 'a', label: 'A', leading: <IconA /> }]}
  value={mode} onChange={(id) => onChange(id as Mode)}
  triggerContent={ICONS[mode]}
/>
```

Для action-меню без персистентного значения (импорт/экспорт и подобное) — либо тот же `AppSelect`
с `value=""`, либо свой попап на `useClickOutside` (`shared/hooks/useClickOutside.ts`) + plain
`onClick`, эталон — `WorkflowFlowIoMenu.tsx`.

## Нативный `<button>`, не Radix `Button`, для критичных одиночных действий

Найдено живьём: file-attach кнопка (`AnimatedAIInput.tsx`) на Radix `Button` не открывала file
picker; на нативном `<button type="button">` — заработала (тот же паттерн, что уже рабочий
Telegram-композер, `TgComposerActionButtons.tsx`). Для одиночных критичных кнопок (открыть
системный file picker, что-то, чей провал незаметен пользователю до отправки формы) —
предпочитать нативный `<button>` со своим CSS-классом над Radix `Button`, особенно если рядом
уже есть проверенный работающий нативный эталон.

## `forwardRef` + `useImperativeHandle` — когда диалог живёт в потомке, а кнопка — в родителе

Диалог/связанный state органично живёт в компоненте, у которого уже есть нужные данные
(например, canvas-компонент с `nodes`/`edges`), но кнопка-триггер должна быть в родительском
тулбаре (другая часть страницы/лейаута). Не дублировать state в родителе и не тащить весь диалог
вверх без необходимости — экспонировать императивный хендл:

```tsx
export interface ChildHandle { openDialog: () => void }

export const Child = forwardRef<ChildHandle, Props>(function Child(props, ref) {
  const [open, setOpen] = useState(false)
  useImperativeHandle(ref, () => ({ openDialog: () => setOpen(true) }), [])
  return <>{/* ... */}<Dialog.Root open={open} onOpenChange={setOpen}>...</Dialog.Root></>
})

// В родителе:
const childRef = useRef<ChildHandle>(null)
<button onClick={() => childRef.current?.openDialog()}>Открыть</button>
<Child ref={childRef} {...props} />
```

Эталон — `ProcessCanvasHandle` (`pages/authorized/settings/workflows/tabs/processes-tab/ProcessCanvas.tsx`).

## Кросс-страничный layout-state — `window`-событие, не только `localStorage`

Когда ДВЕ разные страницы (разные React-поддеревья, не общий родитель в одном дереве) должны
знать текущее значение друг у друга В РЕАЛЬНОМ ВРЕМЕНИ (не только при следующей загрузке
страницы) — `localStorage` сам по себе не реактивен для того же таба/окна. Паттерн — тот же, что
`LOCALIZATION_SETTINGS_CHANGED` в `i18n/useAppTranslation.ts`:

```ts
const CHANGE_EVENT = 'my-cross-page-state-changed'
function useMyState() {
  const [value, setValue] = useState(readFromStorage)
  useEffect(() => {
    const onChange = () => setValue(readFromStorage())
    window.addEventListener(CHANGE_EVENT, onChange)
    return () => window.removeEventListener(CHANGE_EVENT, onChange)
  }, [])
  const set = useCallback((next) => {
    setValue(next); writeToStorage(next)
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }, [])
  return [value, set] as const
}
```

Эталон — `useWorkflowAiAssistantLayoutMode.ts`.

## `RadixThemePortal` — обязателен для любого `position: fixed` вне обычного стека

`shared/components/RadixThemePortal.tsx` — портал в `document.body` с собственным `<Theme>`.
Причина: `backdrop-filter` у предков-лэйаутов ломает stacking context для `fixed`-потомков —
без портала плавающее окно/тултип может оказаться визуально «под» другим контентом несмотря на
высокий `z-index`. Использовать для: плавающих окон (drag+resize), калькуляторов/виджетов,
свёрнутых «плашек» — не для обычных Dialog/Popover (у тех Radix уже портирует сам).

## `${var}` в `defaultValue` — запрещено, только i18next `{{var}}`

```tsx
// ❌ JS backtick-темплейт — сам по себе интерполируется JS до вызова t(), но статический
// экстрактор scripts/generate-ru-defaults-flat.mjs берёт RAW-текст между кавычками регэкспом,
// не выполняет JS — ${allowedCount} застревает в бандле буквально
t('key', { added: n, defaultValue: `Добавлено ${n} файлов` })

// ✅ i18next-мустаче — интерполируется runtime'ом i18next из тех же опций t()
t('key', { added: n, defaultValue: 'Добавлено {{added}} файлов' })
```

Тот же баг, что переименование строки не проявляется в браузере, пока не перегнать
`npm run i18n:generate-ru-flat` — RU runtime-бандл (`src/locales/data/ruDefaultValuesFlat.json`
→ `src/i18n/locales/ru.ts`) приоритетнее инлайнового `defaultValue` и его нужно регенерировать
после ЛЮБОГО изменения RU-текста в `t()`-вызовах, не только при добавлении новых ключей.

> **Обновление 2026-09-21.** Механизм выше — причина не только «плейсхолдер виден буквально», но и системной подмены строк:
> старый генератор искал «ближайший `defaultValue` в окне 20 000 символов», и ключ с литеральным `'…'` получал СЛЕДУЮЩИЙ
> шаблонный `defaultValue` файла (`hiringPlanPage.daysShort` → «Закрыта ${r.statusDate}» вместо «дн.»; 219 ключей RU-бандла,
> плюс 10 обрезанных строк в каждой из 20 локалей). Теперь `scripts/lib/extractTranslationDefaults.mjs` разбирает AST:
> каждый `t('key', {…})` даёт только СВОЙ `defaultValue`, а шаблоны с `${}` в бандл не попадают (рантайм берёт inline-значение).
> `{{var}}` по-прежнему предпочтителен — такая строка переводима. Страховка: `src/locales/ruDefaultValuesFlat.test.ts`
> (в бандле и в JSON локалей нет литеральных `${…}`; закоммиченный бандл совпадает со свежей сборкой — иначе «перегенерируйте»).
> Переопределения переводов пользователя (`translation_overrides` в профиле) перекрывают бандл: значения с литеральным `${…}`
> отбрасываются при чтении (`normalizeTranslationOverrideRow`).
