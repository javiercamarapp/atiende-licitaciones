import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConnectorRegistry } from "../../src/connectors/registry.js";
import type { SourceConnector } from "../../src/connectors/types.js";
import { createComprasMxConnector } from "../../src/connectors/compras-mx/compras-mx-connector.js";
import { createDofConnector } from "../../src/connectors/dof/dof-connector.js";
import { createOcdsShcpConnector } from "../../src/connectors/ocds-shcp/ocds-shcp-connector.js";
import { createPdnS6Connector } from "../../src/connectors/pdn-s6/pdn-s6-connector.js";
import { createStatePortalConnector } from "../../src/connectors/state-portal/state-portal-connector.js";
import { HttpClient } from "../../src/http/http-client.js";
import { DiscoveryPipeline } from "../../src/pipeline/discovery-pipeline.js";
import { InMemoryCheckpointStore } from "../../src/pipeline/checkpoint.js";
import { InMemoryTenderRepository } from "../../src/pipeline/repository.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * SR-24 (ALTA, ver `docs/auditoria-1/sources-cierre-final.md` §4): la
 * reverificación adversarial de cierre confirmó que la invariante de SR-21
 * ("ningún registro se descarta en silencio", `ctx.reportDropped` +
 * `DiscoveryPipeline.dropRateThreshold`) solo estaba conectada para
 * ComprasMX -- `create-ocds-connector.ts` (compartido por 3 de los otros 4
 * `SourceId`) nunca invocaba `ctx.reportDropped`, así que un release
 * package OCDS con 80% de sus releases sin bloque `tender` producía
 * `health.state="ok"`, `dropped:[]`, `errores:[]`: la MISMA violación de
 * REQ-148 que motivó SR-21, invisible para OCDS-SHCP/PDN-S6/portales
 * estatales.
 *
 * Este archivo es el test de INVARIANTE que cierra ese hallazgo: recorre
 * TODOS los conectores del `ConnectorRegistry` (no solo ComprasMX) con un
 * fixture propio de cada fuente que trae exactamente 1 registro/release
 * crudo inválido entre registros válidos, corre el conector REAL (no un
 * stub) a través de `DiscoveryPipeline`, y verifica que:
 *   (a) `dropped.length >= 1` con un motivo explícito en cada entrada, y
 *   (b) `errores[]` trae una entrada correspondiente, y
 *   (c) una tasa de descarte por encima del umbral default (20%) reclasifica
 *       `health.state` a `interface_changed` -- nunca `"ok"` -- para
 *       CUALQUIERA de los conectores, no solo ComprasMX (que ya lo tenía
 *       cubierto desde SR-21, ver `compras-mx.test.ts`).
 *
 * `dof` se incluye con una nota real (0 descartes esperados, caso feliz):
 * el mecanismo de descarte por bloque/aviso inválido de DOF (SR-24,
 * generalizado desde SR-21) se prueba con un doble suficientemente directo
 * en `dof.test.ts` (mockeando `dof-mapper.ts` para forzar un bloque
 * inválido) porque, a diferencia de ComprasMX/OCDS, sus fallbacks de
 * regex hacen prácticamente imposible producir un aviso inválido a partir
 * de HTML real (ver comentario en `dof-mapper.ts`); lo que SÍ se confirma
 * aquí es que la nota real NO produce ningún descarte espurio.
 */

const registry = new ConnectorRegistry();
registry.register(createComprasMxConnector());
registry.register(createDofConnector({ noteCodes: ["5900001"] }));
registry.register(createOcdsShcpConnector());
registry.register(createPdnS6Connector());
registry.register(
  createStatePortalConnector({
    portals: [{ name: "Estado de Prueba", state: "Estado de Prueba", baseUrl: "https://example.gob.mx/edca/releases", verified: false, note: "fixture de prueba" }],
  }),
);

const ocdsFixtureConUnReleaseInvalido = {
  releases: [
    { ocid: "ocds-1", id: "r1", tender: { id: "LA-1-2026", title: "Válido 1" } },
    { ocid: "ocds-2", id: "r2", tender: { id: "LA-2-2026", title: "Válido 2" } },
    // Inválido: falta `ocid` (requerido por OcdsReleaseSchema) -- 1/3 = 33.3% > 20% (umbral default).
    { id: "r3-sin-ocid", tender: { id: "LA-3-2026", title: "Inválido: falta ocid" } },
  ],
};

const comprasMxFixtureConUnRegistroInvalido = JSON.stringify({
  data: [
    {
      registros: [
        { codigo_expediente: "E-1", titulo_expediente: "Válido 1" },
        { codigo_expediente: "E-2", titulo_expediente: "Válido 2" },
        // Inválido: titulo_expediente ausente -- 1/3 = 33.3% > 20% (umbral default).
        { codigo_expediente: "E-3" },
      ],
    },
  ],
});

async function runOne(connector: SourceConnector, fetchImpl: typeof fetch) {
  const http = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl, minIntervalMsPerHost: 0 });
  const pipeline = new DiscoveryPipeline({
    connectors: [connector],
    repository: new InMemoryTenderRepository(),
    checkpoints: new InMemoryCheckpointStore(),
    http,
  });
  return pipeline.run();
}

describe("INVARIANTE SR-21/SR-24: ningún conector registrado descarta un registro/release inválido en silencio", () => {
  it("compras-mx: 1 registro inválido entre 3 se reporta en dropped[]/errores[] y reclasifica interface_changed (>20%)", async () => {
    const fetchImpl = (async () => new Response(comprasMxFixtureConUnRegistroInvalido, { status: 200 })) as unknown as typeof fetch;
    const result = await runOne(registry.requireById("compras-mx"), fetchImpl);
    const stats = result.bySource["compras-mx"];

    expect(stats.dropped.length).toBeGreaterThanOrEqual(1);
    expect(stats.dropped.every((d) => typeof d.reason === "string" && d.reason.length > 0)).toBe(true);
    expect(stats.errores.some((e) => e.message.length > 0)).toBe(true);
    expect(stats.health.state).toBe("interface_changed");
  });

  it("ocds-shcp: 1 release inválido (sin ocid) entre 3 se reporta en dropped[]/errores[] y reclasifica interface_changed (>20%)", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(ocdsFixtureConUnReleaseInvalido), { status: 200 })) as unknown as typeof fetch;
    const result = await runOne(registry.requireById("ocds-shcp"), fetchImpl);
    const stats = result.bySource["ocds-shcp"];

    expect(stats.dropped.length).toBeGreaterThanOrEqual(1);
    expect(stats.dropped.every((d) => typeof d.reason === "string" && d.reason.length > 0)).toBe(true);
    expect(stats.errores.some((e) => e.message.length > 0)).toBe(true);
    expect(stats.health.state).toBe("interface_changed");
  });

  it("pdn-s6 (mismo create-ocds-connector.ts compartido): 1 release inválido se reporta en dropped[]/errores[] y reclasifica interface_changed -- ANTES de SR-24, esto era invisible (dropped:[], health='ok')", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(ocdsFixtureConUnReleaseInvalido), { status: 200 })) as unknown as typeof fetch;
    const result = await runOne(registry.requireById("pdn-s6"), fetchImpl);
    const stats = result.bySource["pdn-s6"];

    expect(stats.dropped.length).toBeGreaterThanOrEqual(1);
    expect(stats.dropped.every((d) => typeof d.reason === "string" && d.reason.length > 0)).toBe(true);
    expect(stats.errores.some((e) => e.message.length > 0)).toBe(true);
    expect(stats.health.state).toBe("interface_changed");
  });

  it("state-portal (mismo create-ocds-connector.ts compartido): 1 release inválido se reporta en dropped[]/errores[] y reclasifica interface_changed -- ANTES de SR-24, esto era invisible (dropped:[], health='ok')", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(ocdsFixtureConUnReleaseInvalido), { status: 200 })) as unknown as typeof fetch;
    const result = await runOne(registry.requireById("state-portal"), fetchImpl);
    const stats = result.bySource["state-portal"];

    expect(stats.dropped.length).toBeGreaterThanOrEqual(1);
    expect(stats.dropped.every((d) => typeof d.reason === "string" && d.reason.length > 0)).toBe(true);
    expect(stats.errores.some((e) => e.message.length > 0)).toBe(true);
    expect(stats.health.state).toBe("interface_changed");
  });

  it("dof: una nota real (sin registros inválidos) no produce ningún descarte espurio (el mecanismo de descarte de DOF se prueba con un mock dedicado en dof.test.ts, ver SR-24 ahí)", async () => {
    const html = readFileSync(path.join(__dirname, "..", "fixtures", "dof", "nota-avisos-licitaciones.html"), "utf8");
    const fetchImpl = (async () => new Response(html, { status: 200 })) as unknown as typeof fetch;
    const result = await runOne(registry.requireById("dof"), fetchImpl);
    const stats = result.bySource["dof"];

    expect(stats.dropped).toEqual([]);
    expect(stats.health.state).toBe("ok");
    expect(stats.nuevos).toBe(2);
  });
});
