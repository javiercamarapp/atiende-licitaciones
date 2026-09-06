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
 * AG-19 (MEDIA): límite defensivo de bytes decodificados de un `Buffer`/
 * `TypedArray` como texto UTF-8. No se decodifica el binario completo sin
 * límite: solo se usa para detectar heurísticamente un payload de texto/JSON
 * pequeño embebido (p. ej. `Buffer.from(JSON.stringify({...}))`), nunca para
 * tratar binarios grandes/reales (imágenes, PDFs) como texto.
 */
const MAX_BINARY_DECODE_BYTES = 8192;

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
  kind: SensitiveFieldKind | "texto_libre";
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
 * AG-19: decodifica un `Buffer`/`TypedArray` como UTF-8 con un límite
 * defensivo de bytes (`MAX_BINARY_DECODE_BYTES`) — nunca binarios completos
 * sin límite. Es una heurística best-effort para detectar un payload de
 * texto/JSON pequeño embebido (p. ej. `Buffer.from(JSON.stringify(...))`);
 * un binario real (imagen, PDF) decodifica a basura que no matchea ningún
 * patrón de palabra clave ni JSON válido, así que no genera falsos positivos.
 */
function decodeBinaryAsUtf8(value: Buffer | ArrayBufferView): string {
  const bytes = toUint8Array(value).subarray(0, MAX_BINARY_DECODE_BYTES);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
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
 */
export function scanForUnsourcedSensitiveData(output: unknown): UnsourcedFinding[] {
  const findings: UnsourcedFinding[] = [];
  walk(output, "$", false);
  return findings;

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
      value.forEach((item, index) => walk(item, `${path}[${index}]`, ancestorSourced));
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
      const decoded = decodeBinaryAsUtf8(value);
      if (decoded) {
        if (!ancestorSourced && looksLikeUnsourcedSensitiveText(decoded)) {
          findings.push({ path, fieldName: lastFieldName(path), kind: "texto_libre" });
        }
        walkEmbeddedJson(decoded, path, ancestorSourced);
      }
      return;
    }

    if (typeof value === "string") {
      walkEmbeddedJson(value, path, ancestorSourced);
      return;
    }

    if (value && typeof value === "object") {
      walkKeyedEntries(value as Record<string, unknown>, path, ancestorSourced);
      return;
    }
  }
}
