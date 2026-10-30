const DELAYS_MS = [200, 1_000];

// Following the owner runs after the owner's change has committed. If it fails
// the agent keeps the owner's previous access until its next key (a day at
// most), so a lock timeout or a dropped connection is worth two more tries.
export async function retryTransient<T>(
  run: () => Promise<T>,
  delaysMs: readonly number[] = DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const delay = delaysMs[attempt];
      if (delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
