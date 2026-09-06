import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mapOcdsPackageToTenderRecords } from "../../src/connectors/ocds/ocds-mapper.js";
import { OcdsReleasePackageSchema } from "../../src/connectors/ocds/ocds-types.js";
import { createOcdsShcpConnector } from "../../src/connectors/ocds-shcp/ocds-shcp-connector.js";
import { HttpClient } from "../../src/http/http-client.js";
import { CaptchaDetectedError } from "../../src/http/response-classifier.js";
import type { ConnectorContext } from "../../src/connectors/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "..", "fixtures", "ocds-shcp");

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8"));
}

describe("mapOcdsPackageToTenderRecords", () => {
  it("mapea releases OCDS 1.1 con tag 'tender' e ignora los que no traen bloque tender", () => {
    const pkg = readFixture("release-package-page1.json");
    const records = mapOcdsPackageToTenderRecords(pkg, { source: "ocds-shcp", sourceUrl: "https://example.gob.mx/ocds", fetchedAt: new Date("2026-08-20T00:00:00Z") });

    expect(records).toHaveLength(2); // el tercer release (tag "contract", sin bloque tender) se ignora

    const [first, second] = records;
    expect(first.externalId).toBe("LA-050GYN003-E1-2026");
    expect(first.contractingEntity).toBe("Instituto Mexicano del Seguro Social");
    expect(first.procedureType).toBe("licitacion_publica");
    expect(first.budgetAmount).toBe(18500000);
    expect(first.currency).toBe("MXN");
    expect(first.classifiers).toEqual([
      { scheme: "UNSPSC", code: "42311500", description: "Apósitos" },
      { scheme: "CUCoP", code: "25101500", description: "Guantes médicos" },
    ]);
    expect(first.status).toBe("open_for_submission");
    expect(first.state).toBe("Ciudad de México");
    expect(first.attachments).toEqual([{ name: "Bases de licitación", url: "https://example.gob.mx/docs/LA-050GYN003-E1-2026/bases.pdf", mimeType: "application/pdf" }]);
    expect(first.snapshot.rawHash).toMatch(/^[a-f0-9]{64}$/);

    expect(second.procedureType).toBe("invitacion_restringida");
    expect(second.status).toBe("scheduled");
  });

  it("produce el mismo rawHash para el mismo payload calculado dos veces (determinismo)", () => {
    const pkg = readFixture("release-package-page1.json");
    const a = mapOcdsPackageToTenderRecords(pkg, { source: "ocds-shcp", fetchedAt: new Date() });
    const b = mapOcdsPackageToTenderRecords(pkg, { source: "ocds-shcp", fetchedAt: new Date() });
    expect(a[0].snapshot.rawHash).toBe(b[0].snapshot.rawHash);
  });
});

describe("createOcdsShcpConnector", () => {
  it("pagina siguiendo links.next y asigna sourceCursor solo al último registro de cada página", async () => {
    const page1 = readFixture("release-package-page1.json");
    const page2 = readFixture("release-package-page2.json");

    const fetchImpl = async (url: string) => {
      if (url.includes("page=2")) return new Response(JSON.stringify(page2), { status: 200 });
      return new Response(JSON.stringify(page1), { status: 200 });
    };

    const http = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0 });
    const connector = createOcdsShcpConnector({ baseUrl: "https://example.gob.mx/ocds/releases" });
    const ctx: ConnectorContext = { http, now: () => new Date("2026-08-20T00:00:00Z") };

    const records = [];
    for await (const record of connector.discover({}, ctx)) records.push(record);

    expect(records).toHaveLength(3); // 2 de la página 1 + 1 de la página 2
    expect(records[0].sourceCursor).toBeUndefined();
    expect(records[1].sourceCursor).toBe("https://example.gob.mx/ocds/releases?page=2");
    expect(records[2].sourceCursor).toBeUndefined(); // page2 no trae links.next
  });

  it("declara liveVerification.verified = false con evidencia (no se inventa integración real)", () => {
    const connector = createOcdsShcpConnector();
    expect(connector.liveVerification.verified).toBe(false);
    expect(connector.liveVerification.note).toMatch(/api\.datos\.gob\.mx/);
  });
});

describe("SR-19 (ALTA, residual de SR-14): OcdsReleasePackageSchema.releases sin '.default([])' (comparte esquema con PDN-S6/portales estatales)", () => {
  it("'{}' (sin la llave 'releases') lanza ZodError -- ya no pasa silenciosamente como 0 releases", () => {
    expect(() => OcdsReleasePackageSchema.parse({})).toThrow();
  });

  it("'{\"releases\":null}' lanza -- presente pero de tipo incorrecto no es lo mismo que una colección vacía", () => {
    expect(() => OcdsReleasePackageSchema.parse({ releases: null })).toThrow();
  });

  it("'{\"releases\":[]}' (colección presente y EXPLÍCITAMENTE vacía) sigue siendo válido", () => {
    expect(() => OcdsReleasePackageSchema.parse({ releases: [] })).not.toThrow();
  });

  it("createOcdsShcpConnector.discover() ante '{}' lanza (no produce 0 registros en silencio)", async () => {
    const fetchImpl = async () => new Response("{}", { status: 200 });
    const http = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0, maxRetries: 0 });
    const connector = createOcdsShcpConnector();
    const ctx: ConnectorContext = { http, now: () => new Date() };

    await expect(async () => {
      for await (const _r of connector.discover({}, ctx)) {
        /* no-op */
      }
    }).rejects.toThrow();
  });

  it("createOcdsShcpConnector.discover() ante un soft-block JSON con la palabra 'captcha' lanza CaptchaDetectedError", async () => {
    const fetchImpl = async () => new Response('{"error":"captcha"}', { status: 200 });
    const http = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0, maxRetries: 0 });
    const connector = createOcdsShcpConnector();
    const ctx: ConnectorContext = { http, now: () => new Date() };

    await expect(async () => {
      for await (const _r of connector.discover({}, ctx)) {
        /* no-op */
      }
    }).rejects.toThrow(CaptchaDetectedError);
  });
});
