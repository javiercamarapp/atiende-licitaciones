import type { ConnectorContext, DiscoverParams, SourceConnector } from "../types.js";
import { assertLegitimateResponseBody } from "../../http/response-classifier.js";
import { mapComprasMxApiRecords } from "./comprasmx-mapper.js";
import { ComprasMxApiResponseSchema } from "./comprasmx-types.js";

export interface ComprasMxConnectorConfig {
  /**
   * Base real descubierta el 2026-09-05 leyendo el bundle público de la SPA
   * de ComprasMX (`sitiopublico/main.*.js`, variable `qr_sitiopublicoMuleUrl`).
   * El endpoint exige cabeceras de reCAPTCHA (`grc`/`igrc`/`xgrc`) que este
   * conector NUNCA intenta rellenar automáticamente (REQ-079: prohibido
   * CAPTCHA-solving). Sin esas cabeceras, la fuente responde
   * `401 {"success":false,"details":"Unauthorized"}` (verificado en vivo).
   */
  baseUrl?: string;
  rowsPerPage?: number;
}

const DEFAULT_BASE_URL = "https://upcp-cnetservicios.buengobierno.gob.mx/whitney/sitiopublico/";

/**
 * Conector a ComprasMX, el SITIO OPERATIVO vigente de la "Plataforma
 * Digital de Contrataciones Públicas" (fundamento legal: LAASSP nueva, DOF
 * 16-abr-2025, Art. 5 fr. XI — ver `docs/legal/verificacion-legal.md`,
 * DECISIONES D-07; sustituye el nombre legal "CompraNet"/"ComprasMX" de la
 * ley anterior, aunque "ComprasMX" sigue siendo la marca real del sitio en
 * producción). Operado por la Secretaría Anticorrupción y Buen Gobierno —
 * SABG, Art. 5 fr. XVII de la misma ley, antes Secretaría de la Función
 * Pública — bajo el dominio `comprasmx.buengobierno.gob.mx`. El `SourceId`
 * técnico se mantiene como `"compras-mx"` (sin cambios, para no romper a
 * `apps/worker`). Ver README §ComprasMX para la evidencia completa de
 * verificación en vivo intentada el 2026-09-05:
 * - El host `comprasmx.buengobierno.gob.mx` responde 200 (SPA Angular real).
 * - Se ubicó el endpoint real `POST {baseUrl}expedientes?rows=&page=` leyendo
 *   el bundle JS público; una petición de solo lectura SIN cabeceras de
 *   reCAPTCHA devolvió `401 Unauthorized` (evidencia capturada, no simulada).
 * - Por política (REQ-079) no se intenta resolver el reCAPTCHA, así que este
 *   conector NO puede verificarse contra una respuesta 200 real por ahora.
 * - Se localizó y descargó un dataset REAL alterno en datos.gob.mx (CKAN):
 *   "contratos_expedientes_sistema_historico_compranet" (SABG, CSV, 2010-2022,
 *   sin reCAPTCHA/auth) vía `parseComprasMxHistoricoCsv`; es historial de
 *   contratos concluidos, no convocatorias abiertas, pero es 100% real y
 *   verificado en vivo (fixture en `test/fixtures/compras-mx/`).
 */
export function createComprasMxConnector(config: ComprasMxConnectorConfig = {}): SourceConnector {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const rowsPerPage = config.rowsPerPage ?? 50;

  return {
    id: "compras-mx",
    termsNote:
      "robots.txt de comprasmx.buengobierno.gob.mx no fue accesible como texto plano en la verificación del 2026-09-05 " +
      "(SPA con protección adicional). El endpoint de datos exige reCAPTCHA v3 (grc/igrc/xgrc); no se intenta eludir. " +
      "Se documenta como fuente 'pendiente de acceso autorizado' hasta que SABG habilite una API/exportación sin CAPTCHA.",
    liveVerification: {
      verified: false,
      note:
        "2026-09-05: GET https://comprasmx.buengobierno.gob.mx/ -> 200 (SPA real, confirma el dominio vigente). " +
        "Se extrajo de sitiopublico/main.*.js la URL real qr_sitiopublicoMuleUrl y el endpoint POST {baseUrl}expedientes. " +
        "POST https://upcp-cnetservicios.buengobierno.gob.mx/whitney/sitiopublico/expedientes?rows=5&page=1 (sin cabeceras " +
        "grc/igrc/xgrc) -> 401 {\"success\":false,\"error\":\"Error\",\"details\":\"Unauthorized\",\"pid\":null} " +
        "(respuesta real capturada). No se intentó resolver reCAPTCHA (prohibido por REQ-079). " +
        "El esquema del parser (`comprasmx-types.ts`) es INFERIDO de los nombres de campo usados en la plantilla Angular " +
        "compilada (codigo_expediente/titulo_expediente/tipo_expediente/tipo_contratacion), no de un payload 200 real. " +
        "PENDIENTE VERIFICACIÓN REAL del `discover()` contra el API de expedientes vigentes.",
    },

    async *discover(params: DiscoverParams, ctx: ConnectorContext) {
      const page = params.cursor ? Number.parseInt(params.cursor, 10) : 1;
      const url = `${baseUrl}expedientes?rows=${rowsPerPage}&page=${page}`;
      const response = await ctx.http.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        throw new Error(
          `ComprasMX respondió ${response.status} en ${url}. Si es 401, revisa README §ComprasMX: ` +
            "el endpoint exige reCAPTCHA y este conector no lo resuelve por política (REQ-079).",
        );
      }
      const bodyText = await response.text();
      // SR-14: ComprasMX está protegido por reCAPTCHA en producción; un 200 con cuerpo de captcha/challenge no
      // debe interpretarse como "0 expedientes nuevos" (ver README, evidencia real del 401/403 documentados).
      assertLegitimateResponseBody(bodyText, { url, expected: "json" });
      const json = JSON.parse(bodyText);
      const parsed = ComprasMxApiResponseSchema.parse(json);
      const rawRecords = parsed.data[0]?.registros ?? [];
      const fetchedAt = ctx.now?.() ?? new Date();
      const { records, dropped } = mapComprasMxApiRecords(rawRecords, { sourceUrl: url, fetchedAt, httpStatus: response.status });
      // SR-21: ningún registro descartado (esquema inválido, identificador/título ausente) desaparece en
      // silencio -- se reenvía al pipeline vía `ctx.reportDropped` para que quede en `errores`/`dropped` y
      // cuente hacia el umbral de tasa de descarte.
      for (const info of dropped) ctx.reportDropped?.(info);

      let yielded = 0;
      for (let i = 0; i < records.length; i += 1) {
        if (params.limit !== undefined && yielded >= params.limit) return;
        const isLast = i === records.length - 1;
        const hasMore = records.length === rowsPerPage;
        yield isLast ? { ...records[i], sourceCursor: hasMore ? String(page + 1) : undefined } : records[i];
        yielded += 1;
      }
    },

    async fetchDetail(externalId: string, ctx: ConnectorContext) {
      const url = `${baseUrl}expedientes/${encodeURIComponent(externalId)}`;
      const response = await ctx.http.request(url);
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`ComprasMX respondió ${response.status} en ${url}`);
      }
      const bodyText = await response.text();
      assertLegitimateResponseBody(bodyText, { url, expected: "json" });
      const json = JSON.parse(bodyText);
      const fetchedAt = ctx.now?.() ?? new Date();
      const { records, dropped } = mapComprasMxApiRecords([json], { sourceUrl: url, fetchedAt, httpStatus: response.status });
      for (const info of dropped) ctx.reportDropped?.(info);
      return records[0] ?? null;
    },
  };
}
