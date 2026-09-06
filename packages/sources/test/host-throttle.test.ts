import { describe, expect, it } from "vitest";
import { HostThrottle, type Clock } from "../src/http/host-throttle.js";

/** Reloj manual mínimo: `sleep` no resuelve hasta que `advance` cubra el tiempo pedido. */
function makeManualClock(): Clock & { advance: (ms: number) => Promise<void> } {
  let now = 0;
  let pending: Array<{ at: number; resolve: () => void }> = [];
  return {
    now: () => now,
    sleep: (ms: number) => new Promise<void>((resolve) => pending.push({ at: now + ms, resolve })),
    advance: async (ms: number) => {
      now += ms;
      const ready = pending.filter((p) => p.at <= now);
      pending = pending.filter((p) => p.at > now);
      for (const p of ready) p.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("HostThrottle", () => {
  it("respeta el espaciado mínimo entre inicios de petición (REQ-079: ≤1 req/s)", async () => {
    const clock = makeManualClock();
    const throttle = new HostThrottle(5, 1000, clock);
    const starts: number[] = [];

    const run = async () => {
      const release = await throttle.acquire();
      starts.push(clock.now());
      release();
    };

    const p1 = run();
    await Promise.resolve();
    const p2 = run();
    await p1;
    await clock.advance(1000);
    await p2;

    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
  });

  it("limita las ejecuciones concurrentes a `concurrency`", async () => {
    const clock: Clock = { now: () => 0, sleep: () => Promise.resolve() };
    const throttle = new HostThrottle(2, 0, clock);
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];

    async function acquireOne() {
      const release = await throttle.acquire();
      active += 1;
      maxActive = Math.max(maxActive, active);
      releases.push(() => {
        active -= 1;
        release();
      });
    }

    await acquireOne();
    await acquireOne();
    const thirdPromise = acquireOne(); // debe quedar en espera hasta liberar un cupo
    await Promise.resolve();
    expect(active).toBe(2);

    releases[0]();
    await thirdPromise;
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
