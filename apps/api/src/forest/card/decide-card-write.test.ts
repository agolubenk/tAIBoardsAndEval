import { describe, expect, it } from "vite-plus/test";
import { decideCardWrite } from "./decide-card-write";

const agent = {
  actorKind: "agent",
  mirrored: false,
  agentAuthored: false,
} as const;
const owner = {
  actorKind: "owner-ui",
  mirrored: false,
  agentAuthored: false,
} as const;

describe("decideCardWrite", () => {
  it("lets an agent report its work on any card", () => {
    expect(decideCardWrite(["branch", "files", "tokens"], agent)).toEqual({
      ok: true,
    });
  });

  it("keeps the owner's Notion fields from an agent, not its own card's", () => {
    expect(decideCardWrite(["severity"], agent)).toMatchObject({
      ok: false,
      code: "agent_forbidden",
    });
    expect(
      decideCardWrite(["kind", "severity"], { ...agent, agentAuthored: true }),
    ).toEqual({ ok: true });
  });

  it("moves half-baked only from the owner's session", () => {
    expect(
      decideCardWrite(["halfBaked"], { ...agent, agentAuthored: true }),
    ).toMatchObject({ ok: false, code: "owner_session_required" });
    expect(
      decideCardWrite(["halfBaked"], { ...owner, actorKind: "member-ui" }),
    ).toMatchObject({ ok: false, code: "owner_session_required" });
    expect(decideCardWrite(["halfBaked"], owner)).toEqual({ ok: true });
  });

  it("keeps a mirrored card's Notion fields read-only for everyone", () => {
    expect(
      decideCardWrite(["report"], { ...owner, mirrored: true }),
    ).toMatchObject({ ok: false, code: "mirror_read_only" });
    expect(decideCardWrite(["executor"], { ...agent, mirrored: true })).toEqual(
      { ok: true },
    );
  });
});
