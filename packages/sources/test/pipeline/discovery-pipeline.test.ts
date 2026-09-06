import { describe, expect, it } from "vitest";
import { ZodError, z } from "zod";
import { DiscoveryPipeline } from "../../src/pipeline/discovery-pipeline.js";
import { InMemoryCheckpointStore } from "../../src/pipeline/checkpoint.js";
import { InMemoryTenderRepository } from "../../src/pipeline/repository.js";
import { InMemorySourceHealthStore } from "../../src/pipeline/source-health.js";
import { InMemoryTenderVersionStore } from "../../src/dedupe/version.js";
import { HostPausedError, HttpClient, HttpError } from "../../src/http/http-client.js";
import { parseTenderRecord, type SourceId, type TenderRecord } from "../../src/types/tender-record.js";
import type { DiscoverParams, SourceConnector } from "../../src/connectors/types.js";

function makeRecord(id: SourceId, externalId: string, overrides: Record<string, unknown> = {}): TenderRecord {
  return parseTenderRecord({
    source: id,
    externalId,
    title: `Convocatoria ${externalId}`,
    contractingEntity: "Entidad de prueba",
    procedureType: "licitacion_publica",
    classifiers: [],
    currency: "MXN",
    dates: {},
    status: "published",
    attachments: [],
    snapshot: { fetchedAt: new Date("2026-08-01T00:00:00Z"), rawHash: `${"a".repeat(63)}${externalId.length % 10}` },
    ...overrides,
  });
}

function fixedConnector(id: SourceId, records: TenderRecord[]): SourceConnector {
  return {
    id,
    termsNote: "test",
    liveVerification: { verified: true, note: "fixture de prueba" },
    async *discover() {
      for (const r of records) yield r;
    },
    async fetchDetail() {
      return null;
    },
  };
}

function throwingConnector(id: SourceId, error: unknown): SourceConnector {
  return {
    id,
    termsNote: "test",
    liveVerification: { verified: false, note: "fixture de prueba que falla" },
    async *discover(): AsyncIterable<TenderRecord> {
      // El `if` nunca se cumple: existe solo para que la función siga siendo un generador válido (regla `require-yield`).
      if ((globalThis as { __neverTrue?: boolean }).__neverTrue) yield undefined as never;
      throw error;
    },
    async fetchDetail() {
      return null;
    },
  };
}

function pausedHttp(): HttpClient {
  return new HttpClient({ userAgent: "TestBot/1.0", minIntervalMsPerHost: 0 });
}

describe("DiscoveryPipeline: idempotencia", () => {
  it("correr dos veces sobre la misma fuente sin cambios produce el mismo estado final (0 nuevos, 0 actualizados en la 2a corrida)", async () => {
    const records = [makeRecord("dof", "A-1"), makeRecord("dof", "A-2")];
    const repository = new InMemoryTenderRepository();
    const pipeline = new DiscoveryPipeline({
      connectors: [fixedConnector("dof", records)],
      repository,
      checkpoints: new InMemoryCheckpointStore(),
      http: pausedHttp(),
    });

    const first = await pipeline.run();
    expect(first.bySource.dof.nuevos).toBe(2);
    expect(first.bySource.dof.actualizados).toBe(0);
    expect(first.bySource.dof.health.state).toBe("ok");

    const second = await pipeline.run();
    expect(second.bySource.dof.nuevos).toBe(0);
    expect(second.bySource.dof.actualizados).toBe(0);
    expect(second.bySource.dof.sinCambios).toBe(2);

    expect(await repository.all()).toHaveLength(2); // nunca se duplica
  });
});

describe("DiscoveryPipeline: checkpoint / reanudación", () => {
  it("reanuda desde el cursor guardado en vez de reprocesar desde el inicio", async () => {
    const allRecords = [
      makeRecord("ocds-shcp", "P-1", { sourceCursor: "cursor-1" }),
      makeRecord("ocds-shcp", "P-2", { sourceCursor: "cursor-2" }),
      makeRecord("ocds-shcp", "P-3"),
    ];

    const seenCursorsPerCall: (string | undefined)[] = [];
    const connector: SourceConnector = {
      id: "ocds-shcp",
      termsNote: "test",
      liveVerification: { verified: true, note: "fixture" },
      async *discover(params: DiscoverParams) {
        seenCursorsPerCall.push(params.cursor);
        const startIndex = params.cursor ? allRecords.findIndex((r) => r.sourceCursor === params.cursor) + 1 : 0;
        for (const r of allRecords.slice(startIndex)) yield r;
      },
      async fetchDetail() {
        return null;
      },
    };

    const checkpoints = new InMemoryCheckpointStore();
    const repository = new InMemoryTenderRepository();
    const pipeline = new DiscoveryPipeline({ connectors: [connector], repository, checkpoints, http: pausedHttp() });

    await pipeline.run();
    expect(await repository.all()).toHaveLength(3);
    expect(seenCursorsPerCall).toEqual([undefined]);

    // Fuerza un checkpoint intermedio manualmente para simular un corte a medio camino.
    await checkpoints.set("ocds-shcp", { cursor: "cursor-1", lastRunAt: new Date().toISOString(), lastExternalId: "P-1" });
    await pipeline.run();
    expect(seenCursorsPerCall).toEqual([undefined, "cursor-1"]);
  });
});

describe("DiscoveryPipeline: concurrencia entre conectores", () => {
  it("respeta el límite de conectores corriendo en paralelo", async () => {
    let active = 0;
    let maxActive = 0;

    function slowConnector(id: SourceId): SourceConnector {
      return {
        id,
        termsNote: "test",
        liveVerification: { verified: true, note: "fixture" },
        async *discover() {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 10));
          active -= 1;
          yield makeRecord(id, "X-1");
        },
        async fetchDetail() {
          return null;
        },
      };
    }

    const ids: SourceId[] = ["dof", "ocds-shcp", "pdn-s6", "compras-mx", "state-portal"];
    const pipeline = new DiscoveryPipeline({
      connectors: ids.map(slowConnector),
      repository: new InMemoryTenderRepository(),
      checkpoints: new InMemoryCheckpointStore(),
      http: pausedHttp(),
      concurrency: 2,
    });

    const result = await pipeline.run();
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(Object.keys(result.bySource)).toHaveLength(5);
  });
});

describe("DiscoveryPipeline: salud explícita por fuente (ampliación §2 — nunca 'cero oportunidades' silencioso)", () => {
  it("clasifica 429 agotado como rate_limited", async () => {
    const pipeline = new DiscoveryPipeline({
      connectors: [throwingConnector("dof", new HttpError(429, "https://dof.gob.mx/x", "too many requests"))],
      repository: new InMemoryTenderRepository(),
      checkpoints: new InMemoryCheckpointStore(),
      http: pausedHttp(),
    });
    const result = await pipeline.run();
    expect(result.bySource.dof.health.state).toBe("rate_limited");
    expect(result.bySource.dof.errores.length).toBeGreaterThan(0);
    expect(result.bySource.dof.nuevos).toBe(0);
  });

  it("clasifica un HostPausedError (403 repetidos) como permission_missing", async () => {
    const pipeline = new DiscoveryPipeline({
      connectors: [throwingConnector("compras-mx", new HostPausedError("upcp-cnetservicios.buengobierno.gob.mx"))],
      repository: new InMemoryTenderRepository(),
      checkpoints: new InMemoryCheckpointStore(),
      http: pausedHttp(),
    });
    const result = await pipeline.run();
    expect(result.bySource["compras-mx"].health.state).toBe("permission_missing");
  });

  it("clasifica un mensaje con 'captcha' como captcha_detected", async () => {
    const pipeline = new DiscoveryPipeline({
      connectors: [throwingConnector("compras-mx", new Error("Se requiere resolver reCAPTCHA para continuar"))],
      repository: new InMemoryTenderRepository(),
      checkpoints: new InMemoryCheckpointStore(),
      http: pausedHttp(),
    });
    const result = await pipeline.run();
    expect(result.bySource["compras-mx"].health.state).toBe("captcha_detected");
  });

  it("clasifica un ZodError (estructura irreconocible) como interface_changed", async () => {
    let zodError: ZodError;
    try {
      z.object({ campo: z.string() }).parse({ campo: 123 });
      throw new Error("no debería llegar aquí");
    } catch (e) {
      zodError = e as ZodError;
    }
    const pipeline = new DiscoveryPipeline({
      connectors: [throwingConnector("ocds-shcp", zodError)],
      repository: new InMemoryTenderRepository(),
      checkpoints: new InMemoryCheckpointStore(),
      http: pausedHttp(),
    });
    const result = await pipeline.run();
    expect(result.bySource["ocds-shcp"].health.state).toBe("interface_changed");
  });

  it("clasifica un error de red genérico como down y NUNCA reporta éxito silencioso", async () => {
    const pipeline = new DiscoveryPipeline({
      connectors: [throwingConnector("pdn-s6", new TypeError("fetch failed"))],
      repository: new InMemoryTenderRepository(),
      checkpoints: new InMemoryCheckpointStore(),
      http: pausedHttp(),
    });
    const result = await pipeline.run();
    expect(result.bySource["pdn-s6"].health.state).toBe("down");
    expect(result.bySource["pdn-s6"].nuevos).toBe(0);
    expect(result.bySource["pdn-s6"].errores).not.toEqual([]);
  });

  it("caso 'fuente inaccesible con obsolescencia visible': preserva lastSuccessAt de una corrida previa exitosa y expone staleForMs creciente", async () => {
    const healthStore = new InMemorySourceHealthStore();
    const checkpoints = new InMemoryCheckpointStore();
    const repository = new InMemoryTenderRepository();

    let now = new Date("2026-08-01T00:00:00Z");
    const okPipeline = new DiscoveryPipeline({
      connectors: [fixedConnector("dof", [makeRecord("dof", "A-1")])],
      repository,
      checkpoints,
      healthStore,
      http: pausedHttp(),
      now: () => now,
    });
    const okResult = await okPipeline.run();
    expect(okResult.bySource.dof.health.state).toBe("ok");
    expect(okResult.bySource.dof.health.lastSuccessAt?.toISOString()).toBe(now.toISOString());

    now = new Date("2026-08-03T00:00:00Z"); // 2 días después, la fuente ahora falla
    const failingPipeline = new DiscoveryPipeline({
      connectors: [throwingConnector("dof", new TypeError("fetch failed"))],
      repository,
      checkpoints,
      healthStore,
      http: pausedHttp(),
      now: () => now,
    });
    const failResult = await failingPipeline.run();

    expect(failResult.bySource.dof.health.state).toBe("down");
    expect(failResult.bySource.dof.health.lastSuccessAt?.toISOString()).toBe("2026-08-01T00:00:00.000Z"); // no se pierde
    expect(failResult.bySource.dof.health.staleForMs).toBe(2 * 24 * 60 * 60 * 1000);
    // Los "0 nuevos" de esta corrida NO deben confundirse con "no hay nada nuevo": el estado explícito lo distingue.
    expect(failResult.bySource.dof.nuevos).toBe(0);
    expect(failResult.bySource.dof.health.state).not.toBe("ok");
  });
});

describe("DiscoveryPipeline: eventos de trazabilidad y ChangeDetected", () => {
  it("emite record-processed y ChangeDetected cuando una convocatoria cambia entre corridas", async () => {
    const events: string[] = [];
    const repository = new InMemoryTenderRepository();
    const checkpoints = new InMemoryCheckpointStore();
    const versions = new InMemoryTenderVersionStore();

    const v1 = makeRecord("ocds-shcp", "C-1", { dates: { submissionDeadline: "2026-09-10T00:00:00Z" }, snapshot: { fetchedAt: new Date(), rawHash: "1".repeat(64) } });
    const pipeline1 = new DiscoveryPipeline({
      connectors: [fixedConnector("ocds-shcp", [v1])],
      repository,
      checkpoints,
      versions,
      http: pausedHttp(),
      onEvent: (e) => events.push(e.type),
    });
    await pipeline1.run();
    expect(events).toContain("connector-start");
    expect(events).toContain("record-processed");
    expect(events).not.toContain("ChangeDetected");

    const v2 = makeRecord("ocds-shcp", "C-1", { dates: { submissionDeadline: "2026-09-05T00:00:00Z" }, snapshot: { fetchedAt: new Date(), rawHash: "2".repeat(64) } });
    const changeEvents: unknown[] = [];
    const pipeline2 = new DiscoveryPipeline({
      connectors: [fixedConnector("ocds-shcp", [v2])],
      repository,
      checkpoints,
      versions,
      http: pausedHttp(),
      onEvent: (e) => {
        if (e.type === "ChangeDetected") changeEvents.push(e);
      },
    });
    await pipeline2.run();
    expect(changeEvents).toHaveLength(1);
    expect((changeEvents[0] as { changes: string[] }).changes).toContain("plazos");
  });
});
