import { describe, expect, it } from "vitest";
import { createFakeSat69BConnector } from "../../src/list-69b/sat-69b-fake-connector.js";

describe("createFakeSat69BConnector", () => {
  it("liveVerification.verified es SIEMPRE false -- solo el conector HTTP real puede declarar true", async () => {
    const connector = createFakeSat69BConnector();
    expect(connector.liveVerification.verified).toBe(false);
  });

  it("por defecto, parsea el fixture REAL con el parser real (mismo resultado que el test de parseo)", async () => {
    const connector = createFakeSat69BConnector();
    const snapshot = await connector.fetchSnapshot();
    expect(snapshot.entries).toHaveLength(30);
    expect(snapshot.listAsOfDate).toBe("2025-12-31");
    expect(snapshot.entries.find((e) => e.rfc === "AAC0608103B5")?.situacion).toBe("Definitivo");
  });

  it("acepta entries inyectadas para probar un RFC específico sin depender del contenido del fixture", async () => {
    const connector = createFakeSat69BConnector({
      entries: [{ rfc: "TEST010101AB1", nombreContribuyente: "Empresa de prueba", situacion: "Definitivo" }],
    });
    const snapshot = await connector.fetchSnapshot();
    expect(snapshot.entries).toEqual([{ rfc: "TEST010101AB1", nombreContribuyente: "Empresa de prueba", situacion: "Definitivo" }]);
  });

  it("puede simular una falla de red (failWith) para probar el manejo de errores del llamador", async () => {
    const connector = createFakeSat69BConnector({ failWith: new Error("boom de prueba") });
    await expect(connector.fetchSnapshot()).rejects.toThrow("boom de prueba");
  });

  it("respeta el reloj inyectado (ctx.now) para fetchedAt", async () => {
    const connector = createFakeSat69BConnector({ entries: [] });
    const fixedNow = new Date("2026-01-01T00:00:00.000Z");
    const snapshot = await connector.fetchSnapshot({ now: () => fixedNow });
    expect(snapshot.fetchedAt).toEqual(fixedNow);
  });
});
