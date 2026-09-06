/**
 * Plazo de pago tras verificación de factura: 17 días HÁBILES (LAASSP nueva,
 * Art. 73 -- vigente desde su publicación en DOF el 16-abr-2025, vigor
 * 17-abr-2025), NO 20 días naturales (LAASSP 2000 Art. 51, norma abrogada).
 * Fuente verificada puntualmente: `docs/legal/verificacion-legal.md`
 * (fila REQ-105) y `docs/DECISIONES.md` D-07. Este módulo NO es asesoría
 * jurídica; es una regla CONFIGURABLE (parámetro `businessDays`, con el
 * valor legal vigente como default) con su fuente citada explícitamente en
 * cada resultado, para que el back office pueda auditar de dónde sale la
 * fecha -- nunca un número "mágico" sin trazabilidad.
 *
 * "Día hábil" aquí = lunes a viernes, excluyendo los días feriados
 * oficiales mexicanos que el llamador declare explícitamente en
 * `holidays` (no se codifica un calendario oficial completo en esta
 * ronda: sin lista de feriados, el cálculo solo excluye sábados/domingos,
 * lo cual es una aproximación documentada, no la fuente legal completa del
 * calendario oficial de días inhábiles).
 */

export const LAASSP_ART_73_PAYMENT_TERM_BUSINESS_DAYS = 17;
export const LAASSP_ART_73_LEGAL_REFERENCE =
  'LAASSP nueva, Art. 73 (DOF 16-abr-2025, vigor 17-abr-2025): pago dentro de los 17 días hábiles siguientes a la verificación de la factura. Ver docs/legal/verificacion-legal.md (fila REQ-105) y docs/DECISIONES.md D-07.';

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function toDateOnlyKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Suma `businessDays` días hábiles a `startIsoDate` (fecha, sin hora;
 * interpretada en UTC para evitar deriva por zona horaria del proceso).
 * `holidays` es un arreglo opcional de fechas "YYYY-MM-DD" a excluir además
 * de sábados/domingos.
 */
export function addBusinessDays(startIsoDate: string, businessDays: number, holidays: readonly string[] = []): string {
  if (!Number.isInteger(businessDays) || businessDays < 0) {
    throw new Error(`businessDays debe ser un entero >= 0: ${businessDays}`);
  }
  const holidaySet = new Set(holidays);
  const cursor = new Date(`${startIsoDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime())) {
    throw new Error(`startIsoDate inválida: "${startIsoDate}"`);
  }
  let remaining = businessDays;
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (!isWeekend(cursor) && !holidaySet.has(toDateOnlyKey(cursor))) {
      remaining -= 1;
    }
  }
  return toDateOnlyKey(cursor);
}

export interface PaymentDeadlineResult {
  dueDate: string;
  businessDays: number;
  legalReference: string;
}

/** Calcula la fecha límite de pago (por defecto, la regla vigente: 17 días hábiles, Art. 73 LAASSP). */
export function computePaymentDeadline(
  invoiceVerifiedOnIsoDate: string,
  businessDays: number = LAASSP_ART_73_PAYMENT_TERM_BUSINESS_DAYS,
  holidays: readonly string[] = []
): PaymentDeadlineResult {
  return {
    dueDate: addBusinessDays(invoiceVerifiedOnIsoDate, businessDays, holidays),
    businessDays,
    legalReference: LAASSP_ART_73_LEGAL_REFERENCE,
  };
}
