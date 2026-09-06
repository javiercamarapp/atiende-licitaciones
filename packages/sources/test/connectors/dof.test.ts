import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createDofConnector } from "../../src/connectors/dof/dof-connector.js";
import { extractDofNoticesFromText, mapDofNoticeToTenderRecordSafe, parseDofDate } from "../../src/connectors/dof/dof-mapper.js";
import { HttpClient } from "../../src/http/http-client.js";
import { CaptchaDetectedError, InterfaceChangedError } from "../../src/http/response-classifier.js";
import { DiscoveryPipeline } from "../../src/pipeline/discovery-pipeline.js";
import { InMemoryCheckpointStore } from "../../src/pipeline/checkpoint.js";
import { InMemoryTenderRepository } from "../../src/pipeline/repository.js";
import type { ConnectorContext } from "../../src/connectors/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "..", "fixtures", "dof", "nota-avisos-licitaciones.html");
const captchaRecaptchaFixturePath = path.join(__dirname, "..", "fixtures", "dof", "captcha-recaptcha.html");
const captchaChallengeFixturePath = path.join(__dirname, "..", "fixtures", "dof", "captcha-challenge.html");
const plantillaDistintaFixturePath = path.join(__dirname, "..", "fixtures", "dof", "nota-plantilla-distinta.html");
const interstitialCascaronFixturePath = path.join(__dirname, "..", "fixtures", "dof", "interstitial-cascaron.html");

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
  it("extrae dos avisos de convocatoria distintos del fixture con sus fechas y dependencia, sin ningún descarte", () => {
    const html = readFileSync(fixturePath, "utf8");
    const text = html
      .replace(/<[^>]+>/g, "\n")
      .replace(/&iacute;/gi, "í")
      .replace(/&oacute;/gi, "ó");
    const { notices, dropped } = extractDofNoticesFromText(text, "5900001", "05/09/2026");

    expect(dropped).toEqual([]);
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

  it("SR-14: un 200 real con cuerpo de reCAPTCHA lanza CaptchaDetectedError en vez de reportar '0 avisos'", async () => {
    const html = readFileSync(captchaRecaptchaFixturePath, "utf8");
    const http = new HttpClient({
      userAgent: "TestBot/1.0",
      fetchImpl: (async () => new Response(html, { status: 200 })) as unknown as typeof fetch,
      minIntervalMsPerHost: 0,
    });
    const connector = createDofConnector({ noteCodes: ["5797937"] });
    const ctx: ConnectorContext = { http, now: () => new Date("2026-09-05T00:00:00Z") };

    await expect(async () => {
      for await (const _r of connector.discover({}, ctx)) {
        /* no-op */
      }
    }).rejects.toThrow(CaptchaDetectedError);
  });

  it("SR-14: DiscoveryPipeline reporta health.state = 'captcha_detected' (NUNCA 'ok') ante un 200 con cuerpo de bot-challenge tipo Zenedge/Cloudflare", async () => {
    const html = readFileSync(captchaChallengeFixturePath, "utf8");
    const http = new HttpClient({
      userAgent: "TestBot/1.0",
      fetchImpl: (async () => new Response(html, { status: 200 })) as unknown as typeof fetch,
      minIntervalMsPerHost: 0,
    });
    const connector = createDofConnector({ noteCodes: ["5797937"] });
    const repository = new InMemoryTenderRepository();
    const pipeline = new DiscoveryPipeline({
      connectors: [connector],
      repository,
      checkpoints: new InMemoryCheckpointStore(),
      http,
    });

    const result = await pipeline.run();

    expect(result.bySource["dof"].health.state).toBe("captcha_detected");
    expect(result.bySource["dof"].health.state).not.toBe("ok");
    expect(result.bySource["dof"].nuevos).toBe(0);
  });

  it("SR-14: un 200 con nota fixture legítima (sin marcadores de captcha) NO se ve afectado por la nueva validación", async () => {
    const html = readFileSync(fixturePath, "utf8");
    const http = new HttpClient({
      userAgent: "TestBot/1.0",
      fetchImpl: (async () => new Response(html, { status: 200 })) as unknown as typeof fetch,
      minIntervalMsPerHost: 0,
    });
    const connector = createDofConnector({ noteCodes: ["5900001"] });
    const repository = new InMemoryTenderRepository();
    const pipeline = new DiscoveryPipeline({
      connectors: [connector],
      repository,
      checkpoints: new InMemoryCheckpointStore(),
      http,
    });

    const result = await pipeline.run();
    expect(result.bySource["dof"].health.state).toBe("ok");
    expect(result.bySource["dof"].nuevos).toBe(2);
  });
});

describe("SR-23 (MEDIA, residual de SR-20): marcadores SEMÁNTICOS de contenido real en vez de marcadores de plantilla fija", () => {
  it("una nota con plantilla HTML distinta (título/id de contenedor distintos) pero contenido real de negocio NO lanza (antes: falso positivo interface_changed)", async () => {
    const html = readFileSync(plantillaDistintaFixturePath, "utf8");
    const http = new HttpClient({
      userAgent: "TestBot/1.0",
      fetchImpl: (async () => new Response(html, { status: 200 })) as unknown as typeof fetch,
      minIntervalMsPerHost: 0,
    });
    const connector = createDofConnector({ noteCodes: ["5900002"] });
    const repository = new InMemoryTenderRepository();
    const pipeline = new DiscoveryPipeline({
      connectors: [connector],
      repository,
      checkpoints: new InMemoryCheckpointStore(),
      http,
    });

    const result = await pipeline.run();
    expect(result.bySource["dof"].health.state).toBe("ok");
    expect(result.bySource["dof"].nuevos).toBe(1);
  });

  it("un interstitial genérico ('Verificando su navegador...' + <script> de redirección) que preserva el título/id del sitio real lanza InterfaceChangedError (antes: falso negativo, health.state='ok')", async () => {
    const html = readFileSync(interstitialCascaronFixturePath, "utf8");
    const http = new HttpClient({
      userAgent: "TestBot/1.0",
      fetchImpl: (async () => new Response(html, { status: 200 })) as unknown as typeof fetch,
      minIntervalMsPerHost: 0,
    });
    const connector = createDofConnector({ noteCodes: ["5797937"] });

    await expect(async () => {
      for await (const _r of connector.discover({}, { http, now: () => new Date("2026-09-05T00:00:00Z") })) {
        /* no-op */
      }
    }).rejects.toThrow(InterfaceChangedError);
  });

  it("DiscoveryPipeline: el interstitial de arriba se clasifica 'interface_changed', NUNCA 'ok' (el vector real que SR-20 debía cerrar)", async () => {
    const html = readFileSync(interstitialCascaronFixturePath, "utf8");
    const http = new HttpClient({
      userAgent: "TestBot/1.0",
      fetchImpl: (async () => new Response(html, { status: 200 })) as unknown as typeof fetch,
      minIntervalMsPerHost: 0,
    });
    const connector = createDofConnector({ noteCodes: ["5797937"] });
    const pipeline = new DiscoveryPipeline({
      connectors: [connector],
      repository: new InMemoryTenderRepository(),
      checkpoints: new InMemoryCheckpointStore(),
      http,
    });

    const result = await pipeline.run();
    expect(result.bySource["dof"].health.state).toBe("interface_changed");
    expect(result.bySource["dof"].health.state).not.toBe("ok");
  });

  it("un challenge de vendor conocido (reCAPTCHA) sigue clasificándose 'captcha_detected', no 'interface_changed' (regresión)", async () => {
    const html = readFileSync(captchaRecaptchaFixturePath, "utf8");
    const http = new HttpClient({
      userAgent: "TestBot/1.0",
      fetchImpl: (async () => new Response(html, { status: 200 })) as unknown as typeof fetch,
      minIntervalMsPerHost: 0,
    });
    const connector = createDofConnector({ noteCodes: ["5797937"] });
    const pipeline = new DiscoveryPipeline({
      connectors: [connector],
      repository: new InMemoryTenderRepository(),
      checkpoints: new InMemoryCheckpointStore(),
      http,
    });

    const result = await pipeline.run();
    expect(result.bySource["dof"].health.state).toBe("captcha_detected");
  });
});

describe("SR-24 (ALTA, residual de SR-21, generalizado a DOF): ningún aviso se descarta en silencio", () => {
  it("mapDofNoticeToTenderRecordSafe devuelve {dropped} con motivo en vez de lanzar, cuando el aviso no cumple TenderRecordSchema", () => {
    const noticeInvalido = {
      codigo: "5900003",
      fecha: "05/09/2026",
      dependencia: "SECRETARÍA DE PRUEBA",
      // `titulo: ""` no cumple `TenderRecordSchema.title` (z.string().min(1)) -- antes de esta ronda,
      // `mapDofNoticeToTenderRecord` lanzaba directo dentro del `for` de `discover()`, sin ningún try/catch,
      // abortando TODOS los avisos restantes de la nota Y de cualquier noteCode posterior en la misma corrida.
      titulo: "",
      numeroConvocatoria: "LA-000-2026",
      fechaJuntaAclaraciones: undefined,
      fechaPresentacionApertura: undefined,
      fechaFallo: undefined,
    };

    const result = mapDofNoticeToTenderRecordSafe(noticeInvalido, "<html></html>", { sourceUrl: "https://dof.gob.mx/nota_detalle.php?codigo=5900003", fetchedAt: new Date("2026-09-06T00:00:00Z") });

    expect("dropped" in result).toBe(true);
    if ("dropped" in result) {
      expect(result.dropped.reason).toMatch(/no se pudo mapear/i);
      expect(result.dropped.externalId).toBe("5900003:LA-000-2026");
    }
  });

  it("extractDofNoticesFromText NO reporta ningún descarte para una nota real válida (regresión: dropped[] nuevo no afecta el caso feliz)", () => {
    // `dropped[]` (SR-24) cubre el caso -- hoy inalcanzable con HTML real dado que los fallbacks de esta función
    // siempre producen dependencia/título no vacíos, ver comentario en `dof-mapper.ts` -- de que un cambio futuro
    // en el patrón de corte produzca un bloque que ya no empiece con "DEPENDENCIA.-Convocatoria" o que no cumpla
    // `DofNoticeSchema`. Con una nota real, `dropped` debe seguir vacío.
    const html = readFileSync(fixturePath, "utf8");
    const text = html.replace(/<[^>]+>/g, "\n").replace(/&iacute;/gi, "í").replace(/&oacute;/gi, "ó");
    const { notices, dropped } = extractDofNoticesFromText(text, "5900001", "05/09/2026");
    // Regresión: la nota real de 2 avisos válidos sigue sin ningún descarte (ver primer test de este archivo).
    expect(notices).toHaveLength(2);
    expect(dropped).toEqual([]);
  });

  it("createDofConnector.discover() reenvía a ctx.reportDropped cualquier entrada de dropped[] que produzca extractDofNoticesFromText o mapDofNoticeToTenderRecordSafe (wiring real, verificado con dof-mapper mockeado)", async () => {
    vi.resetModules();
    vi.doMock("../../src/connectors/dof/dof-mapper.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/connectors/dof/dof-mapper.js")>();
      return {
        ...actual,
        extractDofNoticesFromText: (): ReturnType<typeof actual.extractDofNoticesFromText> => ({
          notices: [
            {
              codigo: "5900099",
              fecha: "06/09/2026",
              dependencia: "DEPENDENCIA VÁLIDA",
              numeroConvocatoria: "LA-100-2026",
              titulo: "Aviso válido de prueba",
              fechaJuntaAclaraciones: undefined,
              fechaPresentacionApertura: undefined,
              fechaFallo: undefined,
            },
          ],
          dropped: [{ index: 0, reason: "Bloque sintético inválido (prueba de wiring SR-24)" }],
        }),
      };
    });

    const { createDofConnector: createDofConnectorMocked } = await import("../../src/connectors/dof/dof-connector.js");
    const html = readFileSync(fixturePath, "utf8");
    const http = new HttpClient({
      userAgent: "TestBot/1.0",
      fetchImpl: (async () => new Response(html, { status: 200 })) as unknown as typeof fetch,
      minIntervalMsPerHost: 0,
    });
    const connector = createDofConnectorMocked({ noteCodes: ["5900001"] });
    const reported: unknown[] = [];
    const ctx: ConnectorContext = { http, now: () => new Date("2026-09-06T00:00:00Z"), reportDropped: (info) => reported.push(info) };

    const records = [];
    for await (const record of connector.discover({}, ctx)) records.push(record);

    expect(records).toHaveLength(1);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ reason: expect.stringMatching(/bloque sintético inválido/i) });

    vi.doUnmock("../../src/connectors/dof/dof-mapper.js");
    vi.resetModules();
  });
});
