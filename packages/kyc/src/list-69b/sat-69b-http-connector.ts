/**
 * Conector REAL contra la lista 69-B pública del SAT.
 *
 * **Verificación en vivo (2026-09-10)**: se intentó, con red disponible
 * desde este entorno, una petición HTTP real de solo lectura contra la
 * URL de descarga documentada por el propio SAT
 * (`omawww.sat.gob.mx/cifras_sat/Paginas/datos/vinculo.html?page=ListCompleta69B.html`,
 * que hoy redirige a un índice sin enlaces localizables por bot-protection
 * F5/BIG-IP — mismo patrón que PDN Sistema 6, ver `packages/sources`
 * README). La URL de DESCARGA DIRECTA del CSV completo, sin embargo, SÍ
 * responde en vivo sin ninguna protección:
 *
 *   `GET http://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69-B.csv`
 *   → HTTP 200, `Content-Type: application/octet-stream`,
 *     `Content-Length: 4566277`, `Last-Modified: Thu, 22 Jan 2026 22:59:33 GMT`,
 *     sin autenticación ni cabeceras especiales. El cuerpo es el listado
 *     completo real (~14,200 filas a esa fecha: 11,270 Definitivo, 1,638
 *     Sentencia Favorable, 986 Presunto, 340 Desvirtuado), codificado en
 *     Windows-1252 (acentos verificados con `iconv -f WINDOWS-1252`).
 *
 * Esta URL NO aparece documentada en ningún endpoint JSON/API oficial (el
 * SAT no publica una API REST para 69-B) — se localizó por convención de
 * nombre de archivo sobre el dominio de datos abiertos ya conocido del SAT
 * (mismo dominio `omawww.sat.gob.mx` que sirve el resto de "Cifras SAT").
 * **PENDIENTE**: no hay confirmación de que esta URL sea la publicada
 * oficialmente como "estable" a largo plazo por el SAT (podría cambiar sin
 * aviso, igual que cualquier archivo estático); si deja de responder 200,
 * `discover()`/`fetchSnapshot()` lo reportará como una `HttpError`/
 * `InterfaceChangedError` real, nunca como una lista vacía silenciosa.
 *
 * Cadencia real de actualización del SAT: la propia leyenda del CSV
 * ("Información actualizada al ...") es la única fuente confiable de
 * frescura — el CFF Art. 69-B obliga publicación en el DOF, pero el
 * archivo CSV se actualiza en una cadencia operativa del SAT no
 * documentada públicamente como SLA. `listAsOfDate` (ver
 * `parse-sat-69b-csv.ts`) es lo que este sistema usa para la alerta de
 * "lista desactualizada" (REQ-026), NUNCA `fetchedAt`.
 */
import { decodeHttpResponseText, sha256Hex, assertLegitimateResponseBody, type HttpClient } from "@atiende/sources";
import { parseSat69BCsvText } from "./parse-sat-69b-csv.js";
import type { LiveVerification, NegativeListConnector, NegativeListFetchContext, NegativeListSnapshot } from "../types.js";

export const SAT_69B_DEFAULT_URL = "http://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69-B.csv";

export interface Sat69BHttpConnectorConfig {
  http: HttpClient;
  sourceUrl?: string;
}

export const SAT_69B_LIVE_VERIFICATION: LiveVerification = {
  verified: true,
  note:
    "Verificado en vivo 2026-09-10: GET http://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69-B.csv " +
    "-> HTTP 200 real, sin autenticación, ~4.5MB, ~14,200 filas (11,270 Definitivo). Encoding Windows-1252 " +
    "confirmado por inspección de bytes. Ver JSDoc de este archivo para el detalle completo.",
};

/**
 * Adaptador real (borde externo): descarga el CSV completo vía `http` y lo
 * parsea con `parseSat69BCsvText` (lógica de negocio pura, testeada aparte
 * contra el fixture real en `test/fixtures/sat-69b/`). Nunca fabrica ni
 * completa datos que el CSV no traiga.
 */
export function createSat69BHttpConnector(config: Sat69BHttpConnectorConfig): NegativeListConnector {
  const sourceUrl = config.sourceUrl ?? SAT_69B_DEFAULT_URL;

  return {
    listId: "sat_69b",
    liveVerification: SAT_69B_LIVE_VERIFICATION,
    async fetchSnapshot(ctx?: NegativeListFetchContext): Promise<NegativeListSnapshot> {
      const now = ctx?.now ?? (() => new Date());
      const response = await config.http.request(sourceUrl, { method: "GET" });
      const rawText = await decodeHttpResponseText(response);
      // El SAT sirve este archivo como `application/octet-stream` (no
      // `text/csv`): `assertLegitimateResponseBody` no puede confiar en el
      // Content-Type, así que se valida el CUERPO -- si algún día el
      // dominio empieza a devolver un interstitial/bloqueo HTML en vez del
      // CSV real, esto lo detecta como `InterfaceChangedError`/
      // `CaptchaDetectedError` en vez de intentar "parsear" HTML como CSV.
      assertLegitimateResponseBody(rawText, { url: sourceUrl, expected: "csv" });

      const parsed = parseSat69BCsvText(rawText);

      return {
        listId: "sat_69b",
        sourceUrl,
        fetchedAt: now(),
        listAsOfDate: parsed.listAsOfDate,
        listAsOfRaw: parsed.listAsOfRaw,
        listAsOfParseError: parsed.listAsOfParseError,
        entries: parsed.entries,
        rawHash: sha256Hex(rawText),
      };
    },
  };
}
