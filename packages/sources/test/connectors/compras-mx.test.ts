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
import type { ConnectorContext } from "../../src/connectors/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "..", "fixtures", "compras-mx");

describe("ComprasMX: mapeo del API inferido (esquema no confirmado en vivo, ver README)", () => {
  it("mapea expedientes del fixture con los nombres de campo reales encontrados en la SPA pública", () => {
    const fixture = JSON.parse(readFileSync(path.join(fixturesDir, "expedientes-page1.json"), "utf8"));
    const registros = fixture.data[0].registros;
    const records = mapComprasMxApiRecords(registros, { fetchedAt: new Date("2026-08-25T00:00:00Z") });

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

describe("ComprasMX: CSV histórico REAL (verificado en vivo 2026-09-05, ver README)", () => {
  it("parsea el fixture descargado en vivo de datos.gob.mx (SABG) sin errores y con montos correctos", () => {
    const csv = readFileSync(path.join(fixturesDir, "compranet-historico-real-sample.csv"), "utf8");
    const records = parseComprasMxHistoricoCsv(csv, {
      fetchedAt: new Date("2026-09-05T00:00:00Z"),
      sourceUrl: "https://repodatos.atdt.gob.mx/api_update/sabg/contratos_expedientes_sistema_historico_compranet/compranet_historico.csv",
      publishingEntity: "Secretaría Anticorrupción y Buen Gobierno (dataset histórico Compranet)",
    });

    expect(records.length).toBeGreaterThan(5);
    const first = records[0];
    expect(first.externalId).toBe("2161394");
    expect(first.title).toBe("Servicios Profesionales Para la Elaboración de Avalúos");
    expect(first.currency).toBe("MXN");
    expect(first.budgetAmount).toBe(89012);
    expect(first.status).toBe("awarded");
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
