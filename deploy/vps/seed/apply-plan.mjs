#!/usr/bin/env node
// Brings a live board to products.json over REST with a user API key: adds the
// planned cards it lacks (with their plan key in the card fields, so the seed
// later sees them as present) and moves cards whose planned status changed.
// The seed itself only adds; this is for a board that is already in use.
// Cards are matched by the plan key (card meta backlogId), never by number or
// title, so cards added by hand on the board are left alone.
// Dry run by default; --apply writes.
//   T_BOARDS_API_KEY=… node apply-plan.mjs [--apply] [--product aiboards-eval]
import { readFileSync } from "node:fs";

const base = (
  process.env.T_BOARDS_URL ?? "https://d4dev.admin.hrhelper.space"
).replace(/\/$/, "");
const key = process.env.T_BOARDS_API_KEY;
const apply = process.argv.includes("--apply");
const only = process.argv.includes("--product")
  ? process.argv[process.argv.indexOf("--product") + 1]
  : null;
if (!key) {
  console.error("нет T_BOARDS_API_KEY");
  process.exit(1);
}
const plan = JSON.parse(
  readFileSync(new URL("./products.json", import.meta.url), "utf8"),
);

async function api(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `${init.method ?? "GET"} ${path} → ${res.status} ${text.slice(0, 300)}`,
    );
  return text ? JSON.parse(text) : null;
}
const list = (x) => (Array.isArray(x) ? x : (x?.data ?? []));

async function boardTasks(projectId) {
  const tasks = [];
  for (let page = 1; ; page++) {
    const board = await api(
      `/api/task/tasks/${projectId}?limit=100&page=${page}`,
    );
    for (const column of board.data.columns) tasks.push(...column.tasks);
    tasks.push(...board.data.plannedTasks);
    if (page >= (board.pagination?.totalPages ?? 1)) return tasks;
  }
}

const workspaces = list(await api("/api/workspace"));
let failed = 0;
for (const product of plan.products) {
  if (only && product.slug !== only) continue;
  const ws = workspaces.find((w) => w.slug === product.slug);
  if (!ws) {
    console.log(`${product.slug}: нет на доске — сначала seed`);
    continue;
  }
  const projects = list(await api(`/api/project?workspaceId=${ws.id}`));
  for (const planned of product.projects) {
    if (!planned.cards.length) continue;
    const project = projects.find(
      (p) => p.slug?.toLowerCase() === planned.key.toLowerCase(),
    );
    if (!project) {
      console.log(`${product.slug}/${planned.key}: проекта нет — сначала seed`);
      continue;
    }
    const byKey = new Map();
    for (const task of await boardTasks(project.id)) {
      const meta = await api(`/api/forest/${ws.id}/cards/${task.id}/meta`);
      if (meta?.backlogId) byKey.set(meta.backlogId, task);
    }
    for (const card of planned.cards) {
      const task = byKey.get(card.key);
      try {
        if (!task) {
          console.log(`+ ${card.key} ${card.status} «${card.title}»`);
          if (!apply) continue;
          const body = {
            title: card.title,
            description: card.description,
            priority: card.priority,
            status: card.status,
          };
          const created = await api(`/api/task/${project.id}`, {
            method: "POST",
            body: JSON.stringify(body),
          });
          await api(`/api/forest/${ws.id}/cards/${created.id}/meta`, {
            method: "PUT",
            body: JSON.stringify({ backlogId: card.key }),
          });
        } else if (task.status !== card.status) {
          console.log(`~ ${card.key} ${task.status} → ${card.status}`);
          if (!apply) continue;
          await api(`/api/task/status/${task.id}`, {
            method: "PUT",
            body: JSON.stringify({ status: card.status }),
          });
        }
      } catch (error) {
        failed++;
        console.error(`! ${card.key}: ${error.message}`);
      }
    }
  }
}
console.log(
  apply ? `применено, ошибок: ${failed}` : "сухой прогон — для записи --apply",
);
process.exit(failed ? 1 : 0);
