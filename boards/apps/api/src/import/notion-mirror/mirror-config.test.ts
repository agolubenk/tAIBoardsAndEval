import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_MAX_GAP_HOURS,
  DEFAULT_MIRROR_CRON,
  mirrorDatabaseOrder,
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
      discover: false,
      tokenFile: "/run/secrets/notion",
      product: undefined,
      cron: DEFAULT_MIRROR_CRON,
      maxGapHours: DEFAULT_MAX_GAP_HOURS,
    });
  });

  it("turns discovery on with all, alone or after listed databases", () => {
    const all = readMirrorConfig({ ...BASE, NOTION_MIRROR_DATABASES: "ALL" });
    expect(all).toMatchObject({ databaseIds: [], discover: true });
    expect(
      readMirrorConfig({ ...BASE, NOTION_MIRROR_DATABASES: "db-a, all ,db-a" }),
    ).toMatchObject({ databaseIds: ["db-a"], discover: true });
  });

  it("orders listed databases first, then discovered ones by title", () => {
    expect(
      mirrorDatabaseOrder(
        ["256853cd-b4ae-4394-a768-a2a2ebd3c5fe", "db-b"],
        [
          { id: "db-z", title: "Sprints" },
          { id: "256853cdb4ae4394a768a2a2ebd3c5fe", title: "Задачи" },
          { id: "db-c", title: "Projects" },
          { id: "db-b", title: "Ошибки" },
        ],
      ),
    ).toEqual(["256853cd-b4ae-4394-a768-a2a2ebd3c5fe", "db-b", "db-c", "db-z"]);
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
