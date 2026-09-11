import { MAX_LIST_ROW_TITLE_LENGTH } from '@atiende/whatsapp';

/**
 * REQ-090 ("decide vía botones/listas... nunca edita matriz o propuesta
 * desde el chat"): catálogo CERRADO de motivos de No-Go elegibles desde una
 * lista interactiva de WhatsApp. Deliberadamente una lista fija de
 * etiquetas predefinidas, NUNCA texto libre -- el usuario ELIGE una fila
 * (`go_no_go_decisions.reasons` recibe `label`, el motivo completo, nunca
 * `shortLabel`), nunca escribe ni edita nada. Como máximo 8 filas (< 10, el
 * límite real de REQ-080, para dejar margen si se agrega alguna más
 * adelante).
 *
 * `shortLabel` (≤ `MAX_LIST_ROW_TITLE_LENGTH`, REQ-080) es el título visible
 * de la fila en WhatsApp; `label` es el motivo completo que de verdad se
 * guarda en `go_no_go_decisions.reasons` y se manda de vuelta como
 * confirmación (`interactive.list_reply.description` de Meta lo muestra
 * completo al elegir, así el usuario ve el motivo real aunque el título de
 * la fila esté abreviado).
 */
export interface NoGoReason {
  slug: string;
  shortLabel: string;
  label: string;
}

export const NO_GO_REASONS: readonly NoGoReason[] = [
  { slug: 'capacidad_tecnica', shortLabel: 'Capacidad técnica', label: 'Fuera de nuestra capacidad técnica actual' },
  { slug: 'plazo_insuficiente', shortLabel: 'Plazo insuficiente', label: 'Plazo insuficiente para preparar una propuesta de calidad' },
  { slug: 'riesgo_legal', shortLabel: 'Riesgo legal/cumplim.', label: 'Riesgo legal o de cumplimiento identificado' },
  { slug: 'precio_no_competitivo', shortLabel: 'Precio no competitivo', label: 'El precio de referencia no es competitivo para nosotros' },
  { slug: 'duplicado', shortLabel: 'Duplicado en curso', label: 'Duplicado con otra licitación ya en curso' },
  { slug: 'fuera_de_zona', shortLabel: 'Fuera de cobertura', label: 'Fuera de la zona geográfica de cobertura' },
  { slug: 'sin_certificaciones', shortLabel: 'Faltan certificaciones', label: 'No contamos con las certificaciones requeridas' },
  { slug: 'otro', shortLabel: 'Otro motivo', label: 'Otro motivo (sin detalle adicional)' },
];

if (NO_GO_REASONS.some((r) => r.shortLabel.length > MAX_LIST_ROW_TITLE_LENGTH)) {
  // Verificación en tiempo de carga (no solo en un test): un `shortLabel`
  // que exceda el límite real de Meta haría que `sendInteractiveList`
  // rechace la lista COMPLETA en producción -- mejor reventar aquí, al
  // importar el módulo, que descubrirlo cuando alguien intente decidir
  // No-Go por WhatsApp.
  throw new Error('reason-catalog.ts: un shortLabel de NO_GO_REASONS excede MAX_LIST_ROW_TITLE_LENGTH (REQ-080)');
}

export function findNoGoReasonBySlug(slug: string): NoGoReason | undefined {
  return NO_GO_REASONS.find((r) => r.slug === slug);
}
