---
description: Use when working with React components, hooks, state, routing, i18n strings, frontend tests, and frontend gates (bundle, typecheck) in apps/frontend.
---

# React Feature

Project rules: `.claude/rules/03-frontend.md` and the root CLAUDE.md — FSD (`shared/` never imports `features/`), no static import of `exceljs`/`pdfjs-dist`, DOMPurify for any HTML, files up to 500 lines.

- Functional components with hooks, typed props, React Router for navigation, React Hook Form for forms.

## Before implementing

- Single-instance primitives (router blocker, `beforeunload` guard, global toasts, global listeners): grep for the existing app-level owner and extend it. A second instance silently shadows the first.
- Every placeholder for self-fetched content has three states: loading (animated), loaded, failed (static, visually distinct, retry nearby). The failure path gets a test, or every backend outage gets reported as an "empty widget" bug.

## Strings and i18n

- After any change to a RU `defaultValue`, run `npm run i18n:generate-ru-flat` in `apps/frontend`: the generated bundle takes precedence over inline defaults.
- Interpolation in defaults is `{{var}}`, never `${var}` — the extractor reads raw text and does not execute JS.
- Plurals: when the bundle is generated from defaults, use suffixed `defaultValue_one` / `_few` / `_many` / `_other` without a plain `defaultValue`; use neutral abbreviations («дн.») for unit labels.
- A string that points to another screen names it through the same i18n key the target renders (interpolated), or names only the stable parent and lets the link carry the label. A duplicated literal rots silently.
- Module bundles for many locales: derive the key set from the generated source bundle, reuse each locale's existing terminology, and check only your own bundle. For bulk translation, emit one line per key in source order and refuse to write when the line count, the `{{placeholders}}` or the key order differ from the source.

## Tests

- Files using `*Once` mock queues reset them in `beforeEach` (`mockReset()` per mock or `vi.resetAllMocks()`; `clearAllMocks` keeps queued values). A leaked queue makes a regression test pass vacuously.
- A regression test counts only after it has been seen red against the code it guards.

## Verification before review

- A user-visible feature goes to review only after a short live click-through: the golden path plus one error path, optional flags on. Write down what was exercised.
- Pages with SSE or WebSocket never reach `networkidle` — wait for a concrete element. When the dev server also serves source modules over HTTP, mock API calls by an exact pathname prefix (a predicate), not a glob.
- Measure visual complaints in pixels and in scrolled states, not only by element rects: identical rects can hide a shadow band or an invisible clip.

## Gates

- Typecheck is `tsc -b` / `npm run build`; `npx tsc --noEmit` in `apps/frontend` is a no-op. The build needs `NODE_OPTIONS=--max-old-space-size=6144` (the npm scripts set it).
- A failing bundle budget: run `npm run bundle:check` on base and branch with identical dependencies and report the delta in the PR.
