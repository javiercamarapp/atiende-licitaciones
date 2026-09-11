/**
 * Handshake REAL de suscripción de webhook de Meta: al registrar la URL del
 * webhook en el panel de la app, Meta manda un `GET` con
 * `?hub.mode=subscribe&hub.verify_token=<lo que Javier haya puesto en el
 * panel>&hub.challenge=<número aleatorio>` — el endpoint debe responder
 * `200` con el `hub.challenge` tal cual, en texto plano, SOLO si el
 * `hub.verify_token` coincide con el que configuramos. Sin este paso Meta
 * nunca activa el webhook, así que es parte necesaria del contrato aunque
 * no mande ningún mensaje.
 *
 * Puro: no toca red ni Fastify — `apps/api` es quien expone
 * `GET /webhooks/whatsapp` usando esto.
 */
export function resolveWebhookSubscriptionChallenge(
  query: { "hub.mode"?: string; "hub.verify_token"?: string; "hub.challenge"?: string },
  expectedVerifyToken: string | undefined
): { ok: true; challenge: string } | { ok: false } {
  if (!expectedVerifyToken) return { ok: false };
  if (query["hub.mode"] !== "subscribe") return { ok: false };
  if (query["hub.verify_token"] !== expectedVerifyToken) return { ok: false };
  if (typeof query["hub.challenge"] !== "string" || query["hub.challenge"].length === 0) return { ok: false };
  return { ok: true, challenge: query["hub.challenge"] };
}
