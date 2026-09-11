import { describe, expect, it } from "vitest";
import { InMemoryWamidReplayGuard } from "../../src/webhook/replay-guard";

describe("REQ-074: InMemoryWamidReplayGuard (idempotencia por wamid, sin ventana de tiempo)", () => {
  it("la primera vez que se ve un wamid, claim() devuelve true", async () => {
    const guard = new InMemoryWamidReplayGuard();
    expect(await guard.claim("wamid.1")).toBe(true);
  });

  it("ADVERSARIAL (doble entrega): reclamar el MISMO wamid otra vez devuelve false -> no-op", async () => {
    const guard = new InMemoryWamidReplayGuard();
    expect(await guard.claim("wamid.1")).toBe(true);
    expect(await guard.claim("wamid.1")).toBe(false);
    expect(await guard.claim("wamid.1")).toBe(false);
  });

  it("wamids distintos se reclaman independientemente", async () => {
    const guard = new InMemoryWamidReplayGuard();
    expect(await guard.claim("wamid.1")).toBe(true);
    expect(await guard.claim("wamid.2")).toBe(true);
    expect(guard.size()).toBe(2);
  });
});
