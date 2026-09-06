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
 * 2. Un BOM UTF-16LE/BE o UTF-8 explícito al inicio de los bytes (se recorta
 *    antes de decodificar, para que la primera columna de un CSV con BOM no
 *    quede con el BOM pegado al nombre del encabezado).
 * 3. SR-22 (ronda 3 de corrección): sin BOM, una heurística por bytes NUL
 *    alternos detecta UTF-16LE/BE -- ver `detectUtf16Endianness()`.
 * 4. Si nada de lo anterior aplica: heurística por CONTENIDO -- se intenta
 *    una decodificación UTF-8 ESTRICTA (`fatal: true`); si los bytes NO son
 *    UTF-8 válido (lanza), se asume Latin-1/Windows-1252 (el encoding de un
 *    byte más común en datasets legados mexicanos) vía
 *    `TextDecoder("latin1")`, que nunca lanza (todo byte 0-255 es un
 *    carácter Latin-1 válido).
 *
 * **SR-22 (residual de la ronda 2 de corrección)**: antes de esta ronda,
 * UTF-16LE/BE (con o sin BOM) no se detectaba: cada byte ASCII de un
 * carácter UTF-16LE es, por sí solo, un byte UTF-8 válido (`0x00`-`0x7F`),
 * así que la heurística "UTF-8 estricto inválido -> Latin-1" NUNCA se
 * activaba para este caso -- el resultado era mojibake con bytes NUL
 * intercalados, sin ninguna excepción. "Guardar como texto Unicode" en
 * Excel/Windows produce exactamente este formato, una operación común al
 * manipular datasets legados mexicanos en herramientas de oficina.
 */

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2];
}

function hasUtf16LeBom(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === UTF16LE_BOM[0] && bytes[1] === UTF16LE_BOM[1];
}

function hasUtf16BeBom(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === UTF16BE_BOM[0] && bytes[1] === UTF16BE_BOM[1];
}

/**
 * `TextDecoder` (spec WHATWG Encoding Standard) NO reconoce ninguna etiqueta
 * "utf-16be": solo "utf-16le"/"utf-16" decodifican little-endian. Para
 * decodificar big-endian se intercambian los bytes de cada pareja y se
 * decodifica el resultado como little-endian.
 */
function swapUtf16ByteOrder(bytes: Uint8Array): Uint8Array {
  const evenLength = bytes.length - (bytes.length % 2);
  const out = new Uint8Array(evenLength);
  for (let i = 0; i < evenLength; i += 2) {
    out[i] = bytes[i + 1];
    out[i + 1] = bytes[i];
  }
  return out;
}

/**
 * Heurística de contenido (sin BOM) para detectar UTF-16LE/BE: texto ASCII
 * (el caso más común en datasets legados) codificado como UTF-16 tiene, en
 * cada pareja de bytes, un byte en 0 (el byte alto/bajo según el orden) y
 * otro con el código ASCII real. Se exige una proporción alta y consistente
 * sobre una muestra para evitar falsos positivos con contenido binario u
 * ocasional byte NUL suelto.
 */
function detectUtf16Endianness(bytes: Uint8Array): "le" | "be" | undefined {
  const sampleLen = Math.min(bytes.length - (bytes.length % 2), 512);
  if (sampleLen < 8) return undefined;
  const pairs = sampleLen / 2;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < sampleLen; i += 2) {
    if (bytes[i] === 0) evenZero += 1;
    if (bytes[i + 1] === 0) oddZero += 1;
  }
  const evenZeroRatio = evenZero / pairs;
  const oddZeroRatio = oddZero / pairs;
  // UTF-16LE de texto ASCII: el byte ALTO (segundo de cada pareja) es 0x00 casi siempre; el bajo casi nunca.
  if (oddZeroRatio > 0.7 && evenZeroRatio < 0.1) return "le";
  // UTF-16BE: el patrón se invierte (byte alto primero).
  if (evenZeroRatio > 0.7 && oddZeroRatio < 0.1) return "be";
  return undefined;
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

  // SR-22: BOM UTF-16 explícito, ANTES de mirar el BOM UTF-8 (bytes distintos, sin ambigüedad posible).
  if (hasUtf16LeBom(bytes)) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (hasUtf16BeBom(bytes)) {
    return new TextDecoder("utf-16le").decode(swapUtf16ByteOrder(bytes.subarray(2)));
  }

  const body = hasUtf8Bom(bytes) ? bytes.subarray(3) : bytes;

  // SR-22: sin BOM, heurística de contenido (bytes NUL alternos) antes de la heurística UTF-8/Latin-1 -- un texto
  // ASCII en UTF-16LE/BE es, byte a byte, UTF-8 estricto VÁLIDO (cada 0x00/ASCII es un carácter UTF-8 de 1 byte
  // legítimo), así que la heurística de abajo NUNCA se activaría para este caso sin este chequeo previo.
  const endianness = detectUtf16Endianness(body);
  if (endianness === "le") return new TextDecoder("utf-16le").decode(body);
  if (endianness === "be") return new TextDecoder("utf-16le").decode(swapUtf16ByteOrder(body));

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

/**
 * Recorta hasta 3 bytes finales de una muestra si son el INICIO de una
 * secuencia UTF-8 multibyte incompleta (el corte cayó a media secuencia),
 * para no confundir un límite de chunk de streaming con UTF-8 realmente
 * inválido -- sirve solo para decidir el encoding UNA VEZ a partir del
 * primer chunk (`sniffStreamEncoding`), nunca para decodificar el contenido
 * real (eso lo hace `TextDecoder` con `stream: true`, que sí maneja
 * secuencias partidas entre llamadas por spec).
 */
function trimIncompleteTrailingUtf8Sequence(bytes: Uint8Array): Uint8Array {
  for (let back = 1; back <= 3 && back <= bytes.length; back += 1) {
    const b = bytes[bytes.length - back];
    if ((b & 0b11000000) === 0b10000000) continue; // byte de continuación: seguir revisando hacia atrás
    if ((b & 0b10000000) === 0) return bytes; // ASCII: la secuencia en el borde ya está completa
    let neededLen = 0;
    if ((b & 0b11100000) === 0b11000000) neededLen = 2;
    else if ((b & 0b11110000) === 0b11100000) neededLen = 3;
    else if ((b & 0b11111000) === 0b11110000) neededLen = 4;
    else return bytes; // byte líder inválido de cualquier forma: no es un problema de corte de chunk
    return neededLen > back ? bytes.subarray(0, bytes.length - back) : bytes;
  }
  return bytes;
}

interface StreamEncodingDecision {
  /** Etiqueta pasada a `new TextDecoder(label)`. */
  label: string;
  /** true solo para UTF-16BE: `TextDecoder` no tiene una etiqueta big-endian, así que cada chunk se intercambia por pares de bytes antes de decodificar como `utf-16le`. */
  swapBytes: boolean;
  /** Bytes de BOM a recortar del PRIMER chunk antes de decodificar. */
  skipBytes: number;
}

/**
 * Decide el encoding UNA VEZ a partir del charset declarado y/o el PRIMER
 * chunk de bytes (BOM / heurística UTF-16 / heurística UTF-8-vs-Latin-1,
 * mismas reglas que `decodeBestEffort`). Limitación aceptada y documentada
 * (SR-22, alcance del parser en streaming): la heurística de contenido
 * corre solo sobre el primer chunk recibido (hasta 64 KiB), no sobre el
 * archivo completo -- suficiente en la práctica porque el encoding real no
 * cambia a mitad de un mismo archivo/respuesta.
 */
function sniffStreamEncoding(firstChunk: Uint8Array, declaredCharset?: string | null): StreamEncodingDecision {
  if (declaredCharset && !/^utf-?8$/i.test(declaredCharset)) {
    try {
      // Solo valida que el label sea soportado (lanza si no) antes de comprometernos a él para todo el stream.
      void new TextDecoder(declaredCharset);
      return { label: declaredCharset, swapBytes: false, skipBytes: 0 };
    } catch {
      // Charset declarado pero no reconocido: se sigue con la heurística de contenido, igual que `decodeBestEffort`.
    }
  }
  if (hasUtf16LeBom(firstChunk)) return { label: "utf-16le", swapBytes: false, skipBytes: 2 };
  if (hasUtf16BeBom(firstChunk)) return { label: "utf-16le", swapBytes: true, skipBytes: 2 };
  if (hasUtf8Bom(firstChunk)) return { label: "utf-8", swapBytes: false, skipBytes: 3 };

  const sample = trimIncompleteTrailingUtf8Sequence(firstChunk.subarray(0, Math.min(firstChunk.length, 65536)));
  const endianness = detectUtf16Endianness(sample);
  if (endianness === "le") return { label: "utf-16le", swapBytes: false, skipBytes: 0 };
  if (endianness === "be") return { label: "utf-16le", swapBytes: true, skipBytes: 0 };

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return { label: "utf-8", swapBytes: false, skipBytes: 0 };
  } catch {
    return { label: "latin1", swapBytes: false, skipBytes: 0 };
  }
}

/**
 * Decodifica un flujo de bytes crudos (p.ej. `response.body`) a texto SIN
 * concatenar nunca el cuerpo completo en memoria -- a diferencia de
 * `decodeHttpResponseText`/`response.text()`, que bufferean TODO antes de
 * devolver una sola cadena. El encoding se decide UNA VEZ (ver
 * `sniffStreamEncoding`) a partir del charset declarado y/o el primer
 * chunk; el resto de los chunks se decodifican con la MISMA instancia de
 * `TextDecoder` en modo `stream: true` (spec WHATWG), que bufferea
 * internamente cualquier secuencia multibyte partida entre llamadas -- así
 * que un carácter dividido exactamente en la frontera de dos chunks nunca
 * se corrompe. Pieza base de `ComprasMxHistoricalCsvConnector.discover()`
 * para mantener memoria acotada frente al archivo REAL (~951 MB, ver
 * README).
 */
export async function* decodeByteChunksStream(chunks: AsyncIterable<Uint8Array>, declaredCharset?: string | null): AsyncGenerator<string> {
  let decision: StreamEncodingDecision | undefined;
  let decoder: InstanceType<typeof TextDecoder> | undefined;
  let carryByte: Uint8Array | undefined;

  for await (const rawChunk of chunks) {
    let chunk = rawChunk;
    if (!decision) {
      decision = sniffStreamEncoding(chunk, declaredCharset);
      decoder = new TextDecoder(decision.label, { fatal: false });
      if (decision.skipBytes > 0) chunk = chunk.subarray(decision.skipBytes);
    }

    if (decision.swapBytes) {
      let toSwap = chunk;
      if (carryByte && carryByte.length > 0) {
        const merged = new Uint8Array(carryByte.length + chunk.length);
        merged.set(carryByte, 0);
        merged.set(chunk, carryByte.length);
        toSwap = merged;
        carryByte = undefined;
      }
      if (toSwap.length % 2 !== 0) {
        carryByte = toSwap.subarray(toSwap.length - 1);
        toSwap = toSwap.subarray(0, toSwap.length - 1);
      }
      chunk = swapUtf16ByteOrder(toSwap);
    }

    if (chunk.length > 0) {
      const text = decoder!.decode(chunk, { stream: true });
      if (text) yield text;
    }
  }

  if (decoder) {
    const tail = decoder.decode();
    if (tail) yield tail;
  }
}
