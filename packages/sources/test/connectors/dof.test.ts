import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDofConnector } from "../../src/connectors/dof/dof-connector.js";
import { extractDofNoticesFromText, parseDofDate } from "../../src/connectors/dof/dof-mapper.js";
import { HttpClient } from "../../src/http/http-client.js";
import type { ConnectorContext } from "../../src/connectors/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "..", "fixtures", "dof", "nota-avisos-licitaciones.html");

describe("parseDofDate", () => {
  it("interpreta fechas DD/MM/YYYY como hora del Centro de México (UTC-6 fijo)", () => {
    const date = parseDofDate("10/09/2026");
    expect(date?.toISOString()).toBe("2026-09-10T06:00:00.000Z");
  });

  it("ignora puntuación final y devuelve undefined si no reconoce el formato", () => {
    expect(parseDofDate("12/09/2026.")?.toISOString()).toBe("2026-09-12T06:00:00.000Z");
    expect(parseDofDate("fecha por definir")).toBeUndefined();
    expect(parseDofDate(undefined)).toBeUndefined();
  });
});

describe("extractDofNoticesFromText (fixture reconstruido, ver README §DOF - PENDIENTE VERIFICACIÓN REAL)", () => {
  it("extrae dos avisos de convocatoria distintos del fixture con sus fechas y dependencia", () => {
    const html = readFileSync(fixturePath, "utf8");
    const text = html
      .replace(/<[^>]+>/g, "\n")
      .replace(/&iacute;/gi, "í")
      .replace(/&oacute;/gi, "ó");
    const notices = extractDofNoticesFromText(text, "5900001", "05/09/2026");

    expect(notices).toHaveLength(2);
    expect(notices[0].dependencia).toBe("SECRETARÍA DE SALUD");
    expect(notices[0].numeroConvocatoria).toBe("LA-012NAY001-E15-2026");
    expect(notices[0].fechaJuntaAclaraciones).toBe("10/09/2026");
    expect(notices[0].fechaPresentacionApertura).toBe("20/09/2026");
    expect(notices[0].fechaFallo).toBe("30/09/2026");

    expect(notices[1].dependencia).toBe("COMISIÓN NACIONAL DEL AGUA");
    expect(notices[1].numeroConvocatoria).toBe("LO-016B00003-E22-2026");
  });
});

describe("createDofConnector", () => {
  it("declara liveVerification.verified = false con evidencia real capturada (host 200, formato de convocatoria no confirmado)", () => {
    const connector = createDofConnector();
    expect(connector.liveVerification.verified).toBe(false);
    expect(connector.liveVerification.note).toMatch(/dof\.gob\.mx/);
    expect(connector.liveVerification.note).toMatch(/PENDIENTE VERIFICACIÓN REAL/);
  });

  it("discover() produce TenderRecord a partir de la nota fixture servida por un HttpClient simulado", async () => {
    const html = readFileSync(fixturePath, "utf8");
    const http = new HttpClient({
      userAgent: "TestBot/1.0",
      fetchImpl: (async () => new Response(html, { status: 200 })) as unknown as typeof fetch,
      minIntervalMsPerHost: 0,
    });
    const connector = createDofConnector({ noteCodes: ["5900001"] });
    const ctx: ConnectorContext = { http, now: () => new Date("2026-09-05T00:00:00Z") };

    const records = [];
    for await (const record of connector.discover({}, ctx)) records.push(record);

    expect(records).toHaveLength(2);
    expect(records[0].source).toBe("dof");
    expect(records[0].contractingEntity).toBe("SECRETARÍA DE SALUD");
    expect(records[0].status).toBe("published");
  });
});
