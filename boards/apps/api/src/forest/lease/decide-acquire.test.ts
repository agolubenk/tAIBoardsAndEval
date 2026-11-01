import { describe, expect, it } from "vite-plus/test";
import { decideAcquire, type StoredLease } from "./decide-acquire";

const now = new Date("2026-10-27T10:00:00Z");
const live = new Date("2026-10-27T10:05:00Z");
const lapsed = new Date("2026-10-27T09:59:59Z");

function lease(overrides: Partial<StoredLease> = {}): StoredLease {
  return {
    holderId: "key:a:backend",
    holderName: "backend",
    groupKey: null,
    fencingToken: 4,
    expiresAt: live,
    ...overrides,
  };
}

describe("decideAcquire", () => {
  it("issues token 1 for a task never leased", () => {
    expect(decideAcquire(null, { holderId: "x", groupKey: null }, now)).toEqual(
      { kind: "insert", fencingToken: 1 },
    );
  });

  it("lets the holder renew without changing the token", () => {
    expect(
      decideAcquire(
        lease(),
        { holderId: "key:a:backend", groupKey: null },
        now,
      ),
    ).toEqual({ kind: "extend", fencingToken: 4 });
  });

  it("lets a linked session of the same group share the lease", () => {
    expect(
      decideAcquire(
        lease({ groupKey: "T-17" }),
        { holderId: "key:b:frontend", groupKey: "T-17" },
        now,
      ),
    ).toEqual({ kind: "extend", fencingToken: 4 });
  });

  it("names the holder to an unrelated session", () => {
    expect(
      decideAcquire(
        lease({ groupKey: "T-17" }),
        { holderId: "key:c:other", groupKey: "T-99" },
        now,
      ),
    ).toEqual({ kind: "conflict", holderName: "backend", expiresAt: live });
  });

  it("does not treat two ungrouped sessions as linked", () => {
    expect(
      decideAcquire(lease(), { holderId: "key:c:other", groupKey: null }, now)
        .kind,
    ).toBe("conflict");
  });

  it("raises the token when a lapsed lease is taken over", () => {
    expect(
      decideAcquire(
        lease({ expiresAt: lapsed }),
        { holderId: "key:c:other", groupKey: null },
        now,
      ),
    ).toEqual({ kind: "takeover", fencingToken: 5 });
  });
});
