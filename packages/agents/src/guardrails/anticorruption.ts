import { isoNow } from "../types.js";

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
  input: string;
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

    for (const pattern of this.patterns) {
      if (pattern.regex.test(text)) matched.add(pattern.name);
    }

    for (const hook of this.hooks) {
      try {
        const extra = hook(text);
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
        input: text,
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
