import type { ConnectorContext, DiscoverParams, SourceConnector } from "../types.js";
import { assertLegitimateResponseBody } from "../../http/response-classifier.js";
import { mapOcdsPackageToTenderRecords } from "../ocds/ocds-mapper.js";

export interface StatePortalConfig {
  /** Nombre legible del portal estatal (para logs/README, no es un `SourceId` propio: REQ-135 pide UN conector genérico). */
  name: string;
  /** Entidad federativa (se asigna a `TenderRecord.state` cuando el release OCDS no la trae). */
  state: string;
  /** Base candidata del API `/edca/...` de este portal. Puede ser `undefined` si aún no se localizó ninguna URL candidata. */
  baseUrl?: string;
  /** Evidencia de verificación específica de este portal (ver README §Portales estatales). */
  verified: boolean;
  note: string;
}

export interface StatePortalConnectorConfig {
  portals: StatePortalConfig[];
}

/**
 * Lista de portales estatales configurada a partir de la verificación en
 * vivo del 2026-09-05 (ver README §Portales estatales). Ninguno de los
 * hosts candidatos con patrón `/edca/...` respondió con una API real
 * dentro de esta sesión; se documenta como PENDIENTE para los tres estados
 * mencionados en REQ-135 (CDMX, Nuevo León, Yucatán).
 */
export const DEFAULT_STATE_PORTALS: StatePortalConfig[] = [
  {
    name: "CDMX",
    state: "Ciudad de México",
    baseUrl: undefined,
    verified: false,
    note:
      "2026-09-05: datos.cdmx.gob.mx -> 200 (portal CKAN real y funcional, confirmado con /api/3/action/package_search), " +
      "pero 0 resultados para 'contrataciones abiertas' y 'edca'. contratacionesabiertas.cdmx.gob.mx no resuelve por DNS. " +
      "No se localizó una API EDCA/OCDS real para CDMX.",
  },
  {
    name: "Nuevo León",
    state: "Nuevo León",
    baseUrl: undefined,
    verified: false,
    note: "2026-09-05: edca.nl.gob.mx y api.nl.gob.mx no resuelven por DNS desde este entorno. No se localizó API real.",
  },
  {
    name: "Yucatán",
    state: "Yucatán",
    baseUrl: undefined,
    verified: false,
    note:
      "2026-09-05: transparencia.yucatan.gob.mx -> 200 (portal de transparencia general, sin API EDCA localizada). " +
      "contratacionesabiertas.yucatan.gob.mx no resuelve por DNS. No se localizó API real.",
  },
];

/**
 * Conector genérico configurable para portales estatales con API OCDS
 * propia bajo el patrón compartido `/edca/...` (REQ-135). Es
 * intencionalmente un ESQUELETO: itera la lista de portales configurados y,
 * para cada uno que tenga `baseUrl` definido, reutiliza el mismo parser OCDS
 * 1.1 (`ocds-mapper.ts`) que `OcdsShcpConnector`/`PdnS6Connector`; para los
 * que no tienen `baseUrl` (todos los de `DEFAULT_STATE_PORTALS` hoy), el
 * `discover()` los omite sin lanzar error y lo deja anotado como pendiente.
 * No hace scraping específico por estado (prohibido por el alcance de esta
 * tarea) — solo el patrón OCDS genérico documentado en REQ-135.
 */
export function createStatePortalConnector(config: StatePortalConnectorConfig = { portals: DEFAULT_STATE_PORTALS }): SourceConnector {
  const portalsWithUrl = config.portals.filter((p): p is StatePortalConfig & { baseUrl: string } => Boolean(p.baseUrl));

  return {
    id: "state-portal",
    termsNote:
      "Cada portal estatal debe documentar su propio robots.txt/ToS antes de activarse (REQ-079/REQ-122: revisión legal " +
      "por fuente nueva). Ninguno está activo hoy.",
    liveVerification: {
      verified: portalsWithUrl.length > 0 && config.portals.every((p) => p.verified),
      note: config.portals.map((p) => `${p.name}: ${p.note}`).join(" | "),
    },

    async *discover(params: DiscoverParams, ctx: ConnectorContext) {
      let yielded = 0;
      for (const portal of portalsWithUrl) {
        const url = new URL(portal.baseUrl);
        if (params.since) url.searchParams.set("date_from", params.since.toISOString().slice(0, 10));
        if (params.cursor) url.searchParams.set("cursor", params.cursor);

        const response = await ctx.http.request(url.toString());
        if (!response.ok) {
          throw new Error(`Portal estatal ${portal.name} respondió ${response.status} en ${url}`);
        }
        const bodyText = await response.text();
        assertLegitimateResponseBody(bodyText, { url: url.toString(), expected: "json" });
        const json = JSON.parse(bodyText);
        const fetchedAt = ctx.now?.() ?? new Date();
        const { records, dropped } = mapOcdsPackageToTenderRecords(json, {
          source: "state-portal",
          sourceUrl: url.toString(),
          fetchedAt,
          httpStatus: response.status,
          defaultState: portal.state,
        });
        // SR-24: ver create-ocds-connector.ts -- ningún release descartado desaparece en silencio.
        for (const info of dropped) ctx.reportDropped?.(info);
        for (const record of records) {
          if (params.limit !== undefined && yielded >= params.limit) return;
          yield record;
          yielded += 1;
        }
      }
    },

    async fetchDetail() {
      throw new Error(
        "StatePortalConnector.fetchDetail no está implementado: ningún portal estatal configurado tiene una URL de " +
          "detalle verificada todavía (ver README §Portales estatales).",
      );
    },
  };
}
