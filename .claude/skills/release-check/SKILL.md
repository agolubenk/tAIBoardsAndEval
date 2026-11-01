---
description: Use when preparing a merge to main or a release, running or interpreting gates and CI, changing deploy scripts/compose/nginx, or verifying a production deploy. In this repo a push to main with non-md changes deploys production.
---

# Release Check

A push to `main` with non-md changes deploys production immediately (`deploy-contabo.yml` on the self-hosted runner, CI is not awaited). GitHub-hosted CI does not start (billing is off), so every gate is local. Work through the sections in order; each one ends in something you can show.

## 1. Baseline before judging the change

- List what is already red on the base before judging the branch: the last runs of the gates you rely on and their failing step. For each failure on the branch, decide "pre-existing" or "introduced" by re-running the same command on a worktree from `origin/main`. The gate is "no new failures, and the deploy gates pass", not "everything green".
- Record the baseline count of each verify command (typecheck errors, lint warnings, test totals) before the first edit, and report gates as a delta against it.
- An aggregate gate (bundle size, performance budget) that fails says nothing about who caused it. Run it on base and branch with identical dependencies (`npm run bundle:check` in `apps/frontend` on both) and put the delta in the PR — neither excuse it nor "fix" it blindly.
- Gate results count only on a lock-exact install. Compare a third-party package's installed version with `package-lock.json` (`node -p "require('multer/package.json').version"` against the lock entry): a check that only resolves a workspace package proves nothing about the shared third-party install.

## 2. Gates go through the task runner

- Run `turbo run lint|typecheck|test:run --filter=<pkg>`, never the package script directly: dependency edges such as `@hr-helper/dto#build` before `@hr-helper/utils#test:run` exist only when turbo launches the task. Check the graph with `npx turbo run test:run --filter=<pkg> --dry=json`.
- Frontend typecheck is `tsc -b` / `npm run build`; `npx tsc --noEmit` inside `apps/frontend` is a silent no-op.
- Run tests only through the package's own script or its local binary (`npm run test:run -- <file>`, `npx --no-install vitest`). Before the first spec in a package, read its `test`/`test:run` scripts and one neighbouring spec: a bare `npx <runner>` can silently download a different runner.
- For every app the change touches, check that some workflow's path filters include it; say explicitly when an app has no CI coverage at all.
- A new directory gets a `.gitignore` for its language artifacts first; read `git status --short <dir>` before committing it.
- A PR that claims to be inert (docs, refactor) still deploys if it touches any non-md file. Classify every changed line of `git diff origin/main...HEAD` (comments, whitespace, docs, code) and, if `schema.prisma` is touched, run the schema-to-schema diff from the db-migration skill. Attach the table to the PR and spend review only on the residue.
- A new gate is wired in only after four checks: identical output across fresh runs; distinct exit codes for ok / violation / tool error; the same inputs CI will see; and a planted defect that makes it fail.

## 3. Deploy-path changes (`infra/`, compose files, nginx, `infra/scripts/prod/*.sh`)

- Simulate every context the script runs in: first run, re-run (idempotence), piped stdin without a TTY, root on the runner, after a data import. Reading the script top to bottom is not a review.
- `docker compose exec`, `ssh` and `kubectl exec` inside a `while read` loop get `</dev/null`, or they swallow the loop's input. Mocks of such tools must consume stdin like the real tool. Capture exit codes without a pipe: `cmd > log 2>&1; rc=$?`.
- In a simulation harness, capture real tool paths before prepending fakes (`REAL_GIT=$(command -v git)`), assert that every artifact the harness extracts for itself is non-empty, and prove the test is sensitive by showing the previous version of the script fails it. A harness that has caught real regressions twice gets committed, not rebuilt in a scratchpad.
- Bind-mounted config (nginx, ops agent) is not part of any image: for each changed bind-mounted path the deploy must recreate or reload exactly its consumers. Check what the running container sees (`docker exec … ls` / `grep`), not only the file on disk — a new file referenced by a mounted config can arm a failure that fires on the next restart.
- Before restarting a multi-file compose stack, read each container's provenance (config-files label, mounts, profiles) and build before any `down`/`up`, so a failed build leaves the running stack alone.
- Runbook prerequisites rot between uses: check that every env var, gitignored secret file and host port the runbook relies on actually exists before following it.
- Repointing a live hostname: list what users reach there today and keep it working or redirected; verify any asset a pasted plan names against git history.
- Proxy rate-limit, cache or routing changes: a syntax test for every deployed variant (render templates with dummy values), plus a behavioural A/B against the baseline config under a scripted load that exercises each promised property and the abuse case the change could open (for example randomized keys). The before/after table goes into the approval request.
- Upgrading or reconfiguring a third-party service (proxy, optimizer, cache, log store): read the vendor's retention, compaction and fallback rules before writing the check. A "history preserved" check compares only the window the vendor guarantees and archives the rest outside the tool; an optimization check asserts a minimum effect end to end (bytes or tokens in vs out at a mock upstream) and is shown to fail on a known no-op configuration before its PASS counts.

## 4. Merge to main (= production)

- Immediately before the merge: `git fetch`, merge `origin/main` into the branch, re-run the gates if the base moved, and resolve conflicts in deploy/CI files by taking main's logic and diffing the result against main. Then `gh run list --workflow deploy-contabo.yml -L 2` — no deploy may be in progress.
- Several PRs: plan by deploy boundary — batch, isolate, or no-deploy (`[skip ci]` in the merge commit subject for council and docs merges) — not by PR count. Take an HTTP baseline of every new surface before the deploy.
- Before a batch of merges, octopus-merge the open PR heads in a scratch worktree with a lock-exact install, run the full gate once on the union, then quick per-PR runs. Report conflicts and the files whose result depends on merge order to whoever merges.

## 5. After the deploy

- Confirm the deploy run itself (`gh run view <id> --json conclusion,headSha`), not a relayed status. A red deploy is not yet a broken prod: probe it. Exit code 4 right after a cancelled run is the deploy lock — re-run, no new commit.
- Prove the new build is live by a fingerprint visible from outside: the hashed entry asset changes with every frontend deploy (`curl -s https://app.hrhelper.space/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'`). Then `/api/v1/health/ready` and `/`. Judge visuals only after media has loaded.
- Calibrate a probe before trusting a polling loop: run it once against a known-good target and print the raw error class; never collapse different failures into one "ERR".
- Multi-hop flows (OAuth, redirects, webhooks): verify every hop separately, including an unauthenticated probe of the callback the third party calls.
- Mobile and store builds: inspect the built artifact (Info.plist keys, embedded manifests, signing identity, profile expiry), not the project config.

## 6. CI failure triage

- Read the platform's job details first: steps executed, runner, annotations (`gh run view <id> --json jobs`). Zero steps and no runner means the job never started (billing, runner) — that says nothing about the change; check main and sibling branches for the same.
- After a long outage, failures are stacked: list failing steps per workflow, fix the earliest one, re-run, repeat. File pre-existing red gates as cards instead of accepting them silently.

## 7. Report

- Every pass/fail count is reported with the literal command that produced it, so someone else can re-run it. When verifying another session's counts, re-run their command first and flag any mismatch.
- Name what was not checked live, and why.
