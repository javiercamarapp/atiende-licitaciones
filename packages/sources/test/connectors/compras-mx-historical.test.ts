import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createComprasMxHistoricalCsvConnector } from "../../src/connectors/compras-mx/compras-mx-historical-csv-connector.js";
import { DiscoveryPipeline } from "../../src/pipeline/discovery-pipeline.js";
import { InMemoryCheckpointStore } from "../../src/pipeline/checkpoint.js";
import { InMemoryTenderRepository } from "../../src/pipeline/repository.js";
import { HttpClient } from "../../src/http/http-client.js";
import type { ConnectorContext } from "../../src/connectors/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "..", "fixtures", "compras-mx");
const csvFixturePath = path.join(fixturesDir, "compranet-historico-real-sample.csv");

describe("SR-06: ComprasMxHistoricalCsvConnector (conecta el CSV histórico SABG al pipeline)", () => {
  it("declara su propio SourceId (distinto de 'compras-mx') y liveVerification.verified = true", () => {
    const connector = createComprasMxHistoricalCsvConnector();
    expect(connector.id).toBe("compras-mx-historico");
    expect(connector.id).not.toBe("compras-mx");
    expect(connector.liveVerification.verified).toBe(true);
    expect(connector.liveVerification.note).toMatch(/histórico/i);
  });

  it("discover() descarga el CSV vía HttpClient y produce TenderRecord reales a partir del fixture recortado", async () => {
    const csvText = readFileSync(csvFixturePath, "utf8");
    const fetchImpl = async () =>
      new Response(csvText, { status: 200, headers: { "Content-Type": "text/csv" } });
    const http = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0 });
    const connector = createComprasMxHistoricalCsvConnector({ csvUrl: "https://repodatos.atdt.gob.mx/fixture.csv" });
    const ctx: ConnectorContext = { http, now: () => new Date("2026-09-05T00:00:00Z") };

    const records = [];
    for await (const record of connector.discover({}, ctx)) records.push(record);

    expect(records.length).toBeGreaterThan(5);
    expect(records[0].source).toBe("compras-mx");
    expect(records[0].externalId).toBe("2161394");
    expect(records[0].title).toBe("Servicios Profesionales Para la Elaboración de Avalúos");
    expect(records[0].status).toBe("awarded");
    expect(records[0].snapshot.sourceUrl).toBe("https://repodatos.atdt.gob.mx/fixture.csv");
  });

  it("respeta params.limit", async () => {
    const csvText = readFileSync(csvFixturePath, "utf8");
    const fetchImpl = async () => new Response(csvText, { status: 200 });
    const http = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0 });
    const connector = createComprasMxHistoricalCsvConnector();
    const ctx: ConnectorContext = { http, now: () => new Date() };

    const records = [];
    for await (const record of connector.discover({ limit: 2 }, ctx)) records.push(record);
    expect(records).toHaveLength(2);
  });

  it("propaga un error explícito si la fuente responde con un status distinto de 200", async () => {
    const fetchImpl = async () => new Response("not found", { status: 404 });
    const http = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0, maxRetries: 0 });
    const connector = createComprasMxHistoricalCsvConnector();
    const ctx: ConnectorContext = { http, now: () => new Date() };

    await expect(async () => {
      for await (const _r of connector.discover({}, ctx)) {
        /* no-op */
      }
    }).rejects.toThrow(/404/);
  });

  it("conectado a DiscoveryPipeline: una corrida real ingiere los registros del fixture al repositorio (SR-06: 'ningún dato real fluye por DiscoveryPipeline')", async () => {
    const csvText = readFileSync(csvFixturePath, "utf8");
    const fetchImpl = async () => new Response(csvText, { status: 200 });
    const http = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0 });
    const repository = new InMemoryTenderRepository();

    const pipeline = new DiscoveryPipeline({
      connectors: [createComprasMxHistoricalCsvConnector()],
      repository,
      checkpoints: new InMemoryCheckpointStore(),
      http,
    });

    const result = await pipeline.run();
    expect(result.bySource["compras-mx-historico"].health.state).toBe("ok");
    expect(result.bySource["compras-mx-historico"].nuevos).toBeGreaterThan(5);
    expect((await repository.all()).length).toBeGreaterThan(5);
  });

  it("fetchDetail no está implementado (dataset masivo sin endpoint de detalle) y lo documenta explícitamente", async () => {
    const connector = createComprasMxHistoricalCsvConnector();
    const http = new HttpClient({ userAgent: "TestBot/1.0", minIntervalMsPerHost: 0 });
    await expect(connector.fetchDetail("2161394", { http, now: () => new Date() })).rejects.toThrow(/no está implementado/i);
  });
});
