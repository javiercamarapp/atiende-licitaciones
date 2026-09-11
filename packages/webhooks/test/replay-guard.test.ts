import { describe, expect, it } from "vitest";
import { InMemoryWebhookReplayGuard } from "../src/replay-guard";

describe("InMemoryWebhookReplayGuard", () => {
  it("acepta la PRIMERA vez que ve un eventId", async () => {
    const guard = new InMemoryWebhookReplayGuard();
    expect(await guard.claim("evt_1", 300, 1_000_000)).toBe(true);
    expect(guard.size()).toBe(1);
  });

  it("rechaza un eventId repetido dentro de la ventana", async () => {
    const guard = new InMemoryWebhookReplayGuard();
    await guard.claim("evt_1", 300, 1_000_000);
    expect(await guard.claim("evt_1", 300, 1_100_000)).toBe(false);
  });

  it("distingue eventId distintos", async () => {
    const guard = new InMemoryWebhookReplayGuard();
    expect(await guard.claim("evt_1", 300, 1_000_000)).toBe(true);
    expect(await guard.claim("evt_2", 300, 1_000_000)).toBe(true);
    expect(guard.size()).toBe(2);
  });

  it("purga entradas más viejas que 2x la tolerancia", async () => {
    const guard = new InMemoryWebhookReplayGuard();
    await guard.claim("evt_viejo", 300, 0);
    // 700_000ms > 2 * 300_000ms de tolerancia -> se purga en el siguiente claim.
    await guard.claim("evt_nuevo", 300, 700_001);
    expect(guard.size()).toBe(1);
    // Habiendo sido purgado, "evt_viejo" cuenta como nuevo otra vez.
    expect(await guard.claim("evt_viejo", 300, 700_002)).toBe(true);
  });
});
