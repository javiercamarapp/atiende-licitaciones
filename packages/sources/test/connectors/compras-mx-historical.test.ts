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

  it("SR-15: decodifica el CSV como Latin-1 cuando los bytes NO son UTF-8 válido (heurística por contenido), evitando mojibake silencioso", async () => {
    const titulo = "Instalación de cañería y señalización";
    const csvText =
      "codigo_contrato,codigo_expediente,proveedor,titulo_contrato,importe,moneda,fecha_inicio,fecha_fin\n" +
      `C1,E1,Proveedor de prueba,${titulo},1000,MXN,2020-01-01 00:00:00.000000 +00:00,2020-02-01 00:00:00.000000 +00:00\n`;
    const latin1Bytes = Buffer.from(csvText, "latin1");
    // Servidor real que NO declara charset (típico de exports gubernamentales legados): sin la heurística, un
    // `Content-Type` así hace que `Response.text()` decodifique SIEMPRE como UTF-8, produciendo mojibake.
    const fetchImpl = async () => new Response(latin1Bytes, { status: 200, headers: { "Content-Type": "text/csv" } });
    const http = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0 });
    const connector = createComprasMxHistoricalCsvConnector();
    const ctx: ConnectorContext = { http, now: () => new Date() };

    const records = [];
    for await (const record of connector.discover({}, ctx)) records.push(record);

    expect(records).toHaveLength(1);
    expect(records[0].title).toBe(titulo);
    expect(records[0].title).not.toContain("�");
  });

  it("SR-15: quita el BOM UTF-8 inicial para que el nombre de la primera columna del encabezado no quede corrupto", async () => {
    const csvText =
      "codigo_contrato,codigo_expediente,proveedor,titulo_contrato,importe,moneda,fecha_inicio,fecha_fin\n" +
      "C1,E1,Proveedor de prueba,Titulo de prueba,1000,MXN,2020-01-01 00:00:00.000000 +00:00,2020-02-01 00:00:00.000000 +00:00\n";
    const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const bytesWithBom = Buffer.concat([utf8Bom, Buffer.from(csvText, "utf8")]);
    const fetchImpl = async () => new Response(bytesWithBom, { status: 200 });
    const http = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0 });
    const connector = createComprasMxHistoricalCsvConnector();
    const ctx: ConnectorContext = { http, now: () => new Date() };

    const records = [];
    for await (const record of connector.discover({}, ctx)) records.push(record);

    // Si el BOM se filtrara al nombre de la primera columna del encabezado (quedaría pegado como un carácter
    // invisible antes de "codigo_contrato"), el esquema (que exige `codigo_contrato` como llave exacta)
    // rechazaría la fila -- se registraría como error, no como registro. `records` tendría longitud 0 en vez de 1.
    expect(records).toHaveLength(1);
    expect(records[0].title).toBe("Titulo de prueba");
  });

  it("SR-14: un 200 con cuerpo HTML de captcha/bot-challenge se clasifica explícitamente en vez de reportarse como CSV vacío/legítimo", async () => {
    const html = "<!doctype html><html><body><div class=\"g-recaptcha\"></div>Verifica que no eres un robot</body></html>";
    const fetchImpl = async () => new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
    const http = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0 });
    const connector = createComprasMxHistoricalCsvConnector();
    const ctx: ConnectorContext = { http, now: () => new Date() };

    await expect(async () => {
      for await (const _r of connector.discover({}, ctx)) {
        /* no-op */
      }
    }).rejects.toThrow(/captcha/i);
  });
});
