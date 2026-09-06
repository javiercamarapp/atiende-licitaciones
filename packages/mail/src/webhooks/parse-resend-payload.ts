import { z } from "zod";
import type { MailWebhookEvent, MailWebhookEventType } from "./types";

const RESEND_TYPE_MAP: Record<string, MailWebhookEventType> = {
  "email.sent": "email.sent",
  "email.delivered": "email.delivered",
  "email.delivery_delayed": "email.delivery_delayed",
  "email.bounced": "email.bounced",
  "email.complained": "email.complained",
};

const ResendWebhookPayloadSchema = z.object({
  type: z.string(),
  created_at: z.string().optional(),
  data: z.object({
    email_id: z.string().optional(),
    to: z.array(z.string()).optional(),
  }),
});

/**
 * Traduce el payload real de un webhook de Resend
 * (`{type, created_at, data: {email_id, to: [...]}}`) al tipo interno
 * `MailWebhookEvent`. Devuelve `null` ante un tipo de evento que no nos
 * interesa (Resend manda más de los cinco que este paquete modela) o un
 * payload que no cumple la forma mínima esperada — nunca lanza: un webhook
 * mal formado no debe tumbar el endpoint que lo recibe.
 */
export function parseResendWebhookPayload(json: unknown): MailWebhookEvent | null {
  const parsed = ResendWebhookPayloadSchema.safeParse(json);
  if (!parsed.success) return null;
  const type = RESEND_TYPE_MAP[parsed.data.type];
  if (!type) return null;
  const email = parsed.data.data.to?.[0];
  if (!email) return null;
  return {
    type,
    email,
    providerMessageId: parsed.data.data.email_id,
    occurredAt: parsed.data.created_at ?? new Date().toISOString(),
    raw: json,
  };
}
