/**
 * Decodificación de bytes de respuesta HTTP tolerante a encodings distintos
 * de UTF-8 (SR-15). `Response.text()` del WHATWG fetch spec decodifica
 * SIEMPRE como UTF-8, sin importar el charset real declarado/usado por el
 * servidor -- si un CSV real viene en Latin-1/Windows-1252 (común en
 * exports legados de gobierno mexicanos), los acentos se corrompen
 * SILENCIOSAMENTE (mojibake), sin ninguna excepción. Este módulo decodifica
 * a partir de los bytes crudos (`ArrayBuffer`), aplicando:
 *
 * 1. El charset DECLARADO por el servidor (`Content-Type: ...; charset=...`),
 *    si trae uno reconocible y distinto de UTF-8.
 * 2. Un BOM UTF-8 explícito al inicio de los bytes (se recorta antes de
 *    decodificar, para que la primera columna de un CSV con BOM no quede
 *    con el BOM pegado al nombre del encabezado).
 * 3. Si nada de lo anterior aplica: heurística por CONTENIDO -- se intenta
 *    una decodificación UTF-8 ESTRICTA (`fatal: true`); si los bytes NO son
 *    UTF-8 válido (lanza), se asume Latin-1/Windows-1252 (el encoding de un
 *    byte más común en datasets legados mexicanos) vía
 *    `TextDecoder("latin1")`, que nunca lanza (todo byte 0-255 es un
 *    carácter Latin-1 válido).
 */

const UTF8_BOM = [0xef, 0xbb, 0xbf];

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2];
}

/** Extrae el `charset` de una cabecera `Content-Type`, o `undefined` si no declara ninguno. */
export function extractCharset(contentType: string | null | undefined): string | undefined {
  if (!contentType) return undefined;
  const match = contentType.match(/charset\s*=\s*("?)([^;"]+)\1/i);
  return match?.[2]?.trim();
}

/**
 * Decodifica bytes crudos a texto, aplicando el charset declarado (si lo
 * hay y es soportado), BOM UTF-8 explícito, y en último caso la heurística
 * de "UTF-8 inválido -> Latin-1" descrita arriba.
 */
export function decodeBestEffort(bytes: Uint8Array, declaredCharset?: string | null): string {
  if (declaredCharset && !/^utf-?8$/i.test(declaredCharset)) {
    try {
      return new TextDecoder(declaredCharset).decode(bytes);
    } catch {
      // Charset declarado pero no reconocido por `TextDecoder` (typo, alias poco común, etc.): se sigue con la
      // heurística de contenido en vez de fallar la corrida completa por una cabecera mal formada.
    }
  }

  const body = hasUtf8Bom(bytes) ? bytes.subarray(3) : bytes;

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    // SR-15: secuencia de bytes inválida bajo UTF-8 estricto -> se asume Latin-1/Windows-1252 (nunca lanza: todo
    // byte 0-255 es un carácter Latin-1 válido). Evita el mojibake SILENCIOSO que producía `Response.text()`.
    return new TextDecoder("latin1").decode(body);
  }
}

/** Lee el cuerpo de una `Response` como texto, decodificando por bytes crudos (ver `decodeBestEffort`) en vez de asumir siempre UTF-8. */
export async function decodeHttpResponseText(response: Response): Promise<string> {
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const declaredCharset = extractCharset(response.headers.get("content-type"));
  return decodeBestEffort(bytes, declaredCharset);
}
