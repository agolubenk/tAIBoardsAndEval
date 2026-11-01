import { describe, expect, it } from "vite-plus/test";
import { callDetail } from "./call-detail";

const call = { tool: "get_task", ok: true, bytes: 120, tokens: 30, ms: 4 };

describe("callDetail", () => {
  it("keeps the sizes and the sent arguments", () => {
    const detail = JSON.parse(callDetail({ ...call, args: { id: "t1" } }));

    expect(detail).toEqual({
      bytes: 120,
      tokens: 30,
      ms: 4,
      args: '{"id":"t1"}',
    });
  });

  it("replaces a secret in the arguments with a label", () => {
    const secret = "postgres://probe:not-a-real-pass@db.local:5432/x";
    const detail = callDetail({ ...call, args: { description: secret } });

    expect(detail).not.toContain("not-a-real-pass");
    expect(detail).toContain("[REDACTED:db_url]");
  });

  it("cuts long arguments and stays valid JSON under the journal limit", () => {
    const detail = callDetail({
      ...call,
      args: { text: "word ".repeat(2000) },
    });

    expect(detail.length).toBeLessThanOrEqual(2000);
    expect(JSON.parse(detail).args.endsWith("…")).toBe(true);
  });

  it("measures the cut after escaping, so quotes cannot overflow it", () => {
    const detail = callDetail({ ...call, args: { text: '"'.repeat(3000) } });

    expect(detail.length).toBeLessThanOrEqual(2000);
    expect(JSON.parse(detail).args.endsWith("…")).toBe(true);
  });
});
