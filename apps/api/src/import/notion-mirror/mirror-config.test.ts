import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_MAX_GAP_HOURS,
  DEFAULT_MIRROR_CRON,
  readMirrorConfig,
  readMirrorToken,
} from "./mirror-config";

const BASE = {
  NOTION_MIRROR_WORKSPACE_ID: "ws-1",
  NOTION_MIRROR_TOKEN_FILE: "/run/secrets/notion",
  NOTION_MIRROR_DATABASES: "db-a, db-b,,db-a",
};

describe("readMirrorConfig", () => {
  it("is off until the workspace, token file and databases are all set", () => {
    expect(readMirrorConfig({})).toBeNull();
    expect(
      readMirrorConfig({ ...BASE, NOTION_MIRROR_DATABASES: " , " }),
    ).toBeNull();
    expect(
      readMirrorConfig({ ...BASE, NOTION_MIRROR_TOKEN_FILE: "" }),
    ).toBeNull();
  });

  it("dedupes databases and applies defaults", () => {
    expect(readMirrorConfig(BASE)).toEqual({
      workspaceId: "ws-1",
      databaseIds: ["db-a", "db-b"],
      tokenFile: "/run/secrets/notion",
      product: undefined,
      cron: DEFAULT_MIRROR_CRON,
      maxGapHours: DEFAULT_MAX_GAP_HOURS,
    });
  });

  it("ignores a gap that is not a positive number", () => {
    expect(
      readMirrorConfig({ ...BASE, NOTION_MIRROR_MAX_GAP_HOURS: "-1" })
        ?.maxGapHours,
    ).toBe(DEFAULT_MAX_GAP_HOURS);
    expect(
      readMirrorConfig({ ...BASE, NOTION_MIRROR_MAX_GAP_HOURS: "26" })
        ?.maxGapHours,
    ).toBe(26);
  });
});

describe("readMirrorToken", () => {
  it("reads and trims the token file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mirror-token-"));
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, "ntn_synthetic\n");
    const config = readMirrorConfig({
      ...BASE,
      NOTION_MIRROR_TOKEN_FILE: tokenFile,
    });
    expect(config && readMirrorToken(config)).toBe("ntn_synthetic");
  });

  it("names neither the path nor the value when the file is missing", () => {
    const config = readMirrorConfig({
      ...BASE,
      NOTION_MIRROR_TOKEN_FILE: "/nonexistent/notion-token",
    });
    expect(() => config && readMirrorToken(config)).toThrow(
      "NOTION_MIRROR_TOKEN_FILE could not be read (ENOENT)",
    );
  });
});
