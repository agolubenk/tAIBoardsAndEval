import { describe, expect, it, vi } from "vite-plus/test";
import { retryTransient } from "./retry-transient";

describe("retryTransient", () => {
  it("returns once a later try succeeds", async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("lock timeout"))
      .mockResolvedValueOnce("synced");

    await expect(retryTransient(run, [0, 0])).resolves.toBe("synced");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("gives up with the last error after every delay is spent", async () => {
    const run = vi.fn(async () => {
      throw new Error("down");
    });

    await expect(retryTransient(run, [0, 0])).rejects.toThrow("down");
    expect(run).toHaveBeenCalledTimes(3);
  });
});
