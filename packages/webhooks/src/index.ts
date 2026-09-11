// ─────────────────────────────────────────────────────────────────────────
// @atiende/webhooks — verificación HMAC y deduplicación por `event_id`
// genéricas para CUALQUIER webhook entrante (REQ-096). Ver README.md.
//
// Antes de este paquete, esta lógica solo existía duplicada dentro de
// `@atiende/mail` para el webhook de Resend/Svix. `@atiende/mail` ahora
// consume este paquete (`packages/mail/src/webhooks/verify-signature.ts`)
// en vez de reimplementarla, y `apps/api/src/lib/webhooks/hmac-webhook-guard.ts`
// lo expone como middleware de Fastify listo para cualquier ruta nueva.
// ─────────────────────────────────────────────────────────────────────────

export type { HmacEncoding } from "./hmac";
export { computeHmacDigest, matchesAnyHmacSignature } from "./hmac";

export type { WebhookReplayGuard } from "./replay-guard";
export { InMemoryWebhookReplayGuard } from "./replay-guard";

export type {
  VerifyHmacWebhookInput,
  WebhookVerificationFailureReason,
  WebhookVerificationResult,
} from "./verify";
export { isWithinTolerance, verifyHmacWebhookSignature } from "./verify";
