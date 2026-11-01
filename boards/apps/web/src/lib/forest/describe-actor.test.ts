import { describe, expect, it } from "vite-plus/test";
import { describeActor } from "./describe-actor";

describe("describeActor", () => {
  it("reads a person, a session and agents with and without a label", () => {
    expect(describeActor(null)).toEqual({ kind: "person" });
    expect(describeActor("session:s1")).toEqual({ kind: "owner-session" });
    expect(describeActor("key:k1:dev-1")).toEqual({
      kind: "agent",
      label: "dev-1",
    });
    expect(describeActor("bearer:u1")).toEqual({ kind: "agent", label: null });
    expect(describeActor("key:k1:team:a")).toEqual({
      kind: "agent",
      label: "team:a",
    });
  });
});
