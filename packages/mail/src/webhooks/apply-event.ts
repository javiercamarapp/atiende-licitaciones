import type { SuppressionStore } from "../suppression/types";
import type { MailWebhookEvent } from "./types";

/**
 * El efecto de negocio de un evento de entrega: un rebote o una queja
 * suprime la dirección automáticamente — el mismo disparo que
 * `POST /api/correo/eventos` de Likida documenta (§2.2). El resto de los
 * eventos (`sent`/`delivered`/`delivery_delayed`) son informativos y no
 * cambian nada aquí; quien llama puede loguearlos aparte.
 */
export async function applyMailWebhookEvent(event: MailWebhookEvent, suppressionStore: SuppressionStore, source: string): Promise<void> {
  if (event.type === "email.bounced") {
    await suppressionStore.suppress(event.email, "bounce", source);
  } else if (event.type === "email.complained") {
    await suppressionStore.suppress(event.email, "complaint", source);
  }
}
