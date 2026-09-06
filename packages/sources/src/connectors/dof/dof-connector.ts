import type { ConnectorContext, DiscoverParams, SourceConnector } from "../types.js";
import { SourceNotConfiguredError } from "../types.js";
import { assertLegitimateResponseBody } from "../../http/response-classifier.js";
import { extractDofNoticesFromText, mapDofNoticeToTenderRecord, mapDofNoticeToTenderRecordSafe } from "./dof-mapper.js";

export interface DofConnectorConfig {
  baseUrl?: string;
  /** Códigos de nota a consultar en esta corrida (en un crawler real vendrían del índice diario `index.php?year=&month=&day=`). */
  noteCodes?: string[];
}

const DEFAULT_BASE_URL = "https://dof.gob.mx";

/**
 * Marcadores SEMÁNTICOS de una nota REAL del DOF con convocatorias (SR-23,
 * residual de SR-20 -- ver `docs/auditoria-1/sources-cierre-final.md`): a
 * diferencia de los marcadores de PLANTILLA fijos que usaba la ronda
 * anterior (título exacto "DOF - Diario Oficial de la Federación", `id`
 * "DivDetalleNota"), estos patrones describen el CONTENIDO que una nota real
 * con convocatorias trae -- la palabra "convocatoria"/"licitación pública",
 * o el patrón de número de procedimiento mexicano
 * (`LA-050GYN003-E1-2026`/`LO-016B00003-E22-2026`, visto en los fixtures
 * reales de DOF/SHCP: prefijo de 2 letras, guion, clave de dependencia,
 * guion, expediente, guion, año). Una nota con una plantilla HTML distinta
 * (año de rediseño del sitio, sub-plantilla distinta) pero contenido real
 * sigue pasando -- ya no depende de que el título/id coincidan byte a byte
 * con la muestra usada para construir el marcador. Se pasan a
 * `assertLegitimateResponseBody` junto con `detectInterstitialShellMarker`
 * (interno) para que ni un login genérico/vendor sin marcador de captcha
 * reconocido NI un interstitial que preserva el título/id del sitio real
 * (confirmado como vector real por la reverificación de cierre) pasen
 * silenciosamente solo por tener forma de HTML.
 */
const DOF_SEMANTIC_CONTENT_MARKERS: ReadonlyArray<RegExp> = [
  /convocatoria/i,
  /licitaci[oó]n\s+p[uú]blica/i,
  /\b(?:LA|IA|IO|LO)-[0-9A-Z]{3,}-[A-Z0-9]{2,}-\d{4}\b/,
];

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&aacute;/gi, "á")
    .replace(/&eacute;/gi, "é")
    .replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó")
    .replace(/&uacute;/gi, "ú")
    .replace(/&ntilde;/gi, "ñ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Conector al Diario Oficial de la Federación (verificación de cruce de
 * convocatorias y plazos legales, REQ-134). Evidencia real capturada
 * 2026-09-05 (ver README §DOF): `https://dof.gob.mx/` responde 200; el
 * sitio usa `nota_detalle.php?codigo=&fecha=DD/MM/YYYY` para notas
 * individuales y `index.php?year=&month=&day=` para el sumario diario; NO
 * se encontró API JSON/CSV. `busqueda_avanzada.php` redirige a
 * `sidof.segob.gob.mx` (buscador SIDOF, formulario POST con campos
 * `BUSCAR_EN`/`FechaInicio`/`FechaHasta`/`TIPO_TEXTO`), tampoco expone una
 * API pública documentada dentro de la ventana de verificación. El parser
 * de convocatorias corre sobre un fixture reconstruido a partir del formato
 * públicamente conocido de "Sección de Avisos"; no se confirmó en vivo una
 * nota con convocatorias dentro de las fechas muestreadas — PENDIENTE
 * VERIFICACIÓN REAL.
 */
export function createDofConnector(config: DofConnectorConfig = {}): SourceConnector {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;

  return {
    id: "dof",
    termsNote:
      "dof.gob.mx no publica robots.txt con reglas restrictivas conocidas en la verificación 2026-09-05; se aplica de " +
      "cualquier forma el límite general de 1 req/s y User-Agent identificable (REQ-079). Solo lectura de notas públicas.",
    liveVerification: {
      verified: false,
      note:
        "2026-09-05: GET https://dof.gob.mx/ -> 200. GET https://dof.gob.mx/nota_detalle.php?codigo=5797937&fecha=04/09/2026 " +
        "-> 200 (716478 bytes, nota real de un DECRETO, sin convocatorias). GET https://dof.gob.mx/index.php?year=2026&month=09&day=04 " +
        "-> 200 (sumario diario, 5 códigos de nota encontrados, 0 menciones de 'convocatoria'/'licitación' en esa muestra). " +
        "GET https://dof.gob.mx/busqueda_avanzada.php -> 302 a https://sidof.segob.gob.mx/busquedaAvanzada/busqueda (buscador " +
        "SIDOF con formulario POST, no explorado más a fondo). No se localizó una nota real con convocatorias de licitación " +
        "dentro de la ventana de prueba; el parser (`extractDofNoticesFromText`) corre sobre fixture. " +
        "PENDIENTE VERIFICACIÓN REAL contra una nota con convocatorias confirmadas.",
    },

    async *discover(params: DiscoverParams, ctx: ConnectorContext) {
      const codes = config.noteCodes ?? [];
      if (codes.length === 0) {
        // SR-03: sin códigos configurados este conector NUNCA toca la red (el `for` de abajo
        // iteraría sobre un arreglo vacío); reportar "ok"/"0 nuevas" sería indistinguible de una
        // corrida real sin novedades (antipatrón que REQ-148 prohíbe explícitamente). El índice
        // diario (`index.php?year=&month=&day=`) que alimentaría `noteCodes` automáticamente NO
        // está implementado en este paquete (ver README §DOF): ese cableado es responsabilidad de
        // un consumidor externo (apps/api/worker).
        throw new SourceNotConfiguredError(
          "dof: no se configuraron noteCodes (config.noteCodes vacío); no se realizó ninguna petición HTTP a la fuente. " +
            "Esta corrida NO debe interpretarse como 'sin novedades' (REQ-148).",
        );
      }
      let yielded = 0;
      for (const codigo of codes) {
        if (params.limit !== undefined && yielded >= params.limit) return;
        const url = `${baseUrl}/nota_detalle.php?codigo=${encodeURIComponent(codigo)}`;
        const response = await ctx.http.request(url);
        if (!response.ok) {
          throw new Error(`DOF respondió ${response.status} en ${url}`);
        }
        const html = await response.text();
        // SR-14/SR-23: un 200 real puede traer un cuerpo de captcha/bot-challenge de un vendor conocido (el propio
        // README lo documenta como real para PDN-S6/Zenedge), o un interstitial genérico que preserva el cascarón
        // HTML del sitio real (confirmado como vector real por la reverificación de cierre); sin esta validación,
        // `extractDofNoticesFromText` simplemente no encontraría avisos y la corrida se reportaría como "ok"/"0
        // nuevas" -- indistinguible de una corrida real sin novedades.
        assertLegitimateResponseBody(html, { url, expected: "text", semanticContentMarkers: DOF_SEMANTIC_CONTENT_MARKERS });
        const text = stripHtml(html);
        const fechaMatch = html.match(/fecha=(\d{2}\/\d{2}\/\d{4})/);
        const fecha = fechaMatch?.[1] ?? "";
        const { notices, dropped } = extractDofNoticesFromText(text, codigo, fecha);
        // SR-24 (residual de SR-21, generalizado a DOF): ningún bloque/aviso descartado desaparece en silencio --
        // se reenvía a `ctx.reportDropped` para que cuente hacia `errores`/`dropped` y el umbral de tasa de descarte.
        for (const info of dropped) ctx.reportDropped?.(info);
        const fetchedAt = ctx.now?.() ?? new Date();
        for (const notice of notices) {
          if (params.limit !== undefined && yielded >= params.limit) return;
          const mapped = mapDofNoticeToTenderRecordSafe(notice, html, { sourceUrl: url, fetchedAt, httpStatus: response.status });
          if ("dropped" in mapped) {
            ctx.reportDropped?.(mapped.dropped);
            continue;
          }
          yield mapped.record;
          yielded += 1;
        }
      }
    },

    async fetchDetail(externalId: string, ctx: ConnectorContext) {
      const [codigo] = externalId.split(":");
      const url = `${baseUrl}/nota_detalle.php?codigo=${encodeURIComponent(codigo)}`;
      const response = await ctx.http.request(url);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`DOF respondió ${response.status} en ${url}`);
      const html = await response.text();
      assertLegitimateResponseBody(html, { url, expected: "text", semanticContentMarkers: DOF_SEMANTIC_CONTENT_MARKERS });
      const text = stripHtml(html);
      const fechaMatch = html.match(/fecha=(\d{2}\/\d{2}\/\d{4})/);
      const fecha = fechaMatch?.[1] ?? "";
      const { notices } = extractDofNoticesFromText(text, codigo, fecha);
      const fetchedAt = ctx.now?.() ?? new Date();
      const match = notices.find((n) => `${n.codigo}:${n.numeroConvocatoria ?? n.titulo.slice(0, 40)}` === externalId);
      if (!match) return null;
      return mapDofNoticeToTenderRecord(match, html, { sourceUrl: url, fetchedAt, httpStatus: response.status });
    },
  };
}
