import { findNoGoReasonBySlug } from './reason-catalog.js';

/**
 * REQ-090: codifica/decodifica el `replyId` (`button.payload` o
 * `interactive.*_reply.id`, ver `@atiende/whatsapp` `WhatsAppInboundInteraction`)
 * que viaja de ida y vuelta por WhatsApp para representar UNA decisión de
 * Go/No-Go concreta. Deliberadamente STATELESS: todo lo que el webhook
 * necesita para actuar (qué convocatoria, qué decisión, qué motivo) va
 * codificado en el propio id -- no hace falta ninguna tabla de "decisiones
 * pendientes" ni sesión de conversación (ver README de `@atiende/whatsapp`
 * para el porqué de no fingir un campo de texto libre; aquí el mismo
 * criterio de "nunca fingir estado que no existe" aplica al revés: no
 * inventar una sesión de servidor donde un id ya basta).
 *
 * Los prefijos (`GO:`, `NOGO:`, `NOGO_REASON:`) son un contrato INTERNO
 * entre este archivo y quien arma los mensajes salientes
 * (`new-tender-match-notify.ts`, `webhook.routes.ts`) -- Meta nunca les da
 * significado, solo los devuelve tal cual.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeGoPayload(tenderId: string): string {
  return `GO:${tenderId}`;
}

export function encodeNoGoPayload(tenderId: string): string {
  return `NOGO:${tenderId}`;
}

export function encodeNoGoReasonRowId(tenderId: string, reasonSlug: string): string {
  return `NOGO_REASON:${tenderId}:${reasonSlug}`;
}

export type DecodedWhatsAppDecisionAction =
  | { kind: 'go'; tenderId: string }
  /** El usuario tocó "No-Go" en la plantilla: todavía NO se persiste nada
   *  -- el webhook debe responder con la lista de motivos (REQ-090:
   *  "decide vía botones/listas", este es el paso que usa lista). */
  | { kind: 'ask_no_go_reason'; tenderId: string }
  | { kind: 'no_go_with_reason'; tenderId: string; reasonSlug: string; reasonLabel: string }
  /** `replyId` no reconocido, mal formado, o con un `tenderId` que no
   *  parece un UUID real, o un slug de motivo que no existe en el
   *  catálogo -- un payload FORJADO (REQ-097) o de una versión anterior de
   *  la plantilla nunca se adivina, se ignora explícitamente. */
  | { kind: 'unrecognized' };

export function decodeWhatsAppDecisionReplyId(replyId: string): DecodedWhatsAppDecisionAction {
  const parts = replyId.split(':');

  if (parts.length === 2 && parts[0] === 'GO' && UUID_RE.test(parts[1]!)) {
    return { kind: 'go', tenderId: parts[1]! };
  }
  if (parts.length === 2 && parts[0] === 'NOGO' && UUID_RE.test(parts[1]!)) {
    return { kind: 'ask_no_go_reason', tenderId: parts[1]! };
  }
  if (parts.length === 3 && parts[0] === 'NOGO_REASON' && UUID_RE.test(parts[1]!)) {
    const reason = findNoGoReasonBySlug(parts[2]!);
    if (reason) {
      return { kind: 'no_go_with_reason', tenderId: parts[1]!, reasonSlug: reason.slug, reasonLabel: reason.label };
    }
  }
  return { kind: 'unrecognized' };
}
