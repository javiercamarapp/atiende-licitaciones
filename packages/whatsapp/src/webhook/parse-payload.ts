import type { WhatsAppInboundInteraction } from "./types";

/**
 * Traduce el payload CRUDO (ya con firma verificada, ver `./verify-signature.ts`)
 * que Meta manda a `POST /webhooks/whatsapp` a una lista de
 * `WhatsAppInboundInteraction` — ver `./types.ts` para el porqué de
 * modelar SOLO interacciones de decisión.
 *
 * Forma real del payload de Meta (Cloud API, webhooks de `messages`):
 * ```
 * { object: "whatsapp_business_account",
 *   entry: [{ id, changes: [{ field: "messages", value: {
 *     messaging_product, metadata, contacts, messages: [...], statuses: [...]
 *   }}]}]}
 * ```
 * Un solo POST puede traer VARIOS `entry`/`changes`/`messages` a la vez
 * (Meta agrupa entregas). `value.statuses` (recibos de entrega/lectura de
 * NUESTROS mensajes salientes) y cualquier `messages[].type` que no sea de
 * decisión (texto libre, imagen, ubicación, ...) se ignoran en silencio —
 * no son un error, simplemente no aportan nada a REQ-090.
 *
 * DEFENSIVO por diseño (REQ-097, red-teaming de payloads no confiables):
 * cualquier forma inesperada, campo faltante o tipo incorrecto en cualquier
 * nivel produce simplemente MENOS eventos (o ninguno), nunca una excepción
 * — un webhook que llega sin autenticar de Internet no puede tumbar el
 * proceso con un payload deforme.
 */
export function parseWhatsAppWebhookPayload(raw: unknown): WhatsAppInboundInteraction[] {
  const events: WhatsAppInboundInteraction[] = [];
  if (!isRecord(raw) || raw.object !== "whatsapp_business_account") return events;

  const entries = asArray(raw.entry);
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const changes = asArray(entry.changes);
    for (const change of changes) {
      if (!isRecord(change) || change.field !== "messages") continue;
      const value = change.value;
      if (!isRecord(value)) continue;
      const messages = asArray(value.messages);
      for (const message of messages) {
        const event = parseSingleMessage(message);
        if (event) events.push(event);
      }
    }
  }
  return events;
}

function parseSingleMessage(message: unknown): WhatsAppInboundInteraction | null {
  if (!isRecord(message)) return null;
  const wamid = typeof message.id === "string" ? message.id : undefined;
  const from = typeof message.from === "string" ? message.from : undefined;
  const timestampSeconds = typeof message.timestamp === "string" ? message.timestamp : undefined;
  if (!wamid || !from || !timestampSeconds) return null;

  if (message.type === "button" && isRecord(message.button)) {
    const payload = message.button.payload;
    const text = message.button.text;
    if (typeof payload !== "string") return null;
    return {
      wamid,
      from,
      timestampSeconds,
      kind: "template_quick_reply",
      replyId: payload,
      replyTitle: typeof text === "string" ? text : "",
      raw: message,
    };
  }

  if (message.type === "interactive" && isRecord(message.interactive)) {
    const interactive = message.interactive;
    if (interactive.type === "button_reply" && isRecord(interactive.button_reply)) {
      const id = interactive.button_reply.id;
      const title = interactive.button_reply.title;
      if (typeof id !== "string") return null;
      return {
        wamid,
        from,
        timestampSeconds,
        kind: "interactive_button_reply",
        replyId: id,
        replyTitle: typeof title === "string" ? title : "",
        raw: message,
      };
    }
    if (interactive.type === "list_reply" && isRecord(interactive.list_reply)) {
      const id = interactive.list_reply.id;
      const title = interactive.list_reply.title;
      if (typeof id !== "string") return null;
      return {
        wamid,
        from,
        timestampSeconds,
        kind: "interactive_list_reply",
        replyId: id,
        replyTitle: typeof title === "string" ? title : "",
        raw: message,
      };
    }
  }

  // Texto libre, imagen, ubicación, reacción, etc. — no es una decisión.
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
