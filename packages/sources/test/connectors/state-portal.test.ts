import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createStatePortalConnector, DEFAULT_STATE_PORTALS } from "../../src/connectors/state-portal/state-portal-connector.js";
import { HttpClient } from "../../src/http/http-client.js";
import type { ConnectorContext } from "../../src/connectors/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "..", "fixtures", "ocds-shcp", "release-package-page1.json");

describe("createStatePortalConnector", () => {
  it("por defecto (sin baseUrl configurado) no produce registros y documenta el pendiente por portal", async () => {
    const connector = createStatePortalConnector();
    expect(connector.liveVerification.verified).toBe(false);
    for (const portal of DEFAULT_STATE_PORTALS) {
      expect(connector.liveVerification.note).toContain(portal.name);
    }

    const http = new HttpClient({ userAgent: "TestBot/1.0", minIntervalMsPerHost: 0 });
    const ctx: ConnectorContext = { http, now: () => new Date() };
    const records = [];
    for await (const record of connector.discover({}, ctx)) records.push(record);
    expect(records).toHaveLength(0);
  });

  it("cuando un portal SÍ tiene baseUrl, reutiliza el mismo parser OCDS genérico (REQ-135) y etiqueta el estado", async () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    const fetchImpl = async () => new Response(JSON.stringify(fixture), { status: 200 });
    const http = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0 });

    const connector = createStatePortalConnector({
      portals: [{ name: "Estado de Prueba", state: "Estado de Prueba", baseUrl: "https://example.gob.mx/edca/releases", verified: false, note: "fixture de prueba" }],
    });
    const ctx: ConnectorContext = { http, now: () => new Date("2026-08-20T00:00:00Z") };

    const records = [];
    for await (const record of connector.discover({}, ctx)) records.push(record);

    expect(records).toHaveLength(2);
    expect(records[0].state).toBe("Ciudad de México"); // el release ya trae región propia, tiene prioridad sobre el default del portal
  });
});
