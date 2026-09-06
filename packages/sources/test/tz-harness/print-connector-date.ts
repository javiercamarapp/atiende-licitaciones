/**
 * Harness GENÉRICO ejecutado en un SUBPROCESO real (SR-12, invariante
 * ampliada) para probar, sobre CUALQUIER conector registrado, que una fecha
 * de negocio NAIVE servida por la fuente produce el MISMO instante sin
 * importar el `TZ` del proceso. Sirve un fixture mínimo por conector vía un
 * `HttpClient` con `fetchImpl` simulado (nunca red real), adaptado al
 * formato que cada fuente usa realmente, y siempre con una fecha SIN offset
 * explícito.
 *
 * Uso: `tsx print-connector-date.ts <connectorId>`
 * Imprime `{ dateIso: string | undefined, resolvedTz: string }`.
 */
import { createComprasMxConnector } from "../../src/connectors/compras-mx/compras-mx-connector.js";
import { createComprasMxHistoricalCsvConnector } from "../../src/connectors/compras-mx/compras-mx-historical-csv-connector.js";
import { createDofConnector } from "../../src/connectors/dof/dof-connector.js";
import { createOcdsShcpConnector } from "../../src/connectors/ocds-shcp/ocds-shcp-connector.js";
import { createPdnS6Connector } from "../../src/connectors/pdn-s6/pdn-s6-connector.js";
import { createStatePortalConnector } from "../../src/connectors/state-portal/state-portal-connector.js";
import { HttpClient } from "../../src/http/http-client.js";
import type { ConnectorContext } from "../../src/connectors/types.js";
import type { SourceConnector } from "../../src/connectors/types.js";

const connectorId = process.argv[2];

const NAIVE_DATE = "2026-09-10T14:00:00"; // 14:00 CDMX naive (sin offset) -- 20:00 UTC es el instante correcto.

function buildFixtureResponse(id: string): Response {
  switch (id) {
    case "compras-mx":
      return new Response(
        JSON.stringify({
          data: [
            {
              registros: [
                {
                  codigo_expediente: "TZ-1",
                  titulo_expediente: "Prueba de independencia de zona horaria",
                  dependencia_entidad: "Entidad de prueba",
                  fecha_apertura_proposiciones: NAIVE_DATE,
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    case "compras-mx-historico":
      return new Response(
        "codigo_contrato,codigo_expediente,proveedor,titulo_contrato,importe,moneda,fecha_inicio,fecha_fin\n" +
          `C1,E1,Proveedor de prueba,Prueba de independencia de zona horaria,100,MXN,${NAIVE_DATE},\n`,
        { status: 200 },
      );
    case "dof":
      return new Response(
        "DEPENDENCIA DE PRUEBA.-Convocatoria pública. Objeto: prueba de independencia de zona horaria. " +
          "Presentación y apertura de proposiciones: 10/09/2026.",
        { status: 200 },
      );
    case "ocds-shcp":
    case "pdn-s6":
    case "state-portal":
      return new Response(
        JSON.stringify({
          releases: [
            {
              ocid: "ocds-tz-1",
              id: "release-tz-1",
              date: "2026-01-01T00:00:00Z",
              buyer: { name: "Entidad de prueba" },
              tender: {
                id: "tender-tz-1",
                title: "Prueba de independencia de zona horaria",
                tenderPeriod: { endDate: NAIVE_DATE },
              },
            },
          ],
        }),
        { status: 200 },
      );
    default:
      throw new Error(`connectorId no soportado por el harness: ${id}`);
  }
}

function buildConnector(id: string): SourceConnector {
  switch (id) {
    case "compras-mx":
      return createComprasMxConnector();
    case "compras-mx-historico":
      return createComprasMxHistoricalCsvConnector();
    case "dof":
      return createDofConnector({ noteCodes: ["1"] });
    case "ocds-shcp":
      return createOcdsShcpConnector();
    case "pdn-s6":
      return createPdnS6Connector();
    case "state-portal":
      return createStatePortalConnector({
        portals: [{ name: "Prueba", state: "Prueba", baseUrl: "https://example.gob.mx/edca/releases", verified: false, note: "harness" }],
      });
    default:
      throw new Error(`connectorId no soportado por el harness: ${id}`);
  }
}

async function main() {
  const fetchImpl = (async () => buildFixtureResponse(connectorId)) as unknown as typeof fetch;
  const http = new HttpClient({ userAgent: "TZHarness/1.0", fetchImpl, minIntervalMsPerHost: 0 });
  const ctx: ConnectorContext = { http, now: () => new Date("2026-01-01T00:00:00Z") };

  const connector = buildConnector(connectorId);
  const records = [];
  for await (const record of connector.discover({}, ctx)) records.push(record);
  const record = records[0];
  const dateIso = record?.dates.submissionDeadline?.toISOString() ?? record?.dates.published?.toISOString();

  process.stdout.write(
    JSON.stringify({
      dateIso,
      recordCount: records.length,
      resolvedTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  );
}

main();
