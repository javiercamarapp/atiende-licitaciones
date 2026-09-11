import { z } from 'zod';

// ---------------------------------------------------------------------------
// voice_agent_config (singleton por organización) -- ver routes.ts para el
// esqueleto honesto completo de la integración con ElevenLabs.
// ---------------------------------------------------------------------------
export const voiceConfigPatchSchema = z
  .object({
    elevenlabsAgentId: z.string().trim().min(1).max(200).nullable().optional(),
    habilitado: z.boolean().optional(),
  })
  .strict();
export type VoiceConfigPatch = z.infer<typeof voiceConfigPatchSchema>;

export const voiceConfigSchema = z.object({
  elevenlabsAgentId: z.string().nullable(),
  toolWebhookSecret: z.string(),
  habilitado: z.boolean(),
  webhookUrls: z.record(z.string(), z.string()),
  disclosureMessage: z.string(),
  respuestaFijaEsHumano: z.string(),
});

export const voiceSecretRotationSchema = z.object({ toolWebhookSecret: z.string() });

// ---------------------------------------------------------------------------
// Catálogo CERRADO de tools de voz (REQ-092: "solo consultas y
// recordatorios") -- ver routes.ts VOZ_TOOL_NAMES para la única fuente de
// verdad en runtime; este enum es solo para tipar el schema/documentación.
// ---------------------------------------------------------------------------
export const VOZ_TOOL_PARAM_SCHEMAS = {
  'listar-convocatorias': z.object({
    status: z
      .enum(['discovered', 'in_review', 'go', 'no_go', 'in_progress', 'submitted', 'won', 'lost', 'cancelled'])
      .optional(),
    limit: z.number().int().positive().max(20).optional(),
  }),
  'leer-bases': z.object({ tenderId: z.string().uuid() }),
  'leer-perfil-empresa': z.object({}),
  'resumir-cambios-convocatoria': z.object({ tenderId: z.string().uuid() }),
  'programar-recordatorio': z.object({
    tenderId: z.string().uuid(),
    kind: z.enum(['vencimiento', 'cambio_bases', 'otro']),
    scheduledFor: z.string().datetime(),
    message: z.string().min(1).max(500),
  }),
} as const;

export type VozToolName = keyof typeof VOZ_TOOL_PARAM_SCHEMAS;
export const VOZ_TOOL_NAMES = Object.keys(VOZ_TOOL_PARAM_SCHEMAS) as VozToolName[];
