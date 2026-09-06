/**
 * Eventos de entrega que un proveedor manda por webhook. El nombrado sigue
 * el de los eventos reales de Resend (`email.*`); un adaptador de Postmark
 * (`SubscriptionChange`/`Bounce`) se traduce a este mismo tipo antes de
 * llamar a `applyMailWebhookEvent` — un solo punto de decisión sin importar
 * el proveedor.
 */
export type MailWebhookEventType =
  | "email.sent"
  | "email.delivered"
  | "email.delivery_delayed"
  | "email.bounced"
  | "email.complained";

export interface MailWebhookEvent {
  type: MailWebhookEventType;
  email: string;
  providerMessageId?: string;
  occurredAt: string;
  /** El payload original, para auditoría/depuración — nunca se usa para
   *  decidir nada más allá de `type`/`email`. */
  raw?: unknown;
}
