/**
 * Plazo de pago tras verificación de factura: 17 días HÁBILES (LAASSP nueva,
 * Art. 73 -- vigente desde su publicación en DOF el 16-abr-2025, vigor
 * 17-abr-2025), NO 20 días naturales (LAASSP 2000 Art. 51, norma abrogada
 * para procedimientos iniciados/publicados en o después de esa fecha).
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
 *
 * AE-09 (docs/auditoria-2/api-expediente.md, MEDIA): esta limitación del
 * calendario NUNCA se advertía en la RESPUESTA de la API (solo en
 * comentarios de código y README, invisibles para cualquier cliente/UI que
 * consuma el JSON) -- ver `CALENDAR_LIMITATION_NOTE`, expuesta ahora como
 * `calendarNote` en `POST/GET /post-award`. Tampoco se versionaba el
 * régimen legal aplicable según la fecha de la convocatoria (REQ-050): esta
 * regla siempre aplicaba la ley nueva (17 días hábiles) sin importar cuándo
 * se publicó la convocatoria -- ver `resolvePaymentLegalRegime`, expuesta
 * como `legalRegime`.
 */

/** "Día hábil"/"día natural" del calendario de ESTA ronda excluye únicamente sábado y domingo; no hay lista de feriados oficiales mexicanos codificada (ver docstring del módulo). Expuesto en la respuesta de la API para que ningún cliente asuma un calendario oficial completo. */
export const CALENDAR_LIMITATION_NOTE = 'solo excluye sábados y domingos; días inhábiles oficiales pendientes';

export const LAASSP_ART_73_PAYMENT_TERM_BUSINESS_DAYS = 17;
export const LAASSP_ART_73_LEGAL_REFERENCE =
  'LAASSP nueva, Art. 73 (DOF 16-abr-2025, vigor 17-abr-2025): pago dentro de los 17 días hábiles siguientes a la verificación de la factura. Ver docs/legal/verificacion-legal.md (fila REQ-105) y docs/DECISIONES.md D-07.';

/** REQ-050: fecha en que entró en vigor la LAASSP nueva (DOF 16-abr-2025, vigor 17-abr-2025) -- procedimientos cuya convocatoria se publicó ANTES de esta fecha se rigen por la ley abrogada (LAASSP 2000, Art. 51: 20 días NATURALES), por disposición transitoria (ver docs/legal/verificacion-legal.md). */
export const LAASSP_NUEVA_VIGOR_DATE = '2025-04-17';
export const LAASSP_NUEVA_DOF_DATE = '2025-04-16';

export const LAASSP_2000_ART_51_PAYMENT_TERM_NATURAL_DAYS = 20;
export const LAASSP_2000_ART_51_LEGAL_REFERENCE =
  'LAASSP 2000 (abrogada), Art. 51: pago dentro de los 20 días naturales siguientes a la verificación de la factura. Aplica únicamente a procedimientos cuya convocatoria se publicó ANTES del 17-abr-2025 (vigor de la ley nueva), por disposición transitoria. Ver docs/legal/verificacion-legal.md (fila REQ-105).';

export interface LegalRegime {
  /** "LAASSP nueva" (Art. 73, 17 días hábiles) o "LAASSP 2000 (abrogada)" (Art. 51, 20 días naturales). */
  law: string;
  article: string;
  /** Fecha de publicación en el DOF del régimen vigente aplicado (Diario Oficial de la Federación). */
  dofDate: string;
  /** Fecha en que ese régimen entró en vigor. */
  effectiveDate: string;
  unit: 'dias_habiles' | 'dias_naturales';
  days: number;
  /** Explica por qué se eligió este régimen (fecha de convocatoria vs. fecha de vigor), para trazabilidad. */
  reason: string;
}

/**
 * REQ-050: decide el régimen legal aplicable (LAASSP nueva vs. LAASSP 2000
 * abrogada) según la fecha de PUBLICACIÓN de la convocatoria (nunca "hoy"):
 * los procedimientos iniciados antes del 17-abr-2025 siguen rigiéndose por
 * la ley anterior (disposición transitoria), aunque el pago se verifique
 * después. Sin fecha de convocatoria conocida, se usa por defecto el
 * régimen VIGENTE hoy (LAASSP nueva) -- nunca se asume retroactivamente la
 * ley abrogada sin evidencia de que la convocatoria sea anterior.
 */
export function resolvePaymentLegalRegime(tenderPublishedAtIso: string | null | undefined): LegalRegime {
  const publishedAt = tenderPublishedAtIso ? new Date(tenderPublishedAtIso) : null;
  const isPreReform = publishedAt !== null && !Number.isNaN(publishedAt.getTime()) && publishedAt.getTime() < new Date(`${LAASSP_NUEVA_VIGOR_DATE}T00:00:00Z`).getTime();

  if (isPreReform) {
    return {
      law: 'LAASSP 2000 (abrogada)',
      article: 'Art. 51',
      dofDate: '2000-01-04',
      effectiveDate: '2000-01-04',
      unit: 'dias_naturales',
      days: LAASSP_2000_ART_51_PAYMENT_TERM_NATURAL_DAYS,
      reason: `la convocatoria se publicó el ${tenderPublishedAtIso} (antes del ${LAASSP_NUEVA_VIGOR_DATE}, vigor de la LAASSP nueva) -- por disposición transitoria, este procedimiento sigue rigiéndose por la ley abrogada.`,
    };
  }

  return {
    law: 'LAASSP nueva',
    article: 'Art. 73',
    dofDate: LAASSP_NUEVA_DOF_DATE,
    effectiveDate: LAASSP_NUEVA_VIGOR_DATE,
    unit: 'dias_habiles',
    days: LAASSP_ART_73_PAYMENT_TERM_BUSINESS_DAYS,
    reason:
      tenderPublishedAtIso == null
        ? `fecha de publicación de la convocatoria desconocida -- se usa por defecto el régimen VIGENTE hoy (LAASSP nueva), nunca la ley abrogada sin evidencia de que la convocatoria sea anterior al ${LAASSP_NUEVA_VIGOR_DATE}.`
        : `la convocatoria se publicó el ${tenderPublishedAtIso} (en o después del ${LAASSP_NUEVA_VIGOR_DATE}, vigor de la LAASSP nueva).`,
  };
}

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function toDateOnlyKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDateOnly(startIsoDate: string): Date {
  const cursor = new Date(`${startIsoDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime())) {
    throw new Error(`startIsoDate inválida: "${startIsoDate}"`);
  }
  return cursor;
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
  const cursor = parseDateOnly(startIsoDate);
  let remaining = businessDays;
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (!isWeekend(cursor) && !holidaySet.has(toDateOnlyKey(cursor))) {
      remaining -= 1;
    }
  }
  return toDateOnlyKey(cursor);
}

/** Suma `naturalDays` días de calendario (sin excluir fines de semana ni feriados) -- usado por el régimen abrogado (LAASSP 2000, Art. 51). */
export function addNaturalDays(startIsoDate: string, naturalDays: number): string {
  if (!Number.isInteger(naturalDays) || naturalDays < 0) {
    throw new Error(`naturalDays debe ser un entero >= 0: ${naturalDays}`);
  }
  const cursor = parseDateOnly(startIsoDate);
  cursor.setUTCDate(cursor.getUTCDate() + naturalDays);
  return toDateOnlyKey(cursor);
}

export interface PaymentDeadlineResult {
  dueDate: string;
  businessDays: number;
  legalReference: string;
  /** AE-09: advertencia explícita de la limitación del calendario usado, para incluir en la respuesta de la API. */
  calendarNote: string;
  /** REQ-050/AE-09: régimen legal aplicado (versionado por fecha de convocatoria), para incluir en la respuesta de la API. */
  legalRegime: LegalRegime;
}

/**
 * Calcula la fecha límite de pago. REQ-050: el régimen (17 días hábiles vs.
 * 20 días naturales) se decide según `tenderPublishedAtIso` (fecha de
 * publicación de la convocatoria), nunca fijo a la regla nueva. `holidays`
 * solo aplica al régimen de días HÁBILES (el régimen de días naturales no
 * excluye ningún día).
 */
export function computePaymentDeadline(
  invoiceVerifiedOnIsoDate: string,
  tenderPublishedAtIso: string | null | undefined = undefined,
  holidays: readonly string[] = []
): PaymentDeadlineResult {
  const legalRegime = resolvePaymentLegalRegime(tenderPublishedAtIso);
  const dueDate =
    legalRegime.unit === 'dias_habiles'
      ? addBusinessDays(invoiceVerifiedOnIsoDate, legalRegime.days, holidays)
      : addNaturalDays(invoiceVerifiedOnIsoDate, legalRegime.days);
  return {
    dueDate,
    businessDays: legalRegime.unit === 'dias_habiles' ? legalRegime.days : 0,
    legalReference: legalRegime.unit === 'dias_habiles' ? LAASSP_ART_73_LEGAL_REFERENCE : LAASSP_2000_ART_51_LEGAL_REFERENCE,
    calendarNote: CALENDAR_LIMITATION_NOTE,
    legalRegime,
  };
}
