import { eq } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { mockAuthenticatedSession } from "./helpers/auth";
import { createInstanceAdmin } from "./helpers/admin/create-instance-admin";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";
import { projectAccessApi } from "./helpers/project-access/project-access-api";

// Synthetic values only; none of these is a real key.
const MODEL_KEY = "sk-test-settings-key";
const SETTINGS_KEY = "test-settings-encryption-key";

async function storedRow() {
  const [row] = await db
    .select()
    .from(schema.instanceSettingTable)
    .where(eq(schema.instanceSettingTable.key, "notebook.model"));
  return row ?? null;
}

async function asAdmin() {
  mockAuthenticatedSession(await createInstanceAdmin());
  return projectAccessApi();
}

describe("API integration: notebook model settings", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.stubEnv("NOTEBOOK_LLM_MODEL", "");
    vi.stubEnv("NOTEBOOK_LLM_KEY_FILE", "");
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", SETTINGS_KEY);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is limited to instance administrators", async () => {
    const { user } = await createWorkspaceMember("owner");
    mockAuthenticatedSession(user);
    const request = projectAccessApi();

    expect((await request("/admin/notebook-model")).status).toBe(403);
    const put = await request("/admin/notebook-model", {
      method: "PUT",
      body: { model: "x/y" },
    });
    expect(put.status).toBe(403);
    expect(await storedRow()).toBeNull();
  });

  it("stores the key sealed and never returns it", async () => {
    const request = await asAdmin();

    const put = await request("/admin/notebook-model", {
      method: "PUT",
      body: { model: "openai/gpt-4o-mini", dailyMax: 40, key: MODEL_KEY },
    });
    expect(put.status).toBe(200);
    const text = await put.text();
    expect(text).not.toContain(MODEL_KEY);
    expect(JSON.parse(text)).toMatchObject({
      model: "openai/gpt-4o-mini",
      dailyMax: 40,
      hasKey: true,
      keySource: "settings",
      keyUnreadable: false,
      canStoreKey: true,
    });

    const row = await storedRow();
    expect(row?.value).toContain("enc:v1:");
    expect(row?.value).not.toContain(MODEL_KEY);
    expect(row?.updatedBy).toMatch(/^admin-/);
  });

  it("keeps fields left out and clears fields set to null", async () => {
    const request = await asAdmin();
    await request("/admin/notebook-model", {
      method: "PUT",
      body: { model: "a/b", embedModel: "bge-m3", key: MODEL_KEY },
    });

    const kept = await request("/admin/notebook-model", {
      method: "PUT",
      body: { dailyMax: 7 },
    });
    expect(await kept.json()).toMatchObject({
      model: "a/b",
      embedModel: "bge-m3",
      dailyMax: 7,
      keySource: "settings",
    });

    const cleared = await request("/admin/notebook-model", {
      method: "PUT",
      body: { model: null, key: null },
    });
    expect(await cleared.json()).toMatchObject({
      model: null,
      embedModel: "bge-m3",
      hasKey: false,
      keySource: null,
    });
  });

  it("refuses a key while the server has no settings encryption key", async () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY_FILE", "/nonexistent/settings_key");
    const request = await asAdmin();

    const view = await request("/admin/notebook-model");
    expect(await view.json()).toMatchObject({ canStoreKey: false });

    const put = await request("/admin/notebook-model", {
      method: "PUT",
      body: { key: MODEL_KEY },
    });
    expect(put.status).toBe(409);
    expect(await storedRow()).toBeNull();
  });

  it("reports a stored key the server can no longer open", async () => {
    const request = await asAdmin();
    await request("/admin/notebook-model", {
      method: "PUT",
      body: { key: MODEL_KEY },
    });

    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "another-settings-key");
    const view = await request("/admin/notebook-model");
    expect(await view.json()).toMatchObject({
      hasKey: false,
      keySource: null,
      keyUnreadable: true,
    });
  });

  it("rejects a malformed address and an out-of-range limit", async () => {
    const request = await asAdmin();
    for (const body of [{ baseUrl: "not a url" }, { dailyMax: -1 }]) {
      const put = await request("/admin/notebook-model", {
        method: "PUT",
        body,
      });
      expect(put.status).toBe(400);
    }
    expect(await storedRow()).toBeNull();
  });
});
