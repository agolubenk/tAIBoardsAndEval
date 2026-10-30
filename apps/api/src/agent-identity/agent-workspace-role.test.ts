import { describe, expect, it } from "vite-plus/test";
import { agentWorkspaceRole } from "./agent-workspace-role";

describe("agentWorkspaceRole", () => {
  it("gives the agent role under an owner, admin or member", () => {
    for (const role of ["owner", "admin", "member", "member,reviewer"]) {
      expect(agentWorkspaceRole(role)).toBe("agent");
    }
  });

  it("keeps a narrower owner role, so the agent never outranks its owner", () => {
    expect(agentWorkspaceRole("viewer")).toBe("viewer");
    expect(agentWorkspaceRole("reviewer")).toBe("reviewer");
  });

  it("is stable on its own output", () => {
    for (const role of ["agent", "viewer", "reviewer"]) {
      expect(agentWorkspaceRole(agentWorkspaceRole(role))).toBe(
        agentWorkspaceRole(role),
      );
    }
  });
});
