import { createHash } from "node:crypto";

/**
 * Tipos compartidos de packages/expediente.
 *
 * Este paquete es una librería TypeScript pura: no depende de ninguna base
 * de datos ni de packages/db o packages/agents (evita acoplarse a APIs que
 * otros implementadores están cambiando en paralelo). Las interfaces de
 * persistencia (`CompanyDataResolver`, etc.) se implementan aquí solo en
 * memoria para pruebas; `apps/api` deberá proveer implementaciones
 * respaldadas por Postgres.
 *
 * Alcance: docs/AMPLIACION-BACKOFFICE.md §5-8, docs/REQUISITOS.md
 * secciones 4-8 y 32-33 (REQ-156..171), docs/ACEPTACION.md pruebas A6-A15.
 */

/** Zona horaria oficial del expediente (México central). */
export const MEXICO_CITY_TZ = "America/Mexico_City";

export function isoNow(): string {
  return new Date().toISOString();
}

/** Formatea un ISO a fecha/hora legible en la zona horaria de Ciudad de México. */
export function formatMexicoCityDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Fecha inválida: "${iso}"`);
  }
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: MEXICO_CITY_TZ,
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

const ISO_OFFSET_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_OFFSET_HHMM_PATTERN = /([+-])(\d{2}):(\d{2})$/;
const ISO_DATE_PREFIX_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Rechaza offsets horarios numéricamente imposibles (EX-EXP-04/EX-EXP-13):
 * el patrón original `[+-]\d{2}:\d{2}` solo exigía DOS DÍGITOS, no un rango
 * válido — `"+99:00"` pasaba el formato, producía `Invalid Date` (`NaN`), e
 * `isPast()` evaluaba `NaN < NaN` como `false` ("nunca vencido"): un
 * *fail-open* silencioso sobre la garantía de vigencias. Los offsets
 * horarios reales del mundo van de "-12:00" a "+14:00"; se rechazan además
 * minutos fuera de 00-59.
 */
function assertOffsetInRange(iso: string, label: string): void {
  const match = iso.match(ISO_OFFSET_HHMM_PATTERN);
  if (!match) return; // termina en "Z": no hay offset numérico que validar.
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (minutes > 59) {
    throw new Error(`${label} con minutos de offset horario fuera de rango (00-59): "${iso}".`);
  }
  const totalMinutes = sign * (hours * 60 + minutes);
  if (totalMinutes < -12 * 60 || totalMinutes > 14 * 60) {
    throw new Error(`${label} con offset horario fuera del rango válido (-12:00 a +14:00): "${iso}".`);
  }
}

/**
 * Rechaza fechas calendáricamente imposibles que el formato ISO por sí solo
 * no detecta (EX-EXP-04/EX-EXP-13): `new Date("2026-02-29T...")` en un año
 * NO bisiesto no produce `Invalid Date` — JavaScript la reinterpreta
 * silenciosamente como el 1 de marzo. Se valida el día contra el máximo
 * real del mes/año antes de dejar que `Date` la parsee.
 */
function assertValidCalendarComponents(iso: string, label: string): void {
  const match = iso.match(ISO_DATE_PREFIX_PATTERN);
  if (!match) return; // no tiene forma "AAAA-MM-DD...": se deja que Date/NaN decida.
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) {
    throw new Error(`${label} con mes calendárico inválido (01-12): "${iso}".`);
  }
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (day < 1 || day > maxDay) {
    throw new Error(`${label} con día calendárico inválido para ese mes/año (p. ej. 29 de febrero en año no bisiesto): "${iso}".`);
  }
}

/**
 * Aísla y valida el componente de HORA (`HH:MM:SS[.fracción]`) de una
 * cadena ISO 8601 (EX-EXP-20): ni `assertOffsetInRange` ni
 * `assertValidCalendarComponents` miraban nunca la hora, solo el offset y
 * el prefijo `AAAA-MM-DD`. Esto dejaba pasar `"24:00:00"` — representación
 * ISO 8601 válida de la medianoche del día SIGUIENTE — sin lanzar, porque
 * `new Date("...T24:00:00Z")` no produce `NaN`: V8 la reinterpreta
 * silenciosamente como el día siguiente a las 00:00, el mismo patrón exacto
 * del bug de 29-feb ya corregido para el componente de FECHA (EX-EXP-13),
 * pero no extendido al componente de HORA. Se rechaza `"24:00:00"` sin
 * excepción (el llamador debe normalizar al día siguiente antes de pasarlo)
 * y cualquier minuto/segundo ≥60 o formato de hora/fracción mal formado.
 */
const ISO_TIME_SEGMENT_PATTERN = /T([0-9:.,]+)(?:Z|[+-]\d{2}:\d{2})$/;

function assertValidTimeComponents(iso: string, label: string): void {
  const match = iso.match(ISO_TIME_SEGMENT_PATTERN);
  if (!match) return; // no se pudo aislar un segmento de hora reconocible: se deja que Date/NaN decida.
  const parts = match[1].split(":");
  if (parts.length !== 3 || !/^\d{2}$/.test(parts[0]) || !/^\d{2}$/.test(parts[1])) {
    throw new Error(`${label} con formato de hora inválido (se esperaba "HH:MM:SS"): "${iso}".`);
  }
  const secondParts = parts[2].split(/[.,]/);
  if (
    secondParts.length > 2 ||
    !/^\d{2}$/.test(secondParts[0]) ||
    (secondParts.length === 2 && !/^\d+$/.test(secondParts[1]))
  ) {
    throw new Error(`${label} con segundos/fracción de hora en formato inválido: "${iso}".`);
  }
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  const second = Number(secondParts[0]);
  if (hour > 23) {
    throw new Error(
      `${label} con hora fuera de rango (00-23): "${iso}" — "24:00:00" (medianoche del día siguiente) NO se acepta; normalice al día siguiente antes de pasarlo (EX-EXP-20).`,
    );
  }
  if (minute > 59) {
    throw new Error(`${label} con minutos fuera de rango (00-59): "${iso}".`);
  }
  if (second > 59) {
    throw new Error(`${label} con segundos fuera de rango (00-59): "${iso}".`);
  }
}

/**
 * Verifica que una cadena ISO 8601 traiga offset horario EXPLÍCITO ("Z" o
 * "±HH:MM") — EX-EXP-04, REQ-160. Rechaza fechas "naive" (sin offset)
 * porque su interpretación dependería implícitamente de la zona horaria del
 * proceso Node que las evalúe: la misma cadena "2026-10-20T23:59:59" puede
 * dar un veredicto de vencimiento distinto según `TZ=UTC` (`false`) o
 * `TZ=Asia/Tokyo` (`true`). Todas las fechas que entran a este paquete
 * deben traer offset explícito (America/Mexico_City = "-06:00" o UTC "Z");
 * `apps/api` es responsable de normalizarlas al persistir.
 *
 * EX-EXP-13 (reverificación ronda 1): además de exigir el FORMATO del
 * offset, ahora valida su RANGO numérico (-12:00 a +14:00) y la validez
 * CALENDÁRICA de la fecha (día/mes reales, incluyendo años bisiestos) antes
 * de aceptarla — fail-closed: cualquier fecha inválida lanza, nunca se deja
 * pasar como si fuera una fecha válida "no vencida".
 *
 * EX-EXP-20 (reverificación ronda 2): también valida el componente de HORA
 * (ver `assertValidTimeComponents`) — "24:00:00" y minutos/segundos ≥60 ya
 * no se dejan pasar en silencio.
 */
export function assertExplicitOffset(iso: string, label = "fecha"): void {
  if (typeof iso !== "string" || iso.trim().length === 0) {
    throw new Error(`${label} inválida: se esperaba una cadena ISO 8601 no vacía con offset horario explícito, se recibió ${JSON.stringify(iso)}.`);
  }
  const trimmed = iso.trim();
  if (!ISO_OFFSET_PATTERN.test(trimmed)) {
    throw new Error(
      `${label} sin offset horario explícito (se requiere "Z" o "±HH:MM", p. ej. "-06:00" para America/Mexico_City): "${trimmed}".`,
    );
  }
  assertOffsetInRange(trimmed, label);
  assertValidCalendarComponents(trimmed, label);
  assertValidTimeComponents(trimmed, label);
  // Defensa final: cualquier otra forma de fecha inválida que las
  // comprobaciones anteriores no hayan capturado explícitamente también se
  // rechaza aquí — un `Date` inválido (`NaN`) NUNCA debe llegar a
  // `isPast()`/a ninguna comparación numérica silenciosa (EX-EXP-13).
  if (Number.isNaN(new Date(trimmed).getTime())) {
    throw new Error(`${label} no representa una fecha válida (fail-closed, EX-EXP-04/EX-EXP-13): "${trimmed}".`);
  }
}

/** `true` si `iso` (fecha límite) ya pasó respecto de `asOfIso` (por defecto ahora). Ambas deben traer offset explícito y ser calendáricamente válidas (EX-EXP-04/EX-EXP-13): `assertExplicitOffset` garantiza que `new Date(...).getTime()` nunca sea `NaN` aquí. */
export function isPast(iso: string, asOfIso: string = isoNow()): boolean {
  assertExplicitOffset(iso, "fecha límite (isPast)");
  assertExplicitOffset(asOfIso, "fecha de referencia asOfIso (isPast)");
  return new Date(iso).getTime() < new Date(asOfIso).getTime();
}

/** Roles usados por el flujo de aprobación del expediente (REQ-161/REQ-162). */
export type WorkflowRole = "owner" | "writer" | "reviewer" | "admin" | "viewer";

/**
 * Referencia trazable a un dato/documento aprobado o a una cláusula de las
 * bases. Toda afirmación de una propuesta debe traer una de estas — nunca
 * un valor "suelto" (REQ-027/REQ-035/REQ-164).
 */
export type SourceRef =
  | { kind: "company_data"; refId: string; capturedAt: string }
  | { kind: "clause"; documentId: string; page: number; clause?: string };

/** Calcula un sha256 hex determinista de cualquier valor serializable (para hashes de insumos, REQ-161). */
export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

/** JSON.stringify con claves ordenadas para que el mismo objeto lógico siempre produzca el mismo hash. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * Sentinela único para representar `undefined` dentro de `stableStringify`
 * (EX-EXP-01/EX-EXP-11, reverificación ronda 1): `JSON.stringify` descarta
 * silenciosamente las claves de objeto cuyo valor es `undefined` — por eso
 * `{total: "X", descuento: undefined}` y `{total: "X"}` producían el MISMO
 * hash, una colisión real cuando la presencia/ausencia de un campo es
 * información relevante (p. ej. para el hash de insumos de REQ-161). Al
 * sustituir `undefined` por este sentinel ANTES de llamar a
 * `JSON.stringify`, la clave deja de descartarse y ambos objetos producen
 * hashes distintos.
 */
const UNDEFINED_SENTINEL = " __stableStringify_undefined__ ";

/**
 * Marcador de tipo usado por `sortKeysDeep` para envolver valores que
 * `Object.entries`/`JSON.stringify` normalizarían de forma ambigua o
 * incorrecta (EX-EXP-18, reverificación ronda 2). Clave reservada (mismo
 * criterio que `UNDEFINED_SENTINEL`: bytes NUL que datos de negocio
 * normales no contienen literalmente) para distinguir el marcador de una
 * clave real de un objeto de llamador.
 */
const TYPE_MARKER_KEY = " __stableStringify_type__ ";

/** Compara dos valores YA normalizados por `sortKeysDeep`, sin importar su tipo (usado para ordenar entradas de `Map`/`Set`, cuyo orden de inserción no debe afectar el hash). */
function compareCanonical(a: unknown, b: unknown): number {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa === sb) return 0;
  return sa < sb ? -1 : 1;
}

/**
 * Normaliza recursivamente `value` para que `JSON.stringify` produzca
 * siempre la misma cadena para el mismo valor lógico, sin importar el
 * orden de inserción de claves/entradas ni el tipo exacto del contenedor.
 *
 * EX-EXP-18 (reverificación ronda 2): antes, cualquier `value` con
 * `typeof value === "object"` no-array (incluyendo `Date`, `Map`, `Set`)
 * caía en la rama genérica `Object.entries(value)` — que para estos tres
 * tipos devuelve `[]` (ninguno tiene propiedades PROPIAS enumerables), así
 * que CUALQUIER `Date`/`Map`/`Set` se serializaba como `"{}"`,
 * indistinguible de cualquier otro. `sha256Hex(new Date("2026-01-01"))` ===
 * `sha256Hex(new Date("2099-12-31"))`: una colisión real. Ahora cada uno se
 * serializa explícitamente con un marcador de tipo (`TYPE_MARKER_KEY`) que
 * conserva su valor lógico: `Date` como ISO 8601, `Map`/`Set` como sus
 * entradas/elementos (recursivamente normalizados y ordenados de forma
 * canónica, para que el orden de inserción no afecte el hash), y `bigint`
 * (que ni siquiera es `typeof "object"`, así que antes pasaba directo a
 * `JSON.stringify`, y `JSON.stringify(1n)` LANZA `TypeError: Do not know
 * how to serialize a BigInt`) como su representación decimal en texto.
 */
function sortKeysDeep(value: unknown): unknown {
  if (value === undefined) return UNDEFINED_SENTINEL;
  if (typeof value === "bigint") {
    return { [TYPE_MARKER_KEY]: "BigInt", value: value.toString() };
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error("stableStringify: no se puede serializar un Date inválido (Invalid Date).");
    }
    return { [TYPE_MARKER_KEY]: "Date", value: value.toISOString() };
  }
  if (value instanceof Map) {
    const entries = [...value.entries()]
      .map(([k, v]) => [sortKeysDeep(k), sortKeysDeep(v)] as [unknown, unknown])
      .sort((a, b) => compareCanonical(a[0], b[0]));
    return { [TYPE_MARKER_KEY]: "Map", entries };
  }
  if (value instanceof Set) {
    const items = [...value].map(sortKeysDeep).sort(compareCanonical);
    return { [TYPE_MARKER_KEY]: "Set", items };
  }
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = sortKeysDeep(v);
    return out;
  }
  return value;
}
