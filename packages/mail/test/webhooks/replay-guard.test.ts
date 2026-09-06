import { describe, expect, it } from "vitest";
import { InMemoryWebhookReplayGuard } from "../../src/webhooks/replay-guard";

describe("InMemoryWebhookReplayGuard", () => {
  it("claim() devuelve true la primera vez que se ve un svixId", async () => {
    const guard = new InMemoryWebhookReplayGuard();
    expect(await guard.claim("msg_1", 300, 1_000)).toBe(true);
  });

  it("claim() devuelve false para un svixId ya visto dentro de la ventana (replay)", async () => {
    const guard = new InMemoryWebhookReplayGuard();
    await guard.claim("msg_1", 300, 1_000);
    expect(await guard.claim("msg_1", 300, 1_050)).toBe(false);
  });

  it("distintos svixId no interfieren entre sí", async () => {
    const guard = new InMemoryWebhookReplayGuard();
    expect(await guard.claim("msg_1", 300, 1_000)).toBe(true);
    expect(await guard.claim("msg_2", 300, 1_000)).toBe(true);
  });

  it("purga entradas mucho más viejas que la ventana de tolerancia (no crece sin límite)", async () => {
    const guard = new InMemoryWebhookReplayGuard();
    await guard.claim("msg_viejo", 300, 0);
    // 700s después (> 2x toleranceSeconds de 300s): se purga, y un "replay"
    // tan tardío (más allá de lo que verifyResendWebhookSignature ya
    // rechazaría por timestamp_fuera_de_rango) puede reclamarse de nuevo.
    expect(await guard.claim("msg_viejo", 300, 700_000)).toBe(true);
    expect(guard.size()).toBe(1);
  });

  it("Promise.all de 10 reclamos concurrentes del mismo svixId: exactamente 1 gana", async () => {
    const guard = new InMemoryWebhookReplayGuard();
    const results = await Promise.all(Array.from({ length: 10 }, () => guard.claim("carrera", 300, 1_000)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
