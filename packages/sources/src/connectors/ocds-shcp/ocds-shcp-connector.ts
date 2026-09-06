import type { DiscoverParams, SourceConnector } from "../types.js";
import { createOcdsConnector } from "../ocds/create-ocds-connector.js";

export interface OcdsShcpConnectorConfig {
  /** Base candidata para el API OCDS de datos abiertos gubernamentales (REQ-133). No confirmada en vivo, ver README §OCDS-SHCP. */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://api.datos.gob.mx/v2/contratacionesabiertas";

/**
 * Conector al API OCDS de datos abiertos de contrataciones públicas
 * (REQ-133). Evidencia real de verificación 2026-09-05 (ver README
 * §OCDS-SHCP):
 * - `https://api.datos.gob.mx/*` fue inalcanzable (timeout de conexión) en
 *   TODOS los intentos desde este entorno, a diferencia de `www.datos.gob.mx`
 *   que sí respondió 200 y expone una API CKAN funcional
 *   (`/api/3/action/package_search`).
 * - Se consultó esa API CKAN real con los términos "contrataciones abiertas",
 *   "OCDS", "EDCA", "PDN", "sistema 6" y ningún resultado corresponde a un
 *   dataset de OCDS gubernamental consolidado; tampoco existe bajo la
 *   organización `sfp` (Secretaría de la Función Pública) un dataset de
 *   contrataciones abiertas/OCDS.
 * - Por lo tanto NO se pudo confirmar que `api.datos.gob.mx/v2/contratacionesabiertas`
 *   (URL documentada en fuentes de terceros/blueprint) exista o esté vigente.
 * El parser de mapeo (`ocds-mapper.ts`) sí está validado contra el esquema
 * OCDS 1.1 real y público (no específico de México) con un fixture mínimo.
 */
export function createOcdsShcpConnector(config: OcdsShcpConnectorConfig = {}): SourceConnector {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;

  const connector = createOcdsConnector({
    id: "ocds-shcp",
    termsNote:
      "No se pudo leer un robots.txt de api.datos.gob.mx (host inalcanzable en la verificación 2026-09-05). Se aplican de " +
      "cualquier forma los límites generales (REQ-079: ≤1 req/s, User-Agent identificable).",
    liveVerification: {
      verified: false,
      note:
        "2026-09-05: api.datos.gob.mx -> timeout de conexión en múltiples intentos (v2/, v1/, raíz). www.datos.gob.mx -> 200 " +
        "(CKAN real, /api/3/action/package_search funcional, confirmado con consultas reales). Búsquedas CKAN por " +
        "'contrataciones abiertas' (0), 'OCDS' (1, no relacionado), 'EDCA' (0), 'sistema 6'/'PDN' (0 relevantes), y " +
        "organización 'sfp' (11 datasets, ninguno de contrataciones abiertas/OCDS). No se confirmó la existencia ni la URL " +
        "vigente del API OCDS nacional. PENDIENTE VERIFICACIÓN REAL: se requiere que el equipo confirme con SHCP/SABG la " +
        "URL oficial vigente, si la hay.",
    },
    buildListUrl(params: DiscoverParams) {
      // `links.next` de un release package OCDS ya es una URL completa y autocontenida; se usa tal cual si viene de un cursor previo.
      if (params.cursor) return params.cursor;
      const url = new URL(baseUrl);
      if (params.since) url.searchParams.set("publishedFrom", params.since.toISOString());
      return url.toString();
    },
    extractNextCursor(rawJson: unknown) {
      const links = (rawJson as { links?: { next?: string } } | undefined)?.links;
      return links?.next;
    },
  });

  return connector;
}
