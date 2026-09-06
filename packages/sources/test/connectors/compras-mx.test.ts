import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createComprasMxConnector } from "../../src/connectors/compras-mx/compras-mx-connector.js";
import {
  mapComprasMxApiRecordToTenderRecord,
  mapComprasMxApiRecords,
  parseComprasMxHistoricoCsv,
} from "../../src/connectors/compras-mx/comprasmx-mapper.js";
import { HttpClient } from "../../src/http/http-client.js";
import { CaptchaDetectedError } from "../../src/http/response-classifier.js";
import type { ConnectorContext, SourceConnector } from "../../src/connectors/types.js";
import { DiscoveryPipeline } from "../../src/pipeline/discovery-pipeline.js";
import { InMemoryCheckpointStore } from "../../src/pipeline/checkpoint.js";
import { InMemoryTenderRepository } from "../../src/pipeline/repository.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "..", "fixtures", "compras-mx");

describe("ComprasMX: mapeo del API inferido (esquema no confirmado en vivo, ver README)", () => {
  it("mapea expedientes del fixture con los nombres de campo reales encontrados en la SPA pública", () => {
    const fixture = JSON.parse(readFileSync(path.join(fixturesDir, "expedientes-page1.json"), "utf8"));
    const registros = fixture.data[0].registros;
    const { records, dropped } = mapComprasMxApiRecords(registros, { fetchedAt: new Date("2026-08-25T00:00:00Z") });

    expect(dropped).toEqual([]);
    expect(records).toHaveLength(2);
    expect(records[0].externalId).toBe("E-2026-001234");
    expect(records[0].contractingEntity).toBe("Secretaría de Bienestar");
    expect(records[0].procedureType).toBe("licitacion_publica");
    expect(records[0].state).toBe("Ciudad de México");
    expect(records[0].status).toBe("published");
    expect(records[1].procedureType).toBe("invitacion_restringida");
  });
});

describe("ComprasMX: mapeo de estatus/tipo de procedimiento (cobertura de ramas, SR-08)", () => {
  function record(overrides: Record<string, unknown> = {}) {
    return mapComprasMxApiRecordToTenderRecord(
      {
        codigo_expediente: "COV-1",
        titulo_expediente: "Cobertura de ramas",
        ...overrides,
      },
      { fetchedAt: new Date("2026-01-01T00:00:00Z") },
    );
  }

  it("mapea cada variante conocida de estatus a su TenderStatus correspondiente", () => {
    expect(record({ estatus: "En periodo de aclaraciones" })?.status).toBe("clarification");
    expect(record({ estatus: "Convocatoria cerrada" })?.status).toBe("closed_for_submission");
    expect(record({ estatus: "Fallo emitido" })?.status).toBe("awarded");
    expect(record({ estatus: "Procedimiento cancelado" })?.status).toBe("cancelled");
    expect(record({ estatus: "Declarada desierta" })?.status).toBe("void");
    expect(record({ estatus: "Algo no catalogado" })?.status).toBe("unknown");
    expect(record({})?.status).toBe("unknown");
  });

  it("mapProcedureType cae a 'otro' cuando el tipo de contratación no coincide con ningún alias conocido", () => {
    expect(record({ tipo_contratacion: "Acuerdo marco" })?.procedureType).toBe("otro");
    expect(record({})?.procedureType).toBe("otro");
  });

  it("devuelve null si falta el título o el identificador del expediente", () => {
    expect(mapComprasMxApiRecordToTenderRecord({ titulo_expediente: "Sin id" }, { fetchedAt: new Date() })).toBeNull();
    expect(mapComprasMxApiRecordToTenderRecord({ codigo_expediente: "SIN-TITULO" }, { fetchedAt: new Date() })).toBeNull();
  });
});

describe("SR-21 (ALTA, residual de SR-13): ningún registro se descarta en silencio", () => {
  it("mapComprasMxApiRecords reporta en dropped[] (índice, motivo, campos) un registro con titulo_expediente: null, sin perder los registros válidos", () => {
    const { records, dropped } = mapComprasMxApiRecords(
      [
        { codigo_expediente: "E-1", titulo_expediente: "Válido" },
        { codigo_expediente: "E-2", titulo_expediente: null },
        { titulo_expediente: "Sin identificador" },
      ],
      { fetchedAt: new Date("2026-09-05T00:00:00Z") },
    );

    expect(records).toHaveLength(1);
    expect(records[0].externalId).toBe("E-1");
    expect(dropped).toHaveLength(2);
    expect(dropped[0]).toMatchObject({ index: 1, externalId: "E-2", reason: expect.stringMatching(/título/i) });
    expect(dropped[1]).toMatchObject({ index: 2, reason: expect.stringMatching(/identificador/i) });
  });

  it("un registro que no cumple el esquema (tipo incorrecto) se reporta en dropped[] con el motivo del ZodError, no se descarta en silencio", () => {
    const { records, dropped } = mapComprasMxApiRecords([{ codigo_expediente: "E-1", titulo_expediente: "OK" }, { codigo_expediente: "E-2", monto_estimado: "no-es-numero" }], {
      fetchedAt: new Date("2026-09-05T00:00:00Z"),
    });

    expect(records).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].index).toBe(1);
    expect(dropped[0].reason).toMatch(/esquema/i);
  });

  it("DiscoveryPipeline: un registro con título null llega a errors[]/dropped y NO desaparece sin rastro (fin de la reverificación adversarial 2)", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              registros: [
                { codigo_expediente: "E-100", titulo_expediente: null },
                { codigo_expediente: "E-101", titulo_expediente: "Convocatoria válida" },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    const http = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0 });
    const repository = new InMemoryTenderRepository();
    const pipeline = new DiscoveryPipeline({
      connectors: [createComprasMxConnector()],
      repository,
      checkpoints: new InMemoryCheckpointStore(),
      http,
    });

    const result = await pipeline.run();
    const stats = result.bySource["compras-mx"];

    // 1 de 2 registros descartado = 50% > 20% (umbral default) -> la corrida se reclasifica como
    // interface_changed, NUNCA "ok" con "1 nueva" sin rastro del descarte (a diferencia del comportamiento
    // confirmado por la reverificación adversarial 2: health.state="ok", nuevos=1, sin ningún rastro).
    expect(stats.dropped).toHaveLength(1);
    expect(stats.dropped[0]).toMatchObject({ externalId: "E-100", reason: expect.stringMatching(/título/i) });
    expect(stats.errores.some((e) => e.externalId === "E-100" && /descartado/i.test(e.message))).toBe(true);
    expect(stats.health.state).toBe("interface_changed");
    expect(result.totalDropped).toBe(1);
  });

  it("DiscoveryPipeline: una tasa de descarte baja (< 20%) NO reclasifica la corrida -- sigue 'ok' pero con el descarte visible en dropped[]/errors[]", async () => {
    const registros = Array.from({ length: 10 }, (_, i) => ({ codigo_expediente: `E-${i}`, titulo_expediente: `Convocatoria ${i}` }));
    registros[0] = { codigo_expediente: "E-BAD", titulo_expediente: null } as unknown as (typeof registros)[number];
    const fetchImpl = async () => new Response(JSON.stringify({ data: [{ registros }] }), { status: 200 });
    const http = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0 });
    const repository = new InMemoryTenderRepository();
    const pipeline = new DiscoveryPipeline({
      connectors: [createComprasMxConnector()],
      repository,
      checkpoints: new InMemoryCheckpointStore(),
      http,
    });

    const result = await pipeline.run();
    const stats = result.bySource["compras-mx"];

    expect(stats.dropped).toHaveLength(1); // 1/10 = 10% < 20%
    expect(stats.health.state).toBe("ok");
    expect(stats.nuevos).toBe(9);
  });
});

describe("ComprasMX: CSV histórico REAL (verificado en vivo 2026-09-05, ver README)", () => {
  it("parsea el fixture descargado en vivo de datos.gob.mx (SABG) sin errores y con montos correctos", () => {
    const csv = readFileSync(path.join(fixturesDir, "compranet-historico-real-sample.csv"), "utf8");
    const { records, errors } = parseComprasMxHistoricoCsv(csv, {
      fetchedAt: new Date("2026-09-05T00:00:00Z"),
      sourceUrl: "https://repodatos.atdt.gob.mx/api_update/sabg/contratos_expedientes_sistema_historico_compranet/compranet_historico.csv",
      publishingEntity: "Secretaría Anticorrupción y Buen Gobierno (dataset histórico Compranet)",
    });

    expect(errors).toEqual([]);
    expect(records.length).toBeGreaterThan(5);
    const first = records[0];
    expect(first.externalId).toBe("2161394");
    expect(first.title).toBe("Servicios Profesionales Para la Elaboración de Avalúos");
    expect(first.currency).toBe("MXN");
    expect(first.budgetAmount).toBe(89012);
    expect(first.status).toBe("awarded");
    // SR-12: fecha_inicio/fecha_fin del fixture real ya traen offset explícito (+00:00) -- fromMexicoCityNaive
    // debe respetarlo tal cual (no reinterpretarlo como hora de México), igual que hacía z.coerce.date() antes.
    expect(first.dates.published?.toISOString()).toBe("2020-07-22T05:00:00.000Z");
    expect(first.dates.award?.toISOString()).toBe("2020-08-27T04:59:00.000Z");
  });

  it("SR-16: una fila inválida en medio de filas válidas se registra en errors[] con su número de fila, sin perder las filas válidas", () => {
    const csv =
      "codigo_contrato,codigo_expediente,proveedor,titulo_contrato,importe,moneda,fecha_inicio,fecha_fin\n" +
      "C1,E1,Prov1,Titulo1,1000,MXN,2020-01-01 00:00:00.000000 +00:00,2020-02-01 00:00:00.000000 +00:00\n" +
      "C2,E2,Prov2,Titulo2,no-es-numero,MXN,2020-01-01 00:00:00.000000 +00:00,2020-02-01 00:00:00.000000 +00:00\n" +
      "C3,E3,Prov3,Titulo3,3000,MXN,2020-01-01 00:00:00.000000 +00:00,2020-02-01 00:00:00.000000 +00:00\n";

    const { records, errors } = parseComprasMxHistoricoCsv(csv, {
      fetchedAt: new Date("2026-09-05T00:00:00Z"),
      publishingEntity: "Entidad de prueba",
    });

    expect(records).toHaveLength(2);
    expect(records.map((r) => r.externalId)).toEqual(["E1", "E3"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].row).toBe(2);
  });

  it("SR-17: una fila con MÁS columnas que el encabezado (coma sin escapar en un campo no entrecomillado) se registra en errors[] en vez de desalinear el resto de la fila", () => {
    const csv =
      "codigo_contrato,codigo_expediente,proveedor,titulo_contrato,importe,moneda,fecha_inicio,fecha_fin\n" +
      "C1,E1,Fulano, S.A. de C.V.,Titulo1,1000,MXN,2020-01-01 00:00:00.000000 +00:00,2020-02-01 00:00:00.000000 +00:00\n";

    const { records, errors } = parseComprasMxHistoricoCsv(csv, {
      fetchedAt: new Date("2026-09-05T00:00:00Z"),
      publishingEntity: "Entidad de prueba",
    });

    expect(records).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].row).toBe(1);
    expect(errors[0].message).toMatch(/columnas/i);
  });
});

describe("createComprasMxConnector", () => {
  it("declara liveVerification.verified = false con evidencia real del 401 capturado (no se inventa acceso)", () => {
    const connector = createComprasMxConnector();
    expect(connector.liveVerification.verified).toBe(false);
    expect(connector.liveVerification.note).toMatch(/401/);
    expect(connector.liveVerification.note).toMatch(/Unauthorized/);
  });

  it("discover() consume el fixture del API a través de un HttpClient con fetch simulado", async () => {
    const fixture = JSON.parse(readFileSync(path.join(fixturesDir, "expedientes-page1.json"), "utf8"));
    const fetchImpl = async () => new Response(JSON.stringify(fixture), { status: 200 });
    const http = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0 });
    const connector = createComprasMxConnector({ rowsPerPage: 2 });
    const ctx: ConnectorContext = { http, now: () => new Date("2026-08-25T00:00:00Z") };

    const records = [];
    for await (const record of connector.discover({}, ctx)) records.push(record);
    expect(records).toHaveLength(2);
  });

  it("propaga un error explícito y explicado cuando el endpoint responde 401 (sin intentar resolver reCAPTCHA)", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ success: false, details: "Unauthorized" }), { status: 401 });
    const http = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0, maxRetries: 0 });
    const connector = createComprasMxConnector();
    const ctx: ConnectorContext = { http, now: () => new Date() };

    await expect(async () => {
      for await (const _r of connector.discover({}, ctx)) {
        /* no-op */
      }
    }).rejects.toThrow(/401|reCAPTCHA/i);
  });
});

describe("SR-19 (ALTA, residual de SR-14): un 200 con JSON válido pero sin la llave 'data' NUNCA se interpreta como 0 registros legítimos", () => {
  async function discoverWith(body: string) {
    const fetchImpl = async () => new Response(body, { status: 200 });
    const http = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0, maxRetries: 0 });
    const connector = createComprasMxConnector();
    const ctx: ConnectorContext = { http, now: () => new Date("2026-09-05T00:00:00Z") };
    const records = [];
    for await (const record of connector.discover({}, ctx)) records.push(record);
    return records;
  }

  it("'{}' (sin la llave 'data') lanza -- ya NO pasa silenciosamente como 0 registros (antes: .default([]) lo absorbía)", async () => {
    await expect(discoverWith("{}")).rejects.toThrow();
  });

  it("'{\"success\":false,\"error\":\"captcha\"}' se clasifica como CaptchaDetectedError (marcador 'captcha' genérico), no como 0 registros", async () => {
    await expect(discoverWith('{"success":false,"error":"captcha"}')).rejects.toThrow(CaptchaDetectedError);
  });

  it("'{\"data\":[]}' (colección presente y EXPLÍCITAMENTE vacía) sigue siendo un resultado ok legítimo con 0 registros", async () => {
    const records = await discoverWith('{"data":[]}');
    expect(records).toEqual([]);
  });

  it("'{\"data\":null}' lanza -- 'data' presente pero de tipo incorrecto no es lo mismo que una colección vacía", async () => {
    await expect(discoverWith('{"data":null}')).rejects.toThrow();
  });

  it("DiscoveryPipeline: '{}' se clasifica interface_changed (nunca 'ok'), y '{\"data\":[]}' se clasifica ok con coverage.emptyResult=true", async () => {
    const emptyBodyConnector = createComprasMxConnector();
    const explicitEmptyConnector = createComprasMxConnector();

    const runOnce = async (connector: SourceConnector, body: string) => {
      const fetchImpl = async () => new Response(body, { status: 200 });
      const http = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0, maxRetries: 0 });
      const pipeline = new DiscoveryPipeline({
        connectors: [connector],
        repository: new InMemoryTenderRepository(),
        checkpoints: new InMemoryCheckpointStore(),
        http,
      });
      return pipeline.run();
    };

    const missingKeyResult = await runOnce(emptyBodyConnector, "{}");
    expect(missingKeyResult.bySource["compras-mx"].health.state).toBe("interface_changed");
    expect(missingKeyResult.bySource["compras-mx"].health.state).not.toBe("ok");

    const explicitEmptyResult = await runOnce(explicitEmptyConnector, '{"data":[]}');
    expect(explicitEmptyResult.bySource["compras-mx"].health.state).toBe("ok");
    expect(explicitEmptyResult.bySource["compras-mx"].health.evidence.coverage).toEqual({ emptyResult: true });
  });
});
