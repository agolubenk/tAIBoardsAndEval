import { describe, expect, it } from "vite-plus/test";
import {
  assertNotAgentRole,
  assertPlainRoleNames,
  namesAgentRole,
} from "./agent-role-guard";

describe("agent role guard", () => {
  it("spots the agent role in a single, joined or listed role", () => {
    expect(namesAgentRole("agent")).toBe(true);
    expect(namesAgentRole("member,agent")).toBe(true);
    expect(namesAgentRole(["viewer", "agent"])).toBe(true);
    expect(namesAgentRole("member")).toBe(false);
    expect(namesAgentRole("agents")).toBe(false);
    expect(namesAgentRole(undefined)).toBe(false);
  });

  it("spots it padded or in another case, as better-auth would store it", () => {
    expect(namesAgentRole(" agent")).toBe(true);
    expect(namesAgentRole("member, Agent")).toBe(true);
    expect(namesAgentRole([" AGENT "])).toBe(true);
  });

  it("refuses role names padded with spaces", () => {
    expect(() => assertPlainRoleNames(" owner")).toThrow();
    expect(() => assertPlainRoleNames("admin ")).toThrow();
    expect(() => assertPlainRoleNames(["member", " agent"])).toThrow();
    expect(() => assertPlainRoleNames("member,reviewer")).not.toThrow();
    expect(() => assertPlainRoleNames(undefined)).not.toThrow();
  });

  it("refuses the agent role for people", () => {
    expect(() => assertNotAgentRole("agent")).toThrow();
    expect(() => assertNotAgentRole("member")).not.toThrow();
  });
});
