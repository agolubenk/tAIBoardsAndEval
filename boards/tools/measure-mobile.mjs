// AC-018 probe: a 400 px phone on 3G with a 4x slower CPU opens a board and
// then a card. Records time to the first card, time to the card view, request
// count and bytes on the wire (cold cache and warm), horizontal overflow and
// the interface language. Needs a running web (vp preview) and API.
// Usage: MEASURE_EMAIL=… MEASURE_PASSWORD=… node boards/tools/measure-mobile.mjs \
//   --web http://localhost:5173 --api http://localhost:1337 --workspace <id> --project <id>
//   [--out dir] [--locale ru-RU] [--network 3g|none] [--cpu 4]
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// require() honours NODE_PATH, so a globally installed Playwright works too.
const { chromium } = createRequire(import.meta.url)("playwright");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const web = arg("web", "http://localhost:5173");
const api = arg("api", "http://localhost:1337");
const workspace = arg("workspace");
const project = arg("project");
const out = arg("out", "measure-out");
const locale = arg("locale", "ru-RU");
if (!workspace || !project) throw new Error("--workspace and --project are required");

// WebPageTest «3G»: 1.6 Mbps down, 768 Kbps up, 300 ms RTT; CPU 4x slower.
const NETWORK = {
  offline: false,
  latency: 300,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (768 * 1024) / 8,
};
const CPU_SLOWDOWN = Number(arg("cpu", "4"));
const THROTTLE = arg("network", "3g") !== "none";
const CARD = '[data-task-id], [data-testid="task-card"], a[href*="/task/"]';

async function signIn(context) {
  const res = await context.request.post(`${api}/api/auth/sign-in/email`, {
    headers: { Origin: web },
    data: {
      email: process.env.MEASURE_EMAIL,
      password: process.env.MEASURE_PASSWORD,
    },
  });
  if (!res.ok()) throw new Error(`sign-in ${res.status()}`);
}

async function run(browser, label, warm) {
  const context = await browser.newContext({
    viewport: { width: 400, height: 860 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale, // the browser language picks the UI language when supported; RU otherwise (i18n/resources.ts)
  });
  await signIn(context);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: !warm });
  let requests = 0;
  let bytes = 0;
  cdp.on("Network.loadingFinished", (e) => {
    requests += 1;
    bytes += e.encodedDataLength;
  });
  const board = `${web}/dashboard/workspace/${workspace}/project/${project}/board`;
  if (warm) await page.goto(board, { waitUntil: "networkidle" });
  if (THROTTLE) await cdp.send("Network.emulateNetworkConditions", NETWORK);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
  requests = 0;
  bytes = 0;

  const t0 = Date.now();
  await page.goto(board, { waitUntil: "commit" });
  await page.locator(CARD).first().waitFor({ state: "visible", timeout: 120_000 });
  const toBoard = Date.now() - t0;
  const boardRequests = requests;
  const boardBytes = bytes;
  const layout = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    lang: document.documentElement.lang,
    cyrillic: /[А-Яа-яЁё]/.test(document.body.innerText),
  }));
  await page.screenshot({ path: join(out, `${label}-board.png`) });

  // The card view is ready when its title is shown as a heading; the app keeps
  // a live connection, so "network idle" never comes and is not a signal.
  const title = (await page.locator(CARD).first().innerText())
    .split("\n")
    .map((s) => s.trim())
    .reduce((a, b) => (b.length > a.length ? b : a), "");
  const t1 = Date.now();
  await page.locator(CARD).first().click();
  // The card opens over the board (`?taskId=`); its title is an editable
  // textarea, so readiness is that textarea holding the card's title.
  await page.waitForFunction(
    (expected) =>
      [...document.querySelectorAll("textarea")].some((t) => t.value === expected),
    title,
    { timeout: 60_000 },
  );
  const toCard = Date.now() - t1;
  const cardOverflowX = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  await page.screenshot({ path: join(out, `${label}-card.png`) });
  await context.close();
  return {
    label,
    toBoardMs: toBoard,
    boardRequests,
    boardTransferKb: Math.round(boardBytes / 102.4) / 10,
    toCardMs: toCard,
    overflowXPx: layout.overflowX,
    cardOverflowXPx: cardOverflowX,
    htmlLang: layout.lang,
    russianText: layout.cyrillic,
  };
}

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const results = [];
for (const [label, warm] of [
  ["cold-3g", false],
  ["warm-3g", true],
]) {
  results.push(await run(browser, label, warm));
}
await browser.close();
const report = { network: THROTTLE ? NETWORK : "none", cpuSlowdown: CPU_SLOWDOWN, viewport: "400x860", locale, results };
writeFileSync(join(out, "mobile.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
