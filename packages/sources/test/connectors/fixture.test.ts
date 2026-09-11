import { describe, expect, it } from "vitest";
import { createFixtureOfflineConnector, DEFAULT_FIXTURE_TENDERS } from "../../src/connectors/fixture/fixture-connector.js";
import { HttpClient } from "../../src/http/http-client.js";
import type { ConnectorContext } from "../../src/connectors/types.js";

/**
 * REQ-070 (Radar del orquestador Radar→Analista→Redactor→Auditor→Mensajero):
 * el conector sintético/offline es el ÚNICO conector permitido a declarar un
 * atajo del gate de REQ-150 (`liveVerification.synthetic`), y solo porque
 * `liveVerification.verified` se queda HONESTAMENTE en `false` para siempre
 * (nunca hay un servicio real detrás de él que verificar) — B-02 sigue
 * abierto para las 5 fuentes reales.
 */
describe("createFixtureOfflineConnector (REQ-070, Radar sintético/offline)", () => {
  const http = new HttpClient({ userAgent: "TestBot/1.0", minIntervalMsPerHost: 0 });
  const ctx: ConnectorContext = { http, now: () => new Date("2026-09-10T00:00:00Z") };

  it("nunca declara verified:true (B-02 sigue abierto) y SÍ declara synthetic:true explícito", () => {
    const connector = createFixtureOfflineConnector();
    expect(connector.id).toBe("fixture-offline");
    expect(connector.liveVerification.verified).toBe(false);
    expect(connector.liveVerification.synthetic).toBe(true);
    expect(connector.liveVerification.note).toMatch(/sintético|B-02/i);
  });

  it("produce las convocatorias sintéticas por defecto, cada una rotulada [SINTÉTICO] en título y dependencia", async () => {
    const connector = createFixtureOfflineConnector();
    const records = [];
    for await (const record of connector.discover({}, ctx)) records.push(record);

    expect(records).toHaveLength(DEFAULT_FIXTURE_TENDERS.length);
    for (const record of records) {
      expect(record.source).toBe("fixture-offline");
      expect(record.title).toMatch(/^\[SINTÉTICO\]/);
      expect(record.contractingEntity).toMatch(/^\[SINTÉTICO\]/);
      expect(record.snapshot.rawHash).toHaveLength(64);
    }
  });

  it("respeta params.limit (paginación acotada, mismo contrato que los conectores reales)", async () => {
    const connector = createFixtureOfflineConnector();
    const records = [];
    for await (const record of connector.discover({ limit: 1 }, ctx)) records.push(record);
    expect(records).toHaveLength(1);
    expect(records[0].externalId).toBe(DEFAULT_FIXTURE_TENDERS[0].externalId);
  });

  it("acepta convocatorias sintéticas propias (config.tenders) para escenarios de prueba a medida", async () => {
    const connector = createFixtureOfflineConnector({
      tenders: [{ externalId: "CUSTOM-1", title: "Caso a medida", contractingEntity: "Dependencia a medida" }],
    });
    const records = [];
    for await (const record of connector.discover({}, ctx)) records.push(record);
    expect(records).toHaveLength(1);
    expect(records[0].externalId).toBe("CUSTOM-1");
    expect(records[0].title).toBe("[SINTÉTICO] Caso a medida");
  });

  it("fetchDetail: encuentra por externalId el mismo registro sintético que discover(), o null si no existe", async () => {
    const connector = createFixtureOfflineConnector();
    const found = await connector.fetchDetail(DEFAULT_FIXTURE_TENDERS[0].externalId, ctx);
    expect(found?.externalId).toBe(DEFAULT_FIXTURE_TENDERS[0].externalId);
    const missing = await connector.fetchDetail("NO-EXISTE", ctx);
    expect(missing).toBeNull();
  });

  it("termsNote documenta honestamente que nunca hace una petición HTTP real", () => {
    const connector = createFixtureOfflineConnector();
    expect(connector.termsNote).toMatch(/nunca hace una petición HTTP real/i);
  });
});
