/**
 * REQ-198 — Guardia de 0 PII en analítica (AMPLIACION-2 §4).
 *
 * Estado real hoy: `apps/web` no tiene NINGUNA analítica -- ni SDK instalado
 * (`package.json` sin `posthog-js`/`plausible-tracker`/`@vercel/analytics`/
 * etc.), ni script inyectado en `index.html`, ni ninguna llamada a
 * `gtag`/`dataLayer`/similares en `src/` (ver
 * `src/test/no-analytics-sdk.test.ts`, que fija esto como regresión). Eso
 * satisface el criterio de aceptación ("0 campos con PII identificable")
 * de forma PASIVA: no hay payload que auditar porque no hay analítica.
 *
 * Lo que faltaba -- y lo que agrega este módulo -- es el blindaje ACTIVO:
 * si algún día se agrega analítica real, el envío debe pasar por
 * `assertNoPii`/`guardAnalyticsSink` antes de tocar cualquier sink externo,
 * y CUALQUIER campo con forma de dato personal identificable (nombre,
 * correo, teléfono, RFC, CURP, IP, dirección, datos financieros/
 * credenciales) hace que el envío falle de inmediato, sin importar bajo qué
 * nombre de campo o qué tan anidado venga.
 *
 * Patrón "puerto real + lógica real + adaptador fake para pruebas" (mismo
 * usado en `packages/agents/src/llm/fake-provider.ts` para `LLMProvider`/
 * `FakeProvider`): `AnalyticsSink` es el puerto que cualquier proveedor real
 * implementaría; `assertNoPii`/`guardAnalyticsSink` es la lógica de negocio
 * REAL (no un mock); `FakeAnalyticsSink` (`fakeAnalyticsSink.ts`) es el
 * único adaptador fake, usado solo en pruebas, que nunca sale a la red.
 *
 * `verificado_contra_real=false`: esta guardia nunca se ha probado contra un
 * proveedor de analítica real porque ninguno existe en el repo todavía. El
 * día que se integre uno, la integración real debe enrutarse por
 * `guardAnalyticsSink(realSink)` y remover esta nota.
 *
 * Complementa, no reemplaza, la defensa de red ya existente en
 * `src/lib/security/csp.ts` (`connect-src 'self'`): un beacon de analítica
 * hacia un dominio de terceros ya sería bloqueado por el navegador salvo que
 * alguien edite la CSP a propósito -- momento en el que también debería,
 * a propósito, enrutar el evento por este guardia.
 */

/** Evento de analítica candidato a enviarse. Solo datos planos/estructurados -- nunca texto libre sin escrutinio. */
export interface AnalyticsEvent {
  /** Nombre del evento, p. ej. "page_view", "cta_click". */
  name: string;
  /** Propiedades del evento. Puede anidar objetos/arreglos; se recorren completos (ver `MAX_DEPTH`). */
  properties?: Record<string, unknown>;
}

/** Puerto real: cualquier destino de analítica (Plausible, PostHog, un endpoint propio, etc.) implementa esto. */
export interface AnalyticsSink {
  send(event: AnalyticsEvent): void | Promise<void>;
}

export class PiiDetectedError extends Error {
  constructor(
    public readonly eventName: string,
    public readonly reasons: string[],
  ) {
    super(
      `REQ-198: evento de analítica "${eventName}" bloqueado -- posible PII detectada: ${reasons.join("; ")}. ` +
        `Quita el campo o el valor señalado antes de reintentar el envío.`,
    );
    this.name = "PiiDetectedError";
  }
}

/**
 * Profundidad máxima de recorrido de `properties`. Un payload de analítica
 * legítimo es plano o casi plano; una anidación mayor a esto se rechaza por
 * defecto (fail-closed) en vez de arriesgarse a no inspeccionar un campo con
 * PII escondido más adentro.
 */
const MAX_DEPTH = 6;

/**
 * Tokens de nombre de campo que, por sí solos, indican un dato personal
 * identificable (o un dato sensible adyacente -- LFPDPPP también trata como
 * "datos personales" los financieros/patrimoniales y de acceso). Comparación
 * por TOKEN exacto tras normalizar camelCase/snake_case/kebab-case y quitar
 * acentos -- nunca por substring crudo, para no marcar falsos positivos como
 * "relatedId" (contiene la subcadena "lat") o "translation" (contiene "lat").
 */
const DENYLISTED_KEY_TOKENS = new Set([
  "email",
  "correo",
  "nombre",
  "apellido",
  "fullname",
  "firstname",
  "lastname",
  "telefono",
  "phone",
  "celular",
  "movil",
  "rfc",
  "curp",
  "nss",
  "passport",
  "pasaporte",
  "ine",
  "direccion",
  "address",
  "calle",
  "colonia",
  "ip",
  "dob",
  "password",
  "contrasena",
  "secret",
  "apikey",
  "tarjeta",
  "card",
  "clabe",
  "iban",
  "curriculum",
  "lat",
  "lng",
  "latitude",
  "longitude",
  "geolocation",
  "coords",
]);

/**
 * Igual que `DENYLISTED_KEY_TOKENS` pero para términos compuestos que un
 * tokenizador partiría en palabras individuales inocuas por separado
 * (p. ej. "codigoPostal" -> tokens "codigo"+"postal", ninguno sospechoso
 * solo). Se compara contra la clave normalizada SIN separadores.
 */
const DENYLISTED_KEY_JOINED_SUBSTRINGS = [
  "codigopostal",
  "zipcode",
  "postalcode",
  "fechanacimiento",
  "birthdate",
  "cuentabancaria",
  "numerotarjeta",
  "cardnumber",
];

/** Correo electrónico embebido en cualquier cadena, sin importar el nombre del campo. */
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/**
 * RFC mexicano (persona física de 13 posiciones o moral de 12): heurística
 * de forma, no un validador oficial de dígito verificador -- suficiente
 * para un guardia que debe fallar cerrado ante algo con forma de RFC.
 */
const RFC_RE = /\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/i;

/** CURP mexicana (18 posiciones), misma heurística de forma que RFC_RE. */
const CURP_RE = /\b[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/i;

/** Dirección IPv4 embebida en cualquier cadena. */
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/;

/**
 * Secuencia de exactamente 10 dígitos consecutivos: longitud típica de un
 * teléfono mexicano sin separadores. Se usa 10 (no un umbral menor) a
 * propósito para no marcar falsos positivos sobre montos/IDs numéricos
 * cortos comunes en analítica legítima (p. ej. "150000").
 */
const DIGIT_RUN_RE = /\b\d{10}\b/;

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Parte una clave camelCase/snake_case/kebab-case en tokens normalizados (minúsculas, sin acentos). */
function tokenizeKey(key: string): string[] {
  const withSpaces = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-\s.]+/g, " ");
  return stripDiacritics(withSpaces)
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
}

function checkKeyDenylist(key: string, fieldPath: string, reasons: Set<string>): void {
  const tokens = tokenizeKey(key);
  if (tokens.some((token) => DENYLISTED_KEY_TOKENS.has(token))) {
    reasons.add(`campo "${fieldPath}" tiene nombre asociado a PII`);
    return;
  }
  const joined = tokens.join("");
  if (DENYLISTED_KEY_JOINED_SUBSTRINGS.some((s) => joined.includes(s))) {
    reasons.add(`campo "${fieldPath}" tiene nombre asociado a PII`);
  }
}

function checkValuePatterns(value: string, fieldPath: string, reasons: Set<string>): void {
  if (EMAIL_RE.test(value)) reasons.add(`campo "${fieldPath}" contiene un correo electrónico`);
  if (CURP_RE.test(value)) reasons.add(`campo "${fieldPath}" contiene un CURP`);
  if (RFC_RE.test(value)) reasons.add(`campo "${fieldPath}" contiene un RFC`);
  if (IPV4_RE.test(value)) reasons.add(`campo "${fieldPath}" contiene una dirección IP`);
  if (DIGIT_RUN_RE.test(value)) reasons.add(`campo "${fieldPath}" contiene una secuencia de 10 dígitos (posible teléfono)`);
}

function walk(value: unknown, path: string, depth: number, reasons: Set<string>): void {
  if (depth > MAX_DEPTH) {
    // Fail-closed: si el payload es más profundo de lo que este guardia
    // recorre, se rechaza en vez de arriesgarse a dejar pasar PII sin
    // inspeccionar.
    reasons.add(`"${path}" excede la profundidad máxima permitida (${MAX_DEPTH}) -- payload rechazado sin inspección completa`);
    return;
  }
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    checkValuePatterns(value, path, reasons);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1, reasons));
    return;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const fieldPath = path ? `${path}.${key}` : key;
      checkKeyDenylist(key, fieldPath, reasons);
      walk(nested, fieldPath, depth + 1, reasons);
    }
    return;
  }
  // number/boolean/bigint/etc.: no son cadenas, no se revisan por patrón de
  // valor -- si el nombre del campo que los contiene está en la lista negra
  // ya se atrapó en `checkKeyDenylist` antes de llegar aquí.
}

export interface PiiCheckResult {
  ok: boolean;
  reasons: string[];
}

/** Revisa un evento de analítica y describe, sin lanzar, cualquier posible PII encontrada. */
export function checkForPii(event: AnalyticsEvent): PiiCheckResult {
  const reasons = new Set<string>();
  checkKeyDenylist(event.name, "name", reasons);
  checkValuePatterns(event.name, "name", reasons);
  if (event.properties) walk(event.properties, "properties", 0, reasons);
  return { ok: reasons.size === 0, reasons: Array.from(reasons) };
}

/** Lanza `PiiDetectedError` si el evento contiene algo con forma de PII. No hace red ni efectos secundarios. */
export function assertNoPii(event: AnalyticsEvent): void {
  const result = checkForPii(event);
  if (!result.ok) throw new PiiDetectedError(event.name, result.reasons);
}

/**
 * Envuelve cualquier `AnalyticsSink` real con la guardia REQ-198: el evento
 * se valida con `assertNoPii` ANTES de tocar el sink -- si hay PII, lanza y
 * el sink real nunca recibe el evento (nada de "enviar y luego avisar").
 */
export function guardAnalyticsSink(sink: AnalyticsSink): AnalyticsSink {
  return {
    send(event: AnalyticsEvent) {
      assertNoPii(event);
      return sink.send(event);
    },
  };
}
