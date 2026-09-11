/**
 * REQ-092/REQ-093 (docs/REQUISITOS.md §21 "Móvil / Canales"): guardrail de
 * dominio PURO para el canal de voz/Realtime (ElevenLabs Conversational AI,
 * mismo proveedor que ya usan los repos hermanos atiende-hoteles/
 * atiende-restaurantes — ver apps/api/src/modules/voice/README.md para el
 * "esqueleto honesto" completo de la integración).
 *
 * REQ-092 (texto literal): "Voz (Realtime): solo consultas y recordatorios;
 * 'confirmo' verbal registra intención pero nunca ejecuta ni sustituye la
 * firma/aprobación". Criterio verificable: "Guardrail: la palabra 'confirmo'
 * nunca ejecuta la herramienta de fijar precio". La "herramienta de fijar
 * precio" es literalmente `set_final_price`, una de las
 * `DEFAULT_PROHIBITED_ACTIONS` de `authorization.ts` (REQ-044/REQ-068:
 * `always_approve` prohibido para fijar precio y emitir paquete) — este
 * módulo NO es la única barrera de esa categoría: el catálogo de tools que
 * el webhook de voz expone (`apps/api/src/modules/voice/routes.ts`) es
 * CERRADO a `listar_convocatorias`/`leer_bases`/`leer_perfil_empresa`/
 * `resumir_cambios_convocatoria`/`programar_alerta` — ninguna herramienta de
 * fijar precio, firmar, ni actuar en un portal existe siquiera en ese
 * catálogo, así que ni un modelo totalmente comprometido podría invocarla
 * por voz (defensa en profundidad, mismo criterio que
 * `packages/agents/README.md` documenta para `AuthorizationPolicy`).
 *
 * Este módulo cubre lo que el catálogo cerrado por sí solo NO puede cubrir:
 * clasificar, sobre el texto YA TRANSCRITO de un turno de voz, si el
 * llamador está intentando una CONFIRMACIÓN VERBAL de una acción sensible
 * (precio, firma, aprobación, envío a un tercero, actuación en un portal
 * oficial) — en cuyo caso la respuesta correcta NUNCA es ejecutar nada, sino
 * registrar la intención y remitir al flujo real de aprobación humana
 * (`POST /agents/tool-calls/:id/approve`, con step-up 2FA, ver
 * `apps/api/src/modules/agents/routes.ts`).
 *
 * REQ-093 (parcial — portal ya cerrado, ver docs/ACEPTACION.md): disclosure
 * de IA obligatorio en los primeros segundos de voz y respuesta fija ante
 * "¿eres humano?". Mismo patrón ya usado en atiende-hoteles
 * (`packages/agent-core/src/disclosure.ts`): una respuesta FIJA, nunca
 * generada por el modelo, para que la prueba de contrato de disclosure sea
 * determinista.
 *
 * Sesgo deliberado hacia FAIL-CLOSED (mismo criterio que
 * `guardrails/anticorruption.ts`): un falso positivo aquí solo cuesta
 * redirigir una solicitud legítima al flujo de aprobación humana normal; un
 * falso negativo dejaría pasar exactamente lo que REQ-092 prohíbe -- una
 * "confirmación" verbal tratada como si fuera una aprobación real. Patrones
 * representativos de frases conocidas, no un clasificador semántico -- mismo
 * límite honesto que el resto de los guards de texto libre de este paquete
 * (ver README, "Límite conocido").
 */

function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function normalize(text: string): string {
  return stripDiacritics(text).toLowerCase();
}

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// REQ-093 (parcial): disclosure de IA + respuesta fija a "¿eres humano?"
// ---------------------------------------------------------------------------

/**
 * Disclosure de IA a reproducir/decir en los primeros segundos de CUALQUIER
 * llamada de voz (REQ-093). LÍMITE EXPLÍCITO (no una decisión de ingeniería,
 * mismo criterio que `disclosure.ts` de atiende-hoteles): el texto legal
 * FINAL de este disclosure sigue pendiente de aprobación por el equipo
 * legal/fundador -- este es un borrador funcional suficiente para que el
 * mecanismo técnico (reproducirlo antes de cualquier otra cosa, y la prueba
 * de contrato que lo verifica) exista y sea determinista.
 */
export const DISCLOSURE_MESSAGE_VOZ: string =
  "Hola, soy un asistente de inteligencia artificial de Atiende Licitaciones, no una persona humana. " +
  "Puedo ayudarte a consultar el estado de tus convocatorias o programarte un recordatorio. " +
  "Nunca puedo fijar precios, firmar documentos ni presentar una oferta por ti -- eso siempre requiere " +
  "la aprobación de una persona autorizada de tu organización. Si prefieres hablar con alguien de tu " +
  "equipo, puedo pedir que te contacten.";

/** Respuesta FIJA (no generativa, nunca sale del LLM) a "¿eres humano?" y variantes cercanas --
 *  REQ-093 exige texto idéntico en cada prueba/conversación (mismo criterio que
 *  atiende-hoteles `RESPUESTA_FIJA_ES_HUMANO`, packages/agent-core/src/disclosure.ts). */
export const RESPUESTA_FIJA_ES_HUMANO: string =
  "No, soy un asistente de inteligencia artificial de Atiende Licitaciones, no una persona humana. " +
  "Si prefieres hablar con alguien de tu equipo, puedo pedir que te contacten.";

// Variantes comunes en español de "¿eres humano?" -- mismo patrón léxico que
// atiende-hoteles (acotado a esta pregunta puntual, no un clasificador
// general de intención).
const ES_HUMANO_PATTERN =
  /\b(eres|sos|es)\s+(tu\s+)?(un[ao]?\s+)?(humano|persona|robot|bot|ia|inteligencia artificial)\b|\b(hablo|hablar|quiero hablar|puedo hablar)\s+con\s+(un[ao]?\s+)?(humano|persona|agente real)\b|\b(es|eres)\s+esto\s+(un\s+)?(bot|robot)\b/;

/** true si `texto` pregunta, en alguna variante reconocida, si quien responde es humano. */
export function esPreguntaSiEsHumano(texto: string | null | undefined): boolean {
  if (!texto) return false;
  return ES_HUMANO_PATTERN.test(normalize(texto));
}

// ---------------------------------------------------------------------------
// REQ-092: "confirmo" verbal registra intención, nunca ejecuta ni sustituye
// la firma/aprobación.
// ---------------------------------------------------------------------------

/**
 * "Confirmo" en primera persona (o variantes muy cercanas: "sí, confirmo",
 * "queda confirmado", "confirmado, adelante") -- deliberadamente DISTINTO de
 * "confirma"/"confírmame"/"puedes confirmar" (que son el llamador
 * PIDIÉNDOLE al agente que confirme/verifique un dato, p. ej. "confírmame
 * el estatus de mi convocatoria" -- una consulta legítima, no una
 * confirmación verbal de una acción). Esta distinción de persona gramatical
 * es la que separa "consulta" (permitida) de "confirmación de una acción"
 * (nunca ejecutable por voz, sin importar de qué acción se trate).
 */
const VERBAL_CONFIRMATION_PATTERNS: readonly RegExp[] = [
  /\bconfirmo\b/i,
  /\bs[ií]\s*,?\s*confirmo\b/i,
  /\bqueda\s+confirmad[oa]\b/i,
  /\bconfirmad[oa]\s*,?\s*adelante\b/i,
  /\bacepto\s+y\s+confirmo\b/i,
];

/** true si el texto contiene una confirmación verbal en primera persona ("confirmo" y variantes cercanas). */
export function looksLikeVerbalConfirmation(text: string | null | undefined): boolean {
  if (!text) return false;
  return matchesAny(VERBAL_CONFIRMATION_PATTERNS, normalize(text));
}

export type VoiceOutOfScopeReason =
  | "fijar_precio_voz"
  | "firma_o_aprobacion_voz"
  | "accion_portal_voz"
  | "contacto_tercero_voz";

// Intento de fijar/cambiar el precio u oferta económica por voz -- la
// "herramienta de fijar precio" del criterio verificable de REQ-092
// (`set_final_price`, packages/agents/src/authorization.ts
// DEFAULT_PROHIBITED_ACTIONS).
const SET_PRICE_PHRASES: readonly RegExp[] = [
  /\bfij[ao]\s+(el\s+)?precio\b/i,
  /\bpon\s+(el\s+)?precio\s+(final\s+)?en\b/i,
  /\bel\s+precio\s+final\s+(es|ser[aá])\b/i,
  /\bcambia\s+(el\s+)?precio\s+a\b/i,
  /\bactualiza\s+(la\s+)?tarifa\s+a\b/i,
  /\boferta\s+econ[oó]mica\s+de\s+\$?\d/i,
];

// Firma/aprobación por voz -- `sign_document`/`sign_manifest`/
// `impersonate_signature` (DEFAULT_HARD_PROHIBITED_ACTIONS): ni siquiera
// pasan por HITL, se deniegan siempre para ejecución automática.
const SIGN_OR_APPROVAL_PHRASES: readonly RegExp[] = [
  /\bfirma\s+(el|la|este|esta)\s+(documento|manifiesto|propuesta|contrato)\b/i,
  /\baprueba\s+(la|el)\s+(propuesta|oferta|tool.?call)\s+(pendiente|de una vez)\b/i,
  /\bautoriza\s+(el\s+)?pago\b/i,
  /\bfirma\s+por\s+m[ií]\b/i,
];

// Acción en portal oficial / envío de la oferta -- `submit_proposal_to_portal`/
// `submit_proposal_to_comprasmx`/`upload_to_comprasmx`/`issue_final_package`.
const PORTAL_ACTION_PHRASES: readonly RegExp[] = [
  /\bsube\s+(el\s+)?paquete\s+a\s+comprasmx\b/i,
  /\bmanda\s+la\s+propuesta\s+(al\s+portal|a\s+comprasmx)\b/i,
  /\bpresenta\s+(la\s+)?oferta\s+(en\s+el\s+portal|ahora)\b/i,
  /\bemite\s+el\s+paquete\s+final\b/i,
  /\bsube\s+el\s+acuse\s+por\s+m[ií]\b/i,
];

// Contacto con un tercero (servidor público, competidor) -- `contact_third_party`/
// `contact_public_official`/`contact_competitor`.
const CONTACT_THIRD_PARTY_PHRASES: readonly RegExp[] = [
  /\bll[aá]male\s+(al\s+)?(comprador|funcionario|servidor\s+p[uú]blico)\b/i,
  /\bcont[aá]ctalo\s+(directamente|por\s+privado)\b/i,
  /\bhabla\s+con\s+el\s+competidor\b/i,
];

const OUT_OF_SCOPE_PATTERNS: ReadonlyArray<{ reason: VoiceOutOfScopeReason; patterns: readonly RegExp[] }> = [
  { reason: "fijar_precio_voz", patterns: SET_PRICE_PHRASES },
  { reason: "firma_o_aprobacion_voz", patterns: SIGN_OR_APPROVAL_PHRASES },
  { reason: "accion_portal_voz", patterns: PORTAL_ACTION_PHRASES },
  { reason: "contacto_tercero_voz", patterns: CONTACT_THIRD_PARTY_PHRASES },
];

/** true si el texto pide, por voz, una de las 4 categorías de acción fuera de alcance de REQ-092. */
export function classifyVoiceOutOfScopeReason(text: string | null | undefined): VoiceOutOfScopeReason | null {
  if (!text) return null;
  const normalized = normalize(text);
  for (const { reason, patterns } of OUT_OF_SCOPE_PATTERNS) {
    if (matchesAny(patterns, normalized)) return reason;
  }
  return null;
}

export type VoiceInteractionDecision =
  | { kind: "es_humano"; response: string }
  | { kind: "fuera_de_alcance"; reason: VoiceOutOfScopeReason; guestFacingMessage: string; confirmoDetectado: boolean }
  | { kind: "confirmacion_verbal_registrada"; guestFacingMessage: string };

const OUT_OF_SCOPE_MESSAGES: Readonly<Record<VoiceOutOfScopeReason, string>> = {
  fijar_precio_voz:
    "Por este canal solo puedo consultar información y programarte recordatorios. Fijar o cambiar un precio " +
    "siempre requiere que una persona autorizada lo apruebe desde la plataforma; queda registrada tu intención, " +
    "pero no se ejecuta nada por esta llamada.",
  firma_o_aprobacion_voz:
    "No puedo firmar documentos ni aprobar nada por teléfono. Queda registrada tu intención, pero la firma o " +
    "aprobación siempre debe hacerla una persona autorizada desde la plataforma.",
  accion_portal_voz:
    "No puedo presentar ni subir nada a un portal oficial por voz. Queda registrada tu intención, pero esa " +
    "acción siempre la hace una persona autorizada desde la plataforma.",
  contacto_tercero_voz:
    "No puedo contactar a servidores públicos, compradores ni competidores por ti. Esa acción está prohibida " +
    "para este agente sin excepción.",
};

const VERBAL_CONFIRMATION_REGISTERED_MESSAGE =
  "Anoté tu confirmación como una intención registrada, no como una aprobación ejecutada -- ninguna acción " +
  "sensible (precio, firma, envío) se ejecuta por esta llamada. Un miembro autorizado de tu equipo deberá " +
  "confirmarlo desde la plataforma.";

/**
 * Punto único de clasificación de un turno de voz YA TRANSCRITO, ANTES de
 * que llegue a cualquier proveedor de modelo o tool (mismo criterio que
 * `classifyVoiceGuardrailRefusal` de atiende-hoteles): decide si el turno
 * es (a) la pregunta fija "¿eres humano?", (b) un intento de acción fuera
 * del alcance de REQ-092 (con o sin la palabra "confirmo"), o (c) una
 * confirmación verbal ("confirmo") sin una acción sensible explícita
 * adjunta -- que de todos modos se registra como INTENCIÓN, nunca como
 * ejecución. Devuelve `null` cuando nada de esto aplica: el turno sigue su
 * curso normal (consulta o programación de recordatorio).
 *
 * Fail-closed: basta que la categoría (b) haga match para rechazar, sin
 * importar si "confirmo" aparece o no en el mismo turno -- el criterio
 * verificable de REQ-092 ("la palabra 'confirmo' nunca ejecuta la
 * herramienta de fijar precio") es el caso MÁS peligroso de (b), pero la
 * prohibición no depende de que esa palabra exacta esté presente.
 */
export function classifyVoiceInteraction(text: string | null | undefined): VoiceInteractionDecision | null {
  if (!text) return null;
  if (esPreguntaSiEsHumano(text)) {
    return { kind: "es_humano", response: RESPUESTA_FIJA_ES_HUMANO };
  }
  const outOfScopeReason = classifyVoiceOutOfScopeReason(text);
  if (outOfScopeReason) {
    return {
      kind: "fuera_de_alcance",
      reason: outOfScopeReason,
      guestFacingMessage: OUT_OF_SCOPE_MESSAGES[outOfScopeReason],
      confirmoDetectado: looksLikeVerbalConfirmation(text),
    };
  }
  if (looksLikeVerbalConfirmation(text)) {
    return { kind: "confirmacion_verbal_registrada", guestFacingMessage: VERBAL_CONFIRMATION_REGISTERED_MESSAGE };
  }
  return null;
}
