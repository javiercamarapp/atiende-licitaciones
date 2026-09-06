import type { DiscoverParams, SourceConnector } from "../types.js";
import { createOcdsConnector } from "../ocds/create-ocds-connector.js";

export interface PdnS6ConnectorConfig {
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://api.plataformadigitalnacional.org/s6/contrataciones";

/**
 * Conector al Sistema 6 (Información de Contrataciones Públicas) de la
 * Plataforma Digital Nacional del Sistema Nacional Anticorrupción, en
 * formato OCDS/EDCA (REQ-133). Evidencia real de verificación 2026-09-05
 * (ver README §PDN-S6):
 * - `https://plataformadigitalnacional.org/` responde 200 pero es una
 *   redirección forzada por JavaScript (Zenedge, protección anti-bot) hacia
 *   `www.plataformadigitalnacional.org`; no se pudo leer contenido real sin
 *   ejecutar JS.
 * - `https://api.plataformadigitalnacional.org/` responde 200 pero sirve la
 *   página de bienvenida por defecto de nginx ("Welcome to nginx!"), es
 *   decir, NO hay una API pública desplegada en ese subdominio hoy (o no es
 *   la ruta correcta).
 * - No se encontró ninguna ruta `/s6/...` que devolviera JSON en los
 *   intentos realizados (404 en `s6/contratacionesabiertas`).
 * El parser (`ocds-mapper.ts`) reutiliza el mismo mapeo OCDS 1.1 validado
 * que `OcdsShcpConnector`. PENDIENTE VERIFICACIÓN REAL de la URL/API vigente
 * del Sistema 6; requiere confirmación del equipo con la Secretaría
 * Ejecutiva del SNA.
 */
export function createPdnS6Connector(config: PdnS6ConnectorConfig = {}): SourceConnector {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;

  return createOcdsConnector({
    id: "pdn-s6",
    termsNote:
      "No se pudo confirmar la existencia de robots.txt de la API real (subdominio sirve nginx por defecto). Se aplican " +
      "los límites generales (REQ-079).",
    liveVerification: {
      verified: false,
      note:
        "2026-09-05: https://plataformadigitalnacional.org/ -> 200 con redirección JS (Zenedge) a www.plataformadigitalnacional.org, " +
        "no explorable sin ejecutar JS desde este entorno. https://api.plataformadigitalnacional.org/ -> 200, página por " +
        "defecto de nginx (sin API desplegada visible). https://api.plataformadigitalnacional.org/s6/contratacionesabiertas " +
        "-> 404. PENDIENTE VERIFICACIÓN REAL: no se confirmó URL/API vigente del Sistema 6.",
    },
    buildListUrl(params: DiscoverParams) {
      if (params.cursor) return params.cursor;
      const url = new URL(baseUrl);
      if (params.since) url.searchParams.set("date_from", params.since.toISOString().slice(0, 10));
      return url.toString();
    },
    extractNextCursor(rawJson: unknown) {
      const links = (rawJson as { links?: { next?: string } } | undefined)?.links;
      return links?.next;
    },
  });
}
