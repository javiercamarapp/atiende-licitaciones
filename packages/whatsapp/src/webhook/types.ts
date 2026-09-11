/**
 * Un evento de DECISIÓN entrante ya normalizado — el resultado de que
 * alguien haya tocado un botón o elegido una fila de lista en WhatsApp.
 * `parseWhatsAppWebhookPayload` (`./parse-payload.ts`) es la única función
 * que produce estos valores a partir del payload crudo de Meta; todo lo que
 * no sea una interacción de decisión (texto libre, imágenes, recibos de
 * entrega/lectura en `value.statuses`, etc.) se descarta ahí mismo — este
 * paquete no modela WhatsApp como un canal de chat general, solo como el
 * mecanismo de decisión que pide REQ-090.
 */
export type WhatsAppInboundInteractionKind =
  /** `messages[].type === "button"`: el usuario tocó un botón `QUICK_REPLY`
   *  de una PLANTILLA que nosotros mandamos (`OutboundWhatsAppMessage.buttonPayloads`). */
  | "template_quick_reply"
  /** `messages[].type === "interactive"` con `interactive.type === "button_reply"`:
   *  un botón de un mensaje interactivo LIBRE (dentro de la ventana de 24h). */
  | "interactive_button_reply"
  /** `messages[].type === "interactive"` con `interactive.type === "list_reply"`:
   *  una fila elegida de un `OutboundInteractiveListMessage`. */
  | "interactive_list_reply";

export interface WhatsAppInboundInteraction {
  /** Id único del mensaje de Meta (`messages[].id`, el "wamid") — clave de
   *  deduplicación real para REQ-074. Globalmente único y permanente: nunca
   *  se reutiliza, así que la deduplicación no necesita ventana de tiempo. */
  wamid: string;
  /** Número del remitente, tal como lo manda Meta: SIN el signo `+`
   *  (p. ej. `"525512345678"`) — usar `toE164FromMetaPhone` antes de
   *  comparar contra `users.whatsapp_phone_e164`, que sí lo lleva. */
  from: string;
  /** `messages[].timestamp` de Meta: epoch en SEGUNDOS, como cadena. */
  timestampSeconds: string;
  kind: WhatsAppInboundInteractionKind;
  /** El identificador de la opción elegida — `button.payload` o
   *  `interactive.button_reply.id`/`interactive.list_reply.id` según
   *  `kind`. Quien arma el mensaje saliente decide qué codifica aquí (ver
   *  `apps/api/src/lib/whatsapp/decision-payload.ts`); este paquete nunca
   *  le da significado de negocio. */
  replyId: string;
  /** El texto visible del botón/fila elegido — solo para logs/depuración,
   *  nunca para decidir nada (el `replyId` es la única fuente de verdad). */
  replyTitle: string;
  /** El mensaje completo tal como llegó, para auditoría. */
  raw: unknown;
}

/** `+` seguido del número que manda Meta — inverso de `toMetaPhoneFormat`
 *  (`../provider/meta-cloud-provider.ts`), para poder comparar contra
 *  `users.whatsapp_phone_e164` (E.164 con `+`). */
export function toE164FromMetaPhone(metaPhone: string): string {
  return metaPhone.startsWith("+") ? metaPhone : `+${metaPhone}`;
}
