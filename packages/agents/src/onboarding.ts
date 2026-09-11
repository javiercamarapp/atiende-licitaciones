import type { LLMMessage, LLMProvider } from "./llm/provider.js";
import type { ModelTier } from "./types.js";

/**
 * Patrón Likida/atiende.ai #7 (onboarding conversacional con guardas
 * deterministas): `apps/web/src/pages/onboarding/OnboardingPage.tsx` es un
 * wizard rígido de 5 pasos fijos sin ninguna interacción conversacional que
 * adapte las preguntas a lo que falta o ya se sabe del usuario. Este módulo
 * es el "flujo" que decide, de forma determinista, QUÉ falta y QUÉ preguntar
 * después -- el LLM (cuando hay uno configurado) solo REDACTA la pregunta en
 * lenguaje natural, nunca decide qué campo falta ni si el onboarding ya
 * terminó. Mismo criterio "código decide QUÉ, el modelo solo redacta" que
 * `apps/worker/src/agents/named-agents.ts` ya aplica a los agentes con plan
 * fijo -- aquí no hay ningún `ToolRegistry`/`AgentRunner` de por medio
 * (esto es un único turno de conversación, sin tool_calls encadenados ni
 * persistencia de `agent_runs`) porque ese aparato está diseñado para planes
 * de varias herramientas sobre una convocatoria concreta, no para decidir
 * "¿qué pregunto ahora?" sobre datos de la propia organización.
 */

/** Campos que el onboarding conversacional puede completar, en el mismo orden en que el wizard actual los pide. */
export type OnboardingFieldId = "organization" | "legalName" | "taxId" | "sector" | "team" | "document";

/**
 * GUARDA DETERMINISTA (lo que pide explícitamente el patrón #7): estos tres
 * campos son OBLIGATORIOS -- el flujo nunca se marca "listo"
 * (`OnboardingProgress.isComplete`) mientras falte alguno. Es más estricto
 * que el wizard actual en un punto: ahí `sector` es opcional
 * (`profileSchema` de `OnboardingPage.tsx` lo declara `z.string().optional()`)
 * porque `apps/api` ya lo acepta vacío; aquí se endurece a propósito porque
 * el patrón lo pide explícitamente ("organización, RFC, giro").
 */
export const REQUIRED_ONBOARDING_FIELDS: readonly OnboardingFieldId[] = ["organization", "legalName", "taxId", "sector"];

/** Campos omitibles -- igual que los pasos 3/4 del wizard actual (equipo/documento), nunca bloquean `isComplete`. */
export const OPTIONAL_ONBOARDING_FIELDS: readonly OnboardingFieldId[] = ["team", "document"];

/** Orden fijo en el que se preguntan los campos -- obligatorios primero, en el mismo orden que el wizard, luego los opcionales. */
export const ONBOARDING_FIELD_ORDER: readonly OnboardingFieldId[] = [
  ...REQUIRED_ONBOARDING_FIELDS,
  ...OPTIONAL_ONBOARDING_FIELDS,
];

/** Lo que ya se sabe del onboarding de una organización -- lo calcula el llamador (apps/api) a partir de datos reales, nunca inventado aquí. */
export interface OnboardingKnownState {
  hasOrganization: boolean;
  legalName?: string | null;
  taxId?: string | null;
  sector?: string | null;
  teamInvited?: boolean;
  firstDocumentUploaded?: boolean;
}

export interface OnboardingProgress {
  missingRequired: OnboardingFieldId[];
  missingOptional: OnboardingFieldId[];
  /**
   * GUARDA DETERMINISTA: `true` únicamente cuando `missingRequired` está
   * vacío. Este valor SIEMPRE se calcula aquí, en código puro, a partir de
   * `state` -- ninguna función de este archivo que use un `LLMProvider`
   * puede sobreescribirlo ni influir en él (ver `nextOnboardingQuestion`,
   * que llama a `computeOnboardingProgress` y nunca deja que el resultado
   * del modelo cambie `isComplete`/`missingRequired`).
   */
  isComplete: boolean;
}

function isFieldKnown(field: OnboardingFieldId, state: OnboardingKnownState): boolean {
  switch (field) {
    case "organization":
      return state.hasOrganization === true;
    case "legalName":
      return Boolean(state.legalName && state.legalName.trim() !== "");
    case "taxId":
      return Boolean(state.taxId && state.taxId.trim() !== "");
    case "sector":
      return Boolean(state.sector && state.sector.trim() !== "");
    case "team":
      return state.teamInvited === true;
    case "document":
      return state.firstDocumentUploaded === true;
    default: {
      const exhaustive: never = field;
      throw new Error(`campo de onboarding desconocido: ${String(exhaustive)}`);
    }
  }
}

/** Pura, determinista, sin efectos secundarios: la GUARDA del patrón #7 vive aquí. */
export function computeOnboardingProgress(state: OnboardingKnownState): OnboardingProgress {
  const missingRequired = REQUIRED_ONBOARDING_FIELDS.filter((field) => !isFieldKnown(field, state));
  const missingOptional = OPTIONAL_ONBOARDING_FIELDS.filter((field) => !isFieldKnown(field, state));
  return { missingRequired, missingOptional, isComplete: missingRequired.length === 0 };
}

/** Siguiente campo a preguntar: el primer obligatorio faltante, si no hay ninguno el primer opcional faltante, si no hay ninguno `null` (onboarding listo). */
export function pickNextOnboardingField(state: OnboardingKnownState): OnboardingFieldId | null {
  const progress = computeOnboardingProgress(state);
  return progress.missingRequired[0] ?? progress.missingOptional[0] ?? null;
}

/**
 * Texto canónico por campo -- la fuente de verdad de QUÉ se pregunta.
 * Nunca se descarta: es el resultado por defecto (`source: "canned"`) y el
 * fallback ante cualquier fallo/ausencia del `LLMProvider`.
 */
export const ONBOARDING_FIELD_QUESTIONS: Record<OnboardingFieldId, string> = {
  organization: "¿Cómo se llama tu organización?",
  legalName: "¿Cuál es la razón social completa de tu empresa?",
  taxId: "¿Cuál es tu RFC?",
  sector: "¿A qué giro o sector se dedica tu empresa? Por ejemplo: Construcción, TI, Consultoría.",
  team: "¿Quieres invitar ya a alguien más de tu equipo? Dime su correo y el rol, o dime que lo harás después.",
  document: "¿Quieres subir ya tu primer documento, por ejemplo tu constancia de situación fiscal? También puedes hacerlo después.",
};

const ONBOARDING_READY_TEXT =
  "Tu organización está lista: organización, RFC y giro ya quedaron capturados. Puedes invitar a tu equipo o subir tu primer documento cuando quieras, ninguno de los dos es obligatorio.";

/**
 * FakeProvider (packages/agents/src/llm/fake-provider.ts) sin script propio
 * responde con este prefijo -- es la señal de "no hay proveedor real
 * configurado" (sin OPENAI_API_KEY, ver README §Pendientes). Nunca se
 * muestra esa cadena a una persona real: se descarta y se usa el texto
 * canónico.
 */
const FAKE_PROVIDER_MARKER = "[fake:";

export interface OnboardingQuestion {
  field: OnboardingFieldId | null;
  isComplete: boolean;
  missingRequired: OnboardingFieldId[];
  missingOptional: OnboardingFieldId[];
  /** Pregunta en lenguaje natural para mostrar a la persona usuaria. */
  text: string;
  /** `"llm"` cuando el proveedor configurado SÍ redactó el texto; `"canned"` cuando se usó el texto canónico (sin proveedor real, fallo del proveedor, o ya no falta ningún campo). */
  source: "llm" | "canned";
}

/**
 * Prompt DETERMINISTA: el código ya decidió qué campo preguntar
 * (`pickNextOnboardingField`) y cuál es la pregunta canónica -- el modelo
 * solo puede parafrasearla en un tono más conversacional, nunca inventar
 * un campo distinto ni añadir preguntas nuevas. El `system` message se lo
 * deja explícito.
 */
function buildPhrasingPrompt(field: OnboardingFieldId, canned: string, state: OnboardingKnownState): LLMMessage[] {
  const known: string[] = [];
  if (state.hasOrganization) known.push("ya tiene una organización creada");
  if (state.legalName) known.push(`razón social: ${state.legalName}`);
  if (state.taxId) known.push("RFC ya capturado");
  if (state.sector) known.push(`giro: ${state.sector}`);
  return [
    {
      role: "system",
      content:
        "Eres el asistente de bienvenida de Atiende Licitaciones. Tu ÚNICA tarea es reformular, en 1-2 frases, cálidas y breves, la siguiente pregunta -- sin cambiar su significado, sin pedir ningún dato adicional, sin inventar información de la organización que no se te haya dado. Responde solo con la pregunta, sin comillas ni explicación.",
    },
    {
      role: "user",
      content: `Pregunta a reformular (campo: ${field}): "${canned}"${
        known.length > 0 ? `\nYa se sabe: ${known.join("; ")}.` : ""
      }`,
    },
  ];
}

/**
 * Decide el siguiente turno de la conversación. La decisión de QUÉ falta y
 * si el onboarding ya está `isComplete` es 100% determinista
 * (`computeOnboardingProgress`, calculada ANTES de tocar `provider` y
 * devuelta sin modificar); el `LLMProvider` solo puede cambiar `text`/
 * `source`, y únicamente cuando responde con contenido real -- un fallo del
 * proveedor (red, credenciales, excepción) o una respuesta vacía/del
 * `FakeProvider` por defecto nunca rompe el turno: se degrada al texto
 * canónico, igual de estricto que el wizard actual.
 */
export async function nextOnboardingQuestion(
  provider: LLMProvider,
  state: OnboardingKnownState,
  tier: ModelTier = "economico",
): Promise<OnboardingQuestion> {
  const progress = computeOnboardingProgress(state);
  const field = progress.missingRequired[0] ?? progress.missingOptional[0] ?? null;

  if (!field) {
    return {
      field: null,
      isComplete: progress.isComplete,
      missingRequired: progress.missingRequired,
      missingOptional: progress.missingOptional,
      text: ONBOARDING_READY_TEXT,
      source: "canned",
    };
  }

  const canned = ONBOARDING_FIELD_QUESTIONS[field];
  let text = canned;
  let source: "llm" | "canned" = "canned";
  try {
    const result = await provider.complete({
      model: "asistente-onboarding",
      tier,
      messages: buildPhrasingPrompt(field, canned, state),
    });
    const content = result.content?.trim();
    if (content && !content.startsWith(FAKE_PROVIDER_MARKER)) {
      text = content;
      source = "llm";
    }
  } catch {
    // Nunca rompe el turno por un fallo del proveedor -- se queda con el texto canónico.
  }

  return {
    field,
    isComplete: progress.isComplete,
    missingRequired: progress.missingRequired,
    missingOptional: progress.missingOptional,
    text,
    source,
  };
}
