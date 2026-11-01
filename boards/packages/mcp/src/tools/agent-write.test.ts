import { describe, expect, it, vi } from "vite-plus/test";
import { splitAgentWrite, withHeaders } from "./agent-write.js";

describe("splitAgentWrite", () => {
  it("moves lease and approval fields into headers", () => {
    const { headers, rest } = splitAgentWrite({
      taskId: "t1",
      status: "done",
      session: "dev-1",
      fencingToken: 3,
      approvalId: "ap-1",
      groupKey: undefined,
    });

    expect(rest).toEqual({ taskId: "t1", status: "done" });
    expect(headers).toEqual({
      "x-t-boards-session": "dev-1",
      "x-t-boards-fence": "3",
      "x-t-boards-approval": "ap-1",
    });
  });

  it("sends the note percent-encoded and the link as is", () => {
    const { headers, rest } = splitAgentWrite({
      status: "in-review",
      note: "Готово: тесты «зелёные»",
      link: "https://github.com/agolubenk/t-boards/pull/7",
    });

    expect(rest).toEqual({ status: "in-review" });
    expect(decodeURIComponent(headers["x-t-boards-note"] ?? "")).toBe(
      "Готово: тесты «зелёные»",
    );
    expect(headers["x-t-boards-note"]).toMatch(/^[\x20-\x7e]+$/);
    expect(headers["x-t-boards-link"]).toBe(
      "https://github.com/agolubenk/t-boards/pull/7",
    );
  });
});

describe("withHeaders", () => {
  it("adds the headers to every call and keeps the caller's own", async () => {
    const client = { json: vi.fn().mockResolvedValue({}) };

    await withHeaders(client, { "x-t-boards-fence": "3" }).json("/api/x", {
      method: "PUT",
      headers: { "x-other": "1" },
    });

    expect(client.json).toHaveBeenCalledWith("/api/x", {
      method: "PUT",
      headers: { "x-other": "1", "x-t-boards-fence": "3" },
    });
  });

  it("returns the client itself when there is nothing to add", () => {
    const client = { json: vi.fn() };

    expect(withHeaders(client, {})).toBe(client);
  });
});
