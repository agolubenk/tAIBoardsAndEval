import { describe, expect, it } from "vite-plus/test";
import {
  agentDisplayName,
  agentEmail,
  DEFAULT_SESSION,
  isAgentEmail,
  normalizeHarness,
  normalizeSession,
} from "./agent-naming";

describe("agent naming", () => {
  it("keeps a readable session label and collapses its spaces", () => {
    expect(normalizeSession("  bb  ·  t-boards ")).toBeNull();
    expect(normalizeSession(" successor   bb ")).toBe("successor bb");
    expect(normalizeSession("e1@t3+review")).toBe("e1@t3+review");
  });

  it("names a session that sent no label after the harness alone", () => {
    expect(normalizeSession(undefined)).toBe(DEFAULT_SESSION);
    expect(normalizeSession("   ")).toBe(DEFAULT_SESSION);
    expect(agentDisplayName(DEFAULT_SESSION, "claude-code")).toBe(
      "Claude Code",
    );
  });

  it("rejects labels with markup or control characters", () => {
    expect(normalizeSession("<b>owner</b>")).toBeNull();
    expect(normalizeSession("a\u0000b")).toBeNull();
    expect(normalizeSession("x".repeat(81))).toBeNull();
  });

  it("accepts a lowercase harness slug only", () => {
    expect(normalizeHarness(" Claude-Code ")).toBe("claude-code");
    expect(normalizeHarness("my harness")).toBeNull();
    expect(normalizeHarness("")).toBeNull();
  });

  it("shows the session with the harness title, or the slug when unknown", () => {
    expect(agentDisplayName("bb", "claude-code")).toBe("bb · Claude Code");
    expect(agentDisplayName("bb", "aider")).toBe("bb · aider");
    expect(agentDisplayName(DEFAULT_SESSION, "constructor")).toBe(
      "constructor",
    );
  });

  it("knows the reserved agent domain in any case", () => {
    expect(isAgentEmail(agentEmail("o", "codex", "bb"))).toBe(true);
    expect(isAgentEmail(" X@Agents.T-Boards.Invalid ")).toBe(true);
    expect(isAgentEmail("x@agents.t-boards.invalid.example.com")).toBe(false);
    expect(isAgentEmail(null)).toBe(false);
  });

  it("gives one address per owner, harness and session, whatever the case", () => {
    const a = agentEmail("owner-1", "claude-code", "BB");
    expect(a).toBe(agentEmail("owner-1", "claude-code", "bb"));
    expect(a).not.toBe(agentEmail("owner-2", "claude-code", "bb"));
    expect(a).not.toBe(agentEmail("owner-1", "codex", "bb"));
    expect(a).toMatch(/^agent-[0-9a-f]{24}@agents\.t-boards\.invalid$/);
  });
});
