import { describe, expect, it } from "vite-plus/test";
import { approvalParamsHash } from "./approval-params";

describe("approvalParamsHash", () => {
  it("ignores tree order and duplicates", () => {
    expect(approvalParamsHash("fell_sector", "s1", ["b", "a", "a"])).toBe(
      approvalParamsHash("fell_sector", "s1", ["a", "b"]),
    );
  });

  it("changes when the tree list, target or action changes", () => {
    const base = approvalParamsHash("fell_sector", "s1", ["a", "b"]);
    expect(approvalParamsHash("fell_sector", "s1", ["a", "b", "c"])).not.toBe(
      base,
    );
    expect(approvalParamsHash("fell_sector", "s2", ["a", "b"])).not.toBe(base);
    expect(approvalParamsHash("fell_tree", "s1", ["a", "b"])).not.toBe(base);
  });
});

describe("task approvals", () => {
  it("bind the value the owner saw", () => {
    const done = approvalParamsHash("close_task", "t1", ["done"]);
    expect(approvalParamsHash("close_task", "t1", ["closed"])).not.toBe(done);
    expect(approvalParamsHash("set_priority", "t1", ["done"])).not.toBe(done);
  });
});
