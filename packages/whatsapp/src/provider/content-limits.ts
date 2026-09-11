import type { OutboundInteractiveListMessage } from "./types";

/**
 * REQ-080: "Límite de 3 botones y listas de 10 opciones en mensajes de
 * WhatsApp (límite de la API)" — estos NO son números de producto, son
 * límites REALES de la Cloud API de Meta para WhatsApp Business (botones de
 * respuesta rápida y mensajes interactivos de lista): un payload que los
 * exceda Meta lo rechaza con un 4xx. Validar aquí, ANTES de intentar la red,
 * convierte ese 4xx tardío en un fallo inmediato, explícito y con el mismo
 * criterio para cualquier proveedor (`CaptureProvider` o
 * `MetaCloudProvider`) — es el "contrato de contenido de mensajes" que pide
 * el criterio de aceptación de REQ-080.
 */
export const MAX_QUICK_REPLY_BUTTONS = 3;
export const MAX_LIST_ROWS_TOTAL = 10;
/** Límite real de Meta para el texto de un botón de respuesta rápida. */
export const MAX_BUTTON_TITLE_LENGTH = 20;
/** Límite real de Meta para el título de una fila de lista. */
export const MAX_LIST_ROW_TITLE_LENGTH = 24;
/** Límite real de Meta para la descripción de una fila de lista. */
export const MAX_LIST_ROW_DESCRIPTION_LENGTH = 72;
/** Límite real de Meta para el texto del botón que despliega la lista. */
export const MAX_LIST_BUTTON_TEXT_LENGTH = 20;

export type ContentLimitResult = { ok: true } | { ok: false; detail: string };

/** Valida `OutboundWhatsAppMessage.buttonPayloads` (botones de respuesta rápida sobre una plantilla). */
export function validateButtonPayloads(buttonPayloads: string[] | undefined): ContentLimitResult {
  if (!buttonPayloads || buttonPayloads.length === 0) return { ok: true };
  if (buttonPayloads.length > MAX_QUICK_REPLY_BUTTONS) {
    return {
      ok: false,
      detail: `Se pidieron ${buttonPayloads.length} botones de respuesta rápida; la API de WhatsApp permite un máximo de ${MAX_QUICK_REPLY_BUTTONS} (REQ-080).`,
    };
  }
  const vacio = buttonPayloads.find((p) => p.trim().length === 0);
  if (vacio !== undefined) {
    return { ok: false, detail: "Un payload de botón de respuesta rápida no puede ser una cadena vacía." };
  }
  return { ok: true };
}

/** Valida un mensaje interactivo de lista completo (REQ-080: máx. 10 filas EN TOTAL, sumando todas las secciones). */
export function validateInteractiveListMessage(message: OutboundInteractiveListMessage): ContentLimitResult {
  if (message.sections.length === 0) {
    return { ok: false, detail: "Un mensaje de lista necesita al menos una sección con al menos una fila." };
  }
  const totalRows = message.sections.reduce((acc, s) => acc + s.rows.length, 0);
  if (totalRows === 0) {
    return { ok: false, detail: "Un mensaje de lista necesita al menos una fila." };
  }
  if (totalRows > MAX_LIST_ROWS_TOTAL) {
    return {
      ok: false,
      detail: `La lista tiene ${totalRows} filas en total; la API de WhatsApp permite un máximo de ${MAX_LIST_ROWS_TOTAL} (REQ-080).`,
    };
  }
  if (message.buttonText.length > MAX_LIST_BUTTON_TEXT_LENGTH) {
    return { ok: false, detail: `El texto del botón de la lista excede ${MAX_LIST_BUTTON_TEXT_LENGTH} caracteres.` };
  }
  const ids = new Set<string>();
  for (const section of message.sections) {
    for (const row of section.rows) {
      if (row.title.length > MAX_LIST_ROW_TITLE_LENGTH) {
        return { ok: false, detail: `El título de fila "${row.title}" excede ${MAX_LIST_ROW_TITLE_LENGTH} caracteres.` };
      }
      if (row.description && row.description.length > MAX_LIST_ROW_DESCRIPTION_LENGTH) {
        return { ok: false, detail: `La descripción de la fila "${row.id}" excede ${MAX_LIST_ROW_DESCRIPTION_LENGTH} caracteres.` };
      }
      if (ids.has(row.id)) {
        return { ok: false, detail: `El id de fila "${row.id}" está repetido dentro de la misma lista.` };
      }
      ids.add(row.id);
    }
  }
  return { ok: true };
}
