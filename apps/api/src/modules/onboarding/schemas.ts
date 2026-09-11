import { z } from 'zod';

/**
 * Patrón Likida/atiende.ai #7 (onboarding conversacional con guardas
 * deterministas) -- ver `routes.ts`.
 */

const onboardingFieldEnum = z.enum(['organization', 'legalName', 'taxId', 'sector', 'team', 'document']);

export const onboardingNextActionSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT']),
    path: z.string(),
    /** Frase corta explicando qué endpoint ya existente resuelve este campo -- la capa conversacional reutiliza los mismos endpoints del wizard, nunca los duplica. */
    hint: z.string(),
  })
  .nullable();

export const onboardingStateSchema = z.object({
  orgId: z.string().uuid().nullable(),
  hasOrganization: z.boolean(),
  legalName: z.string().nullable(),
  taxId: z.string().nullable(),
  sector: z.string().nullable(),
  teamInvited: z.boolean(),
  firstDocumentUploaded: z.boolean(),
  missingRequired: z.array(onboardingFieldEnum),
  missingOptional: z.array(onboardingFieldEnum),
  /** GUARDA DETERMINISTA (packages/agents/src/onboarding.ts): `true` solo cuando `missingRequired` está vacío -- nunca decidido por el LLM. */
  isComplete: z.boolean(),
  nextField: onboardingFieldEnum.nullable(),
  question: z.string(),
  /** `"llm"` cuando el proveedor configurado redactó el texto; `"canned"` cuando se usó el texto canónico (sin OPENAI_API_KEY, fallo del proveedor, o ya no falta nada). */
  questionSource: z.enum(['llm', 'canned']),
  nextAction: onboardingNextActionSchema,
});

export type OnboardingStateResponse = z.infer<typeof onboardingStateSchema>;
