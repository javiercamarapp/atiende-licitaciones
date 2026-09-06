import { z } from "zod";

/**
 * NoFabricationPolicy (docs/AMPLIACION-BACKOFFICE.md §6): cualquier valor de
 * precio, certificación, experiencia, referencia, firma o vigencia que use
 * una herramienta debe venir de una fuente aprobada referenciada
 * (`approvedSourceRef`). Si falta la fuente (o el valor), el resultado debe
 * ser "pendiente/no evaluable" con la lista exacta de datos faltantes —
 * nunca un valor inventado por el LLM.
 *
 * Esto complementa (no reemplaza) el guardrail `no_unsourced_claims` de
 * REQ-027/REQ-085: aquella regla es sobre `Claim`s de texto libre citando
 * evidencia; esta regla es sobre valores estructurados (número, fecha,
 * identificador) que una herramienta necesita para producir un artefacto
 * (precio de propuesta, vigencia de un documento, etc.).
 */

export type SensitiveFieldKind =
  | "precio"
  | "certificacion"
  | "experiencia"
  | "referencia"
  | "firma"
  | "vigencia";

export const SENSITIVE_FIELD_KINDS: readonly SensitiveFieldKind[] = [
  "precio",
  "certificacion",
  "experiencia",
  "referencia",
  "firma",
  "vigencia",
];

export interface ApprovedSourceRef {
  /** Identificador del documento/registro aprobado de origen (bóveda, catálogo interno, etc.). */
  docId: string;
  page?: number;
  /** Momento en que se capturó/confirmó el dato desde la fuente. */
  capturedAt: string;
}

export const approvedSourceRefSchema: z.ZodType<ApprovedSourceRef> = z.object({
  docId: z.string().min(1),
  page: z.number().int().positive().optional(),
  capturedAt: z.string().min(1),
});

export interface SourcedValue<T = unknown> {
  kind: SensitiveFieldKind;
  fieldName: string;
  value: T | null | undefined;
  approvedSourceRef: ApprovedSourceRef | null | undefined;
}

/** Esquema zod reutilizable para que una herramienta declare un campo sensible "abastecido". */
export function sourcedValueSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.object({
    value: valueSchema.nullable(),
    approvedSourceRef: approvedSourceRefSchema.nullable(),
  });
}

export type NoFabricationEvaluation =
  | { status: "evaluable"; values: Record<string, unknown> }
  | { status: "pendiente_no_evaluable"; missing: string[] };

export class NoFabricationPolicy {
  /**
   * Evalúa una lista de valores sensibles. Si a cualquiera le falta el
   * valor o la referencia de fuente aprobada, el resultado completo es
   * `pendiente_no_evaluable` con la lista de nombres de campo faltantes
   * (nunca se completa parcialmente con valores inventados).
   */
  evaluate(values: SourcedValue[]): NoFabricationEvaluation {
    const missing = values
      .filter((v) => v.value === null || v.value === undefined || !v.approvedSourceRef)
      .map((v) => v.fieldName);

    if (missing.length > 0) {
      return { status: "pendiente_no_evaluable", missing };
    }

    const result: Record<string, unknown> = {};
    for (const v of values) result[v.fieldName] = v.value;
    return { status: "evaluable", values: result };
  }

  /** Azúcar sintáctica para validar un único campo sensible. */
  evaluateOne(value: SourcedValue): NoFabricationEvaluation {
    return this.evaluate([value]);
  }
}

/**
 * AG-10 (REQ-164, "tolerancia cero" leída de forma literal): escaneo
 * RECURSIVO obligatorio del `output` completo de cualquier herramienta —
 * ya NO depende de que la herramienta declare `extractSensitiveValues`.
 * Antes, un valor sensible bajo un nombre de campo distinto (`costo` en vez
 * de `precioUnitario`), anidado en un array, simplemente nunca se
 * evaluaba y la corrida terminaba `completed`. Ahora `AgentRunner` corre
 * este escaneo SIEMPRE, además de (no en vez de) la verificación explícita
 * por `extractSensitiveValues` cuando la herramienta la declara.
 *
 * No hay opción de "opt-out": no existe ningún flag en `ToolDefinition`
 * para desactivar este escaneo para categorías sensibles.
 */

/** Diccionario de sinónimos de nombre de campo por categoría sensible. */
const SENSITIVE_KEY_SYNONYMS: Record<SensitiveFieldKind, readonly string[]> = {
  precio: ["precio", "price", "importe", "costo", "cost", "monto", "amount", "tarifa", "fee", "total", "preciounitario"],
  certificacion: ["certificacion", "certification", "certificado", "certificate", "iso", "acreditacion"],
  experiencia: ["experiencia", "experience", "aniosexperiencia", "yearsexperience"],
  referencia: ["referencia", "reference", "referenciacomercial", "clientereferencia"],
  firma: ["firma", "signature", "firmante", "signer", "representantelegal"],
  vigencia: [
    "vigencia",
    "vigente",
    "vigentehasta",
    "validuntil",
    "expirationdate",
    "expiresat",
    "fechavigencia",
    "validity",
    "fechavencimiento",
  ],
};

/** Palabras clave (mismo vocabulario que SENSITIVE_KEY_SYNONYMS) para detectar texto libre sospechoso. */
const SENSITIVE_TEXT_KEYWORDS: readonly string[] = Array.from(
  new Set(Object.values(SENSITIVE_KEY_SYNONYMS).flat().concat(["precio", "vigente", "costo", "firmado"])),
);

/** Números con formato de dinero, o fechas ISO / dd-mm-aaaa, dentro de una cadena de texto libre. */
const NUMBER_OR_DATE_IN_TEXT = /(\$\s?\d[\d,.]*\d?|\b\d+([.,]\d+)?\s?(usd|mxn|pesos)\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b)/i;

/**
 * AG-21 (MEDIA, cierre de bypass de AG-19): tamaño de cada VENTANA de
 * decodificación UTF-8 de un `Buffer`/`TypedArray`. A diferencia del diseño
 * original de AG-19 (un único `subarray(0, MAX_BINARY_DECODE_BYTES)` que
 * descartaba silenciosamente todo lo que empezara después del byte 8192),
 * ahora se decodifica el `Buffer` COMPLETO en ventanas de este tamaño — ver
 * `decodeBinaryWindows` — hasta el límite total configurable
 * `DEFAULT_MAX_BINARY_TOTAL_BYTES`.
 */
const BINARY_SCAN_WINDOW_BYTES = 8192;

/**
 * AG-21: solape entre ventanas consecutivas, para no perder un patrón
 * (JSON embebido o texto libre sospechoso) que caiga justo en el borde de
 * una ventana — un valor colocado a caballo entre dos ventanas queda
 * completo dentro de la ventana siguiente mientras su longitud no supere
 * este solape.
 */
const BINARY_SCAN_WINDOW_OVERLAP_BYTES = 512;

/**
 * AG-21: límite defensivo de tamaño TOTAL de un `Buffer`/`TypedArray` que
 * se acepta escanear completo (en ventanas). Es configurable vía el
 * segundo argumento de `scanForUnsourcedSensitiveData`. Un binario más
 * grande que esto (imagen/PDF real de varios MB) ya no es plausible que
 * sea un JSON/texto pequeño embebido, y decodificarlo completo en ventanas
 * sería costoso sin beneficio real de detección. A diferencia del
 * comportamiento anterior (truncar en silencio y dejar pasar la corrida
 * como si no hubiera nada sensible), superar este límite produce un
 * hallazgo explícito `kind: "no_evaluable"` — la corrida se detiene como
 * `needs_data` en vez de completarse sin haber podido verificar el
 * contenido. Ver README, sección "Límite conocido (AG-19/AG-21)".
 */
const DEFAULT_MAX_BINARY_TOTAL_BYTES = 5 * 1024 * 1024; // 5 MiB

/**
 * AG-21: longitud mínima para siquiera considerar un string como candidato
 * base64 — evita marcar strings cortos que "casualmente" matchean el
 * alfabeto base64 (p. ej. "abcd", "Test", que son válidos por forma pero
 * casi con certeza no son base64 real).
 */
const MIN_BASE64_CANDIDATE_LENGTH = 16;

/** Alfabeto base64 estándar con padding opcional (`=`/`==`) al final. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function normalizeKey(key: string): string {
  return key.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function matchSensitiveKind(key: string): SensitiveFieldKind | null {
  const normalized = normalizeKey(key);
  for (const kind of SENSITIVE_FIELD_KINDS) {
    if (SENSITIVE_KEY_SYNONYMS[kind].some((synonym) => normalized === synonym || normalized.includes(synonym))) {
      return kind;
    }
  }
  return null;
}

function isApprovedSourceRefKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return normalized === "approvedsourceref" || normalized === "sourceref";
}

function isValidApprovedSourceRef(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && "docId" in (value as Record<string, unknown>);
}

/** Un texto libre "parece" contener un dato sensible no abastecido si trae una palabra clave Y un número/fecha. */
function looksLikeUnsourcedSensitiveText(text: string): boolean {
  const lower = text.toLowerCase();
  const hasKeyword = SENSITIVE_TEXT_KEYWORDS.some((keyword) => lower.includes(keyword));
  return hasKeyword && NUMBER_OR_DATE_IN_TEXT.test(text);
}

export interface UnsourcedFinding {
  /** Ruta completa dentro del output, para depuración/trazabilidad (p. ej. "$.items[0].costo"). */
  path: string;
  /** Nombre de campo "desnudo" (última clave, sin índices de arreglo) — se cruza con `fieldName` de `extractSensitiveValues`. */
  fieldName: string;
  /**
   * "no_evaluable" (AG-21): el contenido no pudo escanearse de forma
   * completa y segura (p. ej. un binario que excede
   * `DEFAULT_MAX_BINARY_TOTAL_BYTES`) — se trata como un hallazgo que
   * bloquea la corrida, nunca como "no había nada sensible".
   */
  kind: SensitiveFieldKind | "texto_libre" | "no_evaluable";
}

/** Opciones de `scanForUnsourcedSensitiveData` (AG-21). */
export interface ScanForUnsourcedSensitiveDataOptions {
  /**
   * Límite defensivo de tamaño TOTAL (bytes) de un `Buffer`/`TypedArray`
   * que se acepta escanear completo en ventanas. Por defecto
   * `DEFAULT_MAX_BINARY_TOTAL_BYTES` (5 MiB). Superarlo produce un
   * hallazgo `kind: "no_evaluable"` en vez de dejar pasar el payload sin
   * examinar.
   */
  maxBinaryTotalBytes?: number;
}

/** Extrae la última clave "desnuda" de un path tipo "$.items[0].costo" o "$.a<0>" para reportarla como fieldName. */
function lastFieldName(path: string): string {
  const match = path.match(/([A-Za-z0-9_]+)(?:[[<][^\]>]*[\]>])*$/);
  return match ? match[1] : path;
}

/** `true` para `Buffer` (Node) o cualquier vista de `ArrayBuffer` (TypedArray), salvo `DataView`. */
function isBinaryContainer(value: unknown): value is Buffer | ArrayBufferView {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return true;
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function toUint8Array(value: Buffer | ArrayBufferView): Uint8Array {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value;
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * AG-21 (cierre de bypass de AG-19): decodifica un `Buffer`/`TypedArray`
 * COMPLETO como UTF-8, en ventanas solapadas de `BINARY_SCAN_WINDOW_BYTES`
 * bytes (solape `BINARY_SCAN_WINDOW_OVERLAP_BYTES`) — nunca un único
 * `subarray(0, N)` que descarte silenciosamente el resto del buffer. Un
 * valor sensible colocado después del byte 8192 (el límite original de
 * AG-19), o justo a caballo entre dos ventanas, queda dentro de al menos
 * una ventana completa mientras su longitud no supere el solape. Es una
 * heurística best-effort para detectar un payload de texto/JSON embebido;
 * un binario real (imagen, PDF) decodifica a basura que no matchea ningún
 * patrón de palabra clave ni JSON válido, así que no genera falsos
 * positivos. El llamador es responsable de aplicar el límite TOTAL de
 * tamaño (`DEFAULT_MAX_BINARY_TOTAL_BYTES`/`maxBinaryTotalBytes`) antes de
 * invocar esta función.
 */
function decodeBinaryWindows(value: Buffer | ArrayBufferView): string[] {
  const bytes = toUint8Array(value);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  if (bytes.byteLength <= BINARY_SCAN_WINDOW_BYTES) {
    return [decoder.decode(bytes)];
  }

  const windows: string[] = [];
  const step = BINARY_SCAN_WINDOW_BYTES - BINARY_SCAN_WINDOW_OVERLAP_BYTES;
  for (let offset = 0; offset < bytes.byteLength; offset += step) {
    const end = Math.min(offset + BINARY_SCAN_WINDOW_BYTES, bytes.byteLength);
    windows.push(decoder.decode(bytes.subarray(offset, end)));
    if (end >= bytes.byteLength) break;
  }
  return windows;
}

/**
 * AG-21: heurística de detección de base64 embebido en un string de texto
 * libre. Deliberadamente conservadora para minimizar falsos positivos
 * (muchos strings legítimos — IDs, hashes, tokens — "parecen" base64):
 * exige (a) longitud mínima razonable, (b) longitud múltiplo de 4, (c)
 * alfabeto base64 estricto con padding opcional, y — el filtro más
 * importante — (d) que el resultado decodificado sea UTF-8 VÁLIDO (decode
 * estricto, `fatal: true`) Y contenga al menos uno de `{`/`[`, es decir,
 * que PAREZCA JSON. No se decodifica base64 automáticamente sobre
 * CUALQUIER string (ver límite documentado en README): solo sobre
 * candidatos que ya parecen base64 por forma, y solo se actúa sobre el
 * resultado si además parece JSON.
 */
function tryDecodeBase64Json(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length < MIN_BASE64_CANDIDATE_LENGTH) return undefined;
  if (trimmed.length % 4 !== 0) return undefined;
  if (!BASE64_PATTERN.test(trimmed)) return undefined;
  if (typeof Buffer === "undefined") return undefined;

  let decodedBytes: Buffer;
  try {
    decodedBytes = Buffer.from(trimmed, "base64");
  } catch {
    return undefined;
  }
  if (decodedBytes.length === 0) return undefined;
  // Node no lanza con "base64 basura": hay que reconfirmar que el
  // texto decodificado sea realmente UTF-8 válido (defensa adicional
  // contra falsos positivos de binarios reales que casualmente matchean
  // el alfabeto base64).
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(decodedBytes);
  } catch {
    return undefined;
  }
  if (!/[{[]/.test(decoded)) return undefined;
  return decoded;
}

/**
 * AG-19: intenta encontrar JSON serializado dentro de una cadena de texto
 * libre (no solo cuando la cadena ES un JSON válido completo, sino también
 * cuando hay texto alrededor) y, si logra parsearlo como objeto/array,
 * recorre el resultado recursivamente con `walk` — así un
 * `JSON.stringify({precio: 999999})` guardado como string (o decodificado
 * desde un `Buffer`) no se escapa del escaneo solo por estar serializado.
 */
function findJsonCandidates(text: string): string[] {
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  const starts = [firstBrace, firstBracket].filter((i) => i >= 0);
  if (starts.length === 0) return [];
  const start = Math.min(...starts);
  const lastBrace = text.lastIndexOf("}");
  const lastBracket = text.lastIndexOf("]");
  const end = Math.max(lastBrace, lastBracket);
  const candidates = [text.trim(), text.slice(start)];
  if (end > start) candidates.push(text.slice(start, end + 1));
  return Array.from(new Set(candidates));
}

/**
 * Recorre recursivamente objetos/arrays/strings de `output` buscando
 * campos sensibles (por el diccionario de sinónimos) sin un
 * `approvedSourceRef` acompañante — ya sea como propiedad hermana en el
 * mismo objeto, o siguiendo la convención `{value, approvedSourceRef}` de
 * `sourcedValueSchema`. También marca texto libre que combina una palabra
 * clave sensible con un número/fecha, como señal heurística adicional.
 *
 * AG-19 (MEDIA): además de objetos/arrays planos, también desciende en
 * `Map` (sus entradas, tratadas igual que propiedades de un objeto), `Set`
 * (sus valores), `Buffer`/`TypedArray` (decodificados como UTF-8 con
 * límite, buscando JSON embebido o texto libre sospechoso) y strings que
 * contengan JSON serializado embebido. `Date` se trata como hoja inerte
 * (una fecha por sí sola no es un contenedor de datos sensibles).
 *
 * AG-21 (MEDIA, cierre de bypass estructural de AG-19):
 * - Un string de texto libre sensible como elemento DIRECTO de un `Array`
 *   (no solo de un `Set`) ahora también se evalúa con
 *   `looksLikeUnsourcedSensitiveText`.
 * - Un `Buffer`/`TypedArray` se escanea COMPLETO en ventanas solapadas
 *   (`decodeBinaryWindows`), no truncado a un único límite fijo; si el
 *   tamaño TOTAL supera `maxBinaryTotalBytes` (configurable, por defecto
 *   `DEFAULT_MAX_BINARY_TOTAL_BYTES`), se reporta un hallazgo explícito
 *   `kind: "no_evaluable"` en vez de dejarlo pasar sin examinar.
 * - Un string que "parece" base64 se decodifica heurísticamente
 *   (`tryDecodeBase64Json`) y, si el resultado parece JSON, se recorre
 *   igual que cualquier otro JSON embebido.
 *
 * Límite conocido residual (documentado también en README): esta es una
 * capa de heurísticas sobre representaciones TEXTO/JSON/base64 de los
 * datos. No decodifica compresión (gzip/deflate) ni contenido cifrado — un
 * valor sensible dentro de un payload comprimido o cifrado antes de llegar
 * al `output` de la herramienta no es detectable por este escaneo (haría
 * falta que la propia herramienta lo declare vía `extractSensitiveValues`).
 */
export function scanForUnsourcedSensitiveData(
  output: unknown,
  options: ScanForUnsourcedSensitiveDataOptions = {},
): UnsourcedFinding[] {
  const maxBinaryTotalBytes = options.maxBinaryTotalBytes ?? DEFAULT_MAX_BINARY_TOTAL_BYTES;
  const findings: UnsourcedFinding[] = [];
  walk(output, "$", false);
  return dedupeFindings(findings);

  function hasApprovedSourceRefSibling(obj: Record<string, unknown>): boolean {
    return Object.entries(obj).some(([key, val]) => isApprovedSourceRefKey(key) && isValidApprovedSourceRef(val));
  }

  /** Lógica compartida por objetos planos y por `Map` (convertido a entradas [key, val] con clave string). */
  function walkKeyedEntries(obj: Record<string, unknown>, path: string, ancestorSourced: boolean): void {
    const sourcedHere = ancestorSourced || hasApprovedSourceRefSibling(obj);
    for (const [key, val] of Object.entries(obj)) {
      if (isApprovedSourceRefKey(key)) continue;
      const childPath = `${path}.${key}`;
      const kind = matchSensitiveKind(key);
      if (kind) {
        if (
          val &&
          typeof val === "object" &&
          !Array.isArray(val) &&
          !(val instanceof Map) &&
          !(val instanceof Set) &&
          "value" in (val as Record<string, unknown>)
        ) {
          const inner = val as { value: unknown; approvedSourceRef?: unknown };
          const innerSourced = isValidApprovedSourceRef(inner.approvedSourceRef);
          if (inner.value !== null && inner.value !== undefined && !innerSourced) {
            findings.push({ path: childPath, fieldName: key, kind });
          }
        } else if (val !== null && val !== undefined && !sourcedHere) {
          findings.push({ path: childPath, fieldName: key, kind });
        }
      } else if (typeof val === "string" && !sourcedHere && looksLikeUnsourcedSensitiveText(val)) {
        findings.push({ path: childPath, fieldName: key, kind: "texto_libre" });
      }
      walk(val, childPath, sourcedHere);
    }
  }

  /** JSON embebido en un string (crudo o decodificado de binario): parsea candidatos y recorre el resultado. */
  function walkEmbeddedJson(text: string, path: string, ancestorSourced: boolean): void {
    for (const candidate of findJsonCandidates(text)) {
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (parsed && typeof parsed === "object") {
          walk(parsed, path, ancestorSourced);
        }
      } catch {
        // El candidato no era JSON válido: no es un bypass, sigue siendo texto libre normal.
      }
    }
  }

  function walk(value: unknown, path: string, ancestorSourced: boolean): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const childPath = `${path}[${index}]`;
        // AG-21: mismo chequeo de texto libre que ya existía para `Set` —
        // antes un string sensible como elemento directo de un Array de
        // nivel superior nunca se evaluaba con esta heurística.
        if (typeof item === "string" && !ancestorSourced && looksLikeUnsourcedSensitiveText(item)) {
          findings.push({ path: childPath, fieldName: lastFieldName(path), kind: "texto_libre" });
        }
        walk(item, childPath, ancestorSourced);
      });
      return;
    }

    if (value instanceof Map) {
      const asObject: Record<string, unknown> = {};
      for (const [key, val] of value.entries()) {
        asObject[typeof key === "string" ? key : String(key)] = val;
      }
      walkKeyedEntries(asObject, path, ancestorSourced);
      return;
    }

    if (value instanceof Set) {
      let index = 0;
      for (const item of value.values()) {
        const childPath = `${path}<${index++}>`;
        if (typeof item === "string" && !ancestorSourced && looksLikeUnsourcedSensitiveText(item)) {
          findings.push({ path: childPath, fieldName: lastFieldName(path), kind: "texto_libre" });
        }
        walk(item, childPath, ancestorSourced);
      }
      return;
    }

    if (value instanceof Date) {
      // Una fecha "cruda" (objeto Date) no es en sí misma un dato sensible sin
      // fuente: el campo que la contiene ya se evaluó al descender hasta aquí
      // (por nombre de clave, en el objeto padre). No hay nada más que recorrer.
      return;
    }

    if (isBinaryContainer(value)) {
      const bytes = toUint8Array(value);
      // AG-21: en vez de truncar en silencio (comportamiento original de
      // AG-19) y dejar que la corrida termine `completed` como si no
      // hubiera nada sensible, un binario que excede el límite total
      // configurable se marca explícitamente como "no_evaluable" — la
      // corrida se detiene igual que si faltara una fuente aprobada.
      if (bytes.byteLength > maxBinaryTotalBytes) {
        findings.push({ path, fieldName: lastFieldName(path), kind: "no_evaluable" });
        return;
      }
      for (const decoded of decodeBinaryWindows(value)) {
        if (!decoded) continue;
        if (!ancestorSourced && looksLikeUnsourcedSensitiveText(decoded)) {
          findings.push({ path, fieldName: lastFieldName(path), kind: "texto_libre" });
        }
        walkEmbeddedJson(decoded, path, ancestorSourced);
      }
      return;
    }

    if (typeof value === "string") {
      walkEmbeddedJson(value, path, ancestorSourced);
      // AG-21: heurística de base64 — si el string parece base64 Y decodifica
      // a algo que parece JSON, se recorre igual que cualquier JSON embebido.
      const base64Decoded = tryDecodeBase64Json(value);
      if (base64Decoded) {
        walkEmbeddedJson(base64Decoded, path, ancestorSourced);
      }
      return;
    }

    if (value && typeof value === "object") {
      walkKeyedEntries(value as Record<string, unknown>, path, ancestorSourced);
      return;
    }
  }
}

/**
 * AG-21: las ventanas solapadas de `decodeBinaryWindows` y los candidatos
 * de `findJsonCandidates` pueden generar el mismo hallazgo más de una vez
 * (p. ej. un JSON embebido que cae completo dentro de dos ventanas
 * consecutivas por el solape). Se deduplica por (path, fieldName, kind)
 * antes de devolver el resultado — no cambia qué se detecta, solo evita
 * reportar el mismo hallazgo repetido.
 */
function dedupeFindings(findings: UnsourcedFinding[]): UnsourcedFinding[] {
  const seen = new Set<string>();
  const result: UnsourcedFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.path} ${finding.fieldName} ${finding.kind}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(finding);
    }
  }
  return result;
}
