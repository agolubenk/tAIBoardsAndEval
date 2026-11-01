import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vite-plus/test";

function renderBundle(bundle: string, key = "") {
  return execFileSync(
    "awk",
    ["-f", resolve(import.meta.dirname, "../env.awk")],
    {
      input: bundle,
      encoding: "utf8",
      env: {
        ...process.env,
        KANEO_TURNSTILE_SITE_KEY: key,
        KANEO_API_URL: "https://api.example.test",
        KANEO_CLIENT_URL: "https://app.example.test",
      },
    },
  );
}
describe("runtime environment replacement", () => {
  it("clears unset optional placeholders for every emitted literal quote", () => {
    const rendered = renderBundle(
      "globalThis.values = [\"KANEO_TURNSTILE_SITE_KEY\", 'KANEO_TURNSTILE_SITE_KEY', `KANEO_TURNSTILE_SITE_KEY`, 'https://example.test'];",
    );
    const context: { values?: string[] } = {};
    runInNewContext(rendered, context);
    expect(context.values).toEqual(["", "", "", "https://example.test"]);
  });
  it("encodes configured punctuation as literal data rather than JavaScript", () => {
    const key = '";globalThis.injected=true;//\\\n`';
    const context: { value?: string; injected?: boolean } = {};
    runInNewContext(
      renderBundle('globalThis.value = "KANEO_TURNSTILE_SITE_KEY";', key),
      context,
    );
    expect(context.value).toBe(key);
    expect(context.injected).toBeUndefined();
  });
});

describe("runtime environment and the asset cache", () => {
  it("lists rewritten assets for revalidation and keeps them across a restart", async () => {
    const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "kaneo-env-"));
    mkdirSync(join(root, "html", "assets"), { recursive: true });
    writeFileSync(
      join(root, "html", "assets", "auth-a1.js"),
      'a="KANEO_API_URL";',
    );
    writeFileSync(
      join(root, "html", "assets", "plain-b2.js"),
      "console.log(1);",
    );
    const include = join(root, "assets.inc");
    const run = () =>
      execFileSync("sh", [resolve(import.meta.dirname, "../env.sh")], {
        encoding: "utf8",
        env: {
          ...process.env,
          KANEO_ASSET_ROOT: join(root, "html"),
          KANEO_ASSET_INCLUDE: include,
          KANEO_API_URL: "https://api.example.test",
          KANEO_CLIENT_URL: "https://app.example.test",
        },
      });

    run();
    const expected = "location = /assets/auth-a1.js { expires epoch; }";
    expect(readFileSync(include, "utf8")).toContain(expected);
    expect(readFileSync(include, "utf8")).not.toContain("plain-b2.js");
    expect(
      readFileSync(join(root, "html", "assets", "auth-a1.js"), "utf8"),
    ).toBe('a="https://api.example.test";\n');

    // A restart finds nothing left to rewrite but keeps the earlier list, so
    // the chunk never becomes cacheable for a year while it holds env values.
    run();
    expect(readFileSync(include, "utf8")).toContain(expected);
  });
});
