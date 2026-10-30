import { describe, expect, it } from "vite-plus/test";
import { assertNotAgentRole, namesAgentRole } from "./agent-role-guard";

describe("agent role guard", () => {
  it("spots the agent role in a single, joined or listed role", () => {
    expect(namesAgentRole("agent")).toBe(true);
    expect(namesAgentRole("member,agent")).toBe(true);
    expect(namesAgentRole(["viewer", "agent"])).toBe(true);
    expect(namesAgentRole("member")).toBe(false);
    expect(namesAgentRole("agents")).toBe(false);
    expect(namesAgentRole(undefined)).toBe(false);
  });

  it("refuses the agent role for people", () => {
    expect(() => assertNotAgentRole("agent")).toThrow();
    expect(() => assertNotAgentRole("member")).not.toThrow();
  });
});
