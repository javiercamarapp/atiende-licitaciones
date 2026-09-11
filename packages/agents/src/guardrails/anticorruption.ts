import { hashValue } from "../tracing.js";
import { isoNow } from "../types.js";

/**
 * AG-07: longitud máxima del extracto redactado que se persiste en
 * `GuardrailEvent.inputExcerpt`. Un tool_call bloqueado puede contener
 * cualquier dato personal en texto plano; truncar acota cuánto queda
 * expuesto indefinidamente en memoria vía `getAuditLog()`.
 */
const MAX_EXCERPT_LENGTH = 160;

/**
 * AG-24 (REQ-097, red-teaming de inyección de prompt): normaliza el texto
 * ANTES de compararlo contra los patrones de `DEFAULT_PATTERNS`/hooks, para
 * que una técnica trivial de evasión no baste para colar una palabra
 * prohibida disfrazada:
 *  - `NFKC` unifica formas de compatibilidad Unicode (dígitos/letras de
 *    ancho completo, ligaduras, etc.) con su forma canónica ASCII — sin
 *    esto, la variante de ancho completo de "mordida" nunca empataba
 *    `/\bmordida\b/i` pese a leerse idéntico a simple vista.
 *  - Se eliminan los caracteres de ancho cero U+200B..U+200D (ZERO WIDTH
 *    SPACE/NON-JOINER/JOINER) y U+FEFF (BOM/ZERO WIDTH NO-BREAK SPACE) que
 *    un atacante puede insertar DENTRO de una palabra prohibida
 *    ("mor" + U+200B + "dida") para partirla en fragmentos que ningún
 *    regex por sí solo reconoce, sin que el texto se vea distinto al
 *    copiarlo/leerlo.
 *
 * Los propios puntos de código se construyen con `String.fromCharCode(...)`
 * (nunca como caracteres invisibles literales en este archivo fuente, ni
 * como escapes `\u` que un editor/terminal puede volver a renderizar como
 * el carácter invisible real) para que el patrón sea auditable a simple
 * vista en un diff/PR: cada codepoint queda como un número decimal/hex
 * legible, no como un espacio en blanco que no se puede ver ni copiar bien.
 *
 * Esto NO resuelve homoglifos entre alfabetos distintos (p. ej. una letra
 * cirílica sustituyendo una latina): NFKC no unifica esos pares porque son
 * puntos de código con identidad propia, no formas de compatibilidad del
 * mismo carácter — cerrar esa vía exigiría una tabla de "confusables"
 * (Unicode TR39) que este cambio no incluye para no fabricar cobertura no
 * verificada; ver README.md "Pendientes" para dejarlo explícito.
 */
// Alternación de codepoints exactos en vez de una clase de caracteres
// `[...]`: eslint(no-misleading-character-class) marca como engañosa una
// clase que junta U+200D (ZERO WIDTH JOINER) con codepoints vecinos (por
// cómo se renderizan secuencias ZWJ agrupadas); la alternación evita esa
// ambigüedad y sigue matcheando cada codepoint de forma individual, que es
// exactamente lo que se necesita aquí (nunca una secuencia de grafema
// completa).
const ZERO_WIDTH_AND_BOM_CODEPOINTS = [0x200b, 0x200c, 0x200d, 0xfeff];
const ZERO_WIDTH_AND_BOM_PATTERN = new RegExp(ZERO_WIDTH_AND_BOM_CODEPOINTS.map((code) => String.fromCharCode(code)).join("|"), "g");

function normalizeForMatching(text: string): string {
  return text.normalize("NFKC").replace(ZERO_WIDTH_AND_BOM_PATTERN, "");
}

/** Enmascara secuencias de 4+ dígitos consecutivos (posibles cuentas/tarjetas/teléfonos). */
function redactLongDigitRuns(text: string): string {
  return text.replace(/\d{4,}/g, (run) => "#".repeat(run.length));
}

/**
 * AG-07: produce un extracto REDACTADO y acotado del texto bloqueado, para
 * depuración humana, sin persistir el texto crudo completo. Complementa
 * `inputHash` (sha256 del texto íntegro, mismo patrón que `ToolCallTrace`),
 * que sí permite verificar/re-derivar el texto exacto si se tiene acceso al
 * texto original, pero no lo expone por sí solo.
 */
function redactExcerpt(text: string): string {
  const redacted = redactLongDigitRuns(text);
  if (redacted.length <= MAX_EXCERPT_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_EXCERPT_LENGTH)}…`;
}

/**
 * Guardrail anticorrupción (REQ-072, REQ-111-REQ-118, patrón G-07 de
 * BLUEPRINT-LICITACIONES.pdf). Bloquea tool_calls o instrucciones que
 * soliciten dádivas/sobornos, manipulación de servidores públicos o
 * coordinación de precios con competidores, y registra cada bloqueo como
 * evento auditable (nunca lanza sobre el registro: "registrar nunca debe
 * lanzar").
 *
 * Es un hook extensible: además de los patrones por defecto, se pueden
 * agregar patrones regex adicionales o funciones de verificación (`hooks`)
 * para reglas más complejas que un regex no puede capturar (p. ej. un
 * clasificador LLM en `apps/api`).
 */

export interface GuardrailPattern {
  name: string;
  regex: RegExp;
}

export type GuardrailHook = (text: string) => string[] | null | undefined;

export interface GuardrailCheckContext {
  actorId?: string;
  organizationId?: string | null;
  toolName?: string;
}

export interface GuardrailEvent {
  id: string;
  timestamp: string;
  actorId: string | null;
  organizationId: string | null;
  toolName: string | null;
  /** sha256 hex del texto completo bloqueado (AG-07) — nunca el texto crudo, mismo patrón que `ToolCallTrace.inputHash`. */
  inputHash: string;
  /** Extracto truncado (máx. `MAX_EXCERPT_LENGTH` caracteres) y redactado (secuencias largas de dígitos enmascaradas), solo para depuración humana. */
  inputExcerpt: string;
  matchedPatterns: string[];
  action: "blocked";
}

export interface GuardrailCheckResult {
  blocked: boolean;
  matchedPatterns: string[];
}

const DEFAULT_PATTERNS: GuardrailPattern[] = [
  {
    name: "soborno_o_dadiva",
    regex: /\b(sob(?:o)?rno|coima|mordida|d[aá]diva|bribe|kickback)\b/i,
  },
  {
    name: "pago_indebido_a_servidor_publico",
    regex:
      /\b(pagar|pago|transferir|deposit\w*|entregar dinero)\b[^.\n]{0,60}\b(servidor\s+p[uú]blico|funcionario|contralor|comprador\s+p[uú]blico)\b/i,
  },
  {
    name: "regalo_a_funcionario",
    regex: /\b(regalo|comisi[oó]n\s+por\s+debajo\s+de\s+la\s+mesa)\b[^.\n]{0,60}\b(funcionario|servidor\s+p[uú]blico)\b/i,
  },
  {
    name: "coordinacion_de_precios_con_competidor",
    regex: /\b(acordar|coordinar|pactar)\b[^.\n]{0,60}\b(precio|oferta|postura)\b[^.\n]{0,60}\b(competidor|otra\s+empresa|otro\s+licitante)\b/i,
  },
  {
    name: "manipulacion_de_evaluacion_o_fallo",
    regex: /\b(manipular|alterar|falsificar)\b[^.\n]{0,60}\b(evaluaci[oó]n|fallo|acta|puntaje|dictamen)\b/i,
  },
  {
    name: "contacto_informal_con_servidor_publico",
    regex: /\b(contactar|hablar con|llamar a)\b[^.\n]{0,60}\b(servidor\s+p[uú]blico|funcionario)\b[^.\n]{0,60}\b(fuera del (?:proceso|acto)|por\s+privado|extraoficialmente)\b/i,
  },
];

export class AntiCorruptionGuardrail {
  private readonly patterns: GuardrailPattern[];
  private readonly hooks: GuardrailHook[] = [];
  private readonly events: GuardrailEvent[] = [];
  private idCounter = 0;

  constructor(options?: { patterns?: GuardrailPattern[]; hooks?: GuardrailHook[] }) {
    this.patterns = options?.patterns ?? [...DEFAULT_PATTERNS];
    if (options?.hooks) this.hooks.push(...options.hooks);
  }

  /** Agrega un patrón regex adicional (extensible sin tocar el core). */
  addPattern(pattern: GuardrailPattern): void {
    this.patterns.push(pattern);
  }

  /** Agrega un hook de verificación adicional (p. ej. clasificador externo). */
  addHook(hook: GuardrailHook): void {
    this.hooks.push(hook);
  }

  /**
   * Revisa un texto (instrucción del usuario o argumentos serializados de un
   * tool_call). Si encuentra coincidencias, registra un evento auditable y
   * retorna `blocked: true`. Nunca lanza: un fallo interno de un hook se
   * ignora silenciosamente para esa fuente, sin tumbar la verificación
   * completa (equivalente a "registrar nunca debe lanzar").
   */
  check(text: string, ctx: GuardrailCheckContext = {}): GuardrailCheckResult {
    const matched = new Set<string>();
    // AG-24: los patrones (y los hooks) siempre comparan contra el texto
    // NORMALIZADO -- nunca el crudo -- para no depender de que cada patrón
    // regex individual reimplemente su propia defensa contra ancho
    // completo/caracteres de ancho cero. `recordEvent` más abajo sigue
    // usando el texto ORIGINAL (sin normalizar) para el hash/extracto: la
    // normalización es solo una vista para decidir el match, nunca
    // reemplaza la evidencia real auditada.
    const normalizedText = normalizeForMatching(text);

    for (const pattern of this.patterns) {
      if (pattern.regex.test(normalizedText)) matched.add(pattern.name);
    }

    for (const hook of this.hooks) {
      try {
        const extra = hook(normalizedText);
        if (extra) for (const name of extra) matched.add(name);
      } catch {
        // Un hook roto nunca debe bloquear ni tumbar la verificación de guardrail.
      }
    }

    const matchedPatterns = Array.from(matched);
    if (matchedPatterns.length > 0) {
      this.recordEvent(text, matchedPatterns, ctx);
      return { blocked: true, matchedPatterns };
    }
    return { blocked: false, matchedPatterns: [] };
  }

  private recordEvent(text: string, matchedPatterns: string[], ctx: GuardrailCheckContext): void {
    try {
      this.events.push({
        id: `guardrail-${++this.idCounter}`,
        timestamp: isoNow(),
        actorId: ctx.actorId ?? null,
        organizationId: ctx.organizationId ?? null,
        toolName: ctx.toolName ?? null,
        inputHash: hashValue(text),
        inputExcerpt: redactExcerpt(text),
        matchedPatterns,
        action: "blocked",
      });
    } catch {
      // Registrar nunca debe lanzar ni tumbar el bloqueo ya decidido.
    }
  }

  /** Bitácora de eventos bloqueados, en orden cronológico. */
  getAuditLog(): readonly GuardrailEvent[] {
    return this.events;
  }
}
