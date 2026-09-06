/**
 * Utilidades de fecha compartidas por los adaptadores de `@atiende/expediente`
 * sobre `packages/db`. `@atiende/expediente` exige offset horario EXPLÍCITO
 * en toda fecha (`assertExplicitOffset`, ver packages/expediente/src/types.ts)
 * -- nunca acepta una fecha "naive". Las columnas `date` de Postgres (sin
 * hora, p.ej. `valid_until`) se anclan aquí a America/Mexico_City
 * (offset fijo `-06:00`; México no tiene horario de verano nacional desde
 * 2022) en el borde que corresponda: "end" para vigencias/plazos (vigente
 * HASTA el final de ese día), "start" para inicios de vigencia.
 */

import { ValidationAppError } from '../errors.js';

const MEXICO_CITY_OFFSET = '-06:00';

/** Normaliza un valor de columna `timestamptz`/`date` del driver (Date o string) a "YYYY-MM-DD". */
function datePartOf(value: string | Date): string {
  const iso = value instanceof Date ? value.toISOString() : value;
  const match = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) {
    throw new Error(`Valor de fecha no reconocible: ${JSON.stringify(value)}`);
  }
  return match[1];
}

export function dateOnlyToMexicoCityIso(value: string | Date | null, edge: 'start' | 'end'): string | null {
  if (value === null || value === undefined) return null;
  const datePart = datePartOf(value);
  return edge === 'end' ? `${datePart}T23:59:59${MEXICO_CITY_OFFSET}` : `${datePart}T00:00:00${MEXICO_CITY_OFFSET}`;
}

/** Convierte cualquier `timestamptz` (Date o string ISO) a un string ISO con offset explícito ("Z" si el driver ya lo trae, o tal cual si ya es string ISO con offset). */
export function timestampToIso(value: string | Date | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/** "Ahora" en ISO con offset explícito ("Z"), para usarse como `asOfIso` por defecto cuando no hay fecha límite de convocatoria conocida. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * AE-01 (docs/auditoria-2/api-expediente.md, ALTA): la fecha de evaluación
 * de vigencia de tarifas y documentos de empresa del expediente ("¿es
 * válido A LA FECHA DEL ACTO?", REQ-023) NUNCA la decide el cliente -- un
 * `asOfIso` libre en el cuerpo de la petición permitía "revivir" una
 * tarifa/documento que YA estará vencido para cuando se presente la
 * propuesta, generando la propuesta con un `asOfIso` de un momento en que
 * sí era válido. Se deriva SIEMPRE de `tenders.submission_deadline` (la
 * versión vigente de la convocatoria, ya resuelta por `requireTender`) --
 * el mismo campo que corrige DB-02/DB-10 a nivel de Postgres (migración
 * 0042/0050) para `proposal_pricing_lines`, así que ambas capas quedan
 * coherentes entre sí. Cualquier `asOfIso` que el cliente envíe en el
 * cuerpo se IGNORA por completo (nunca se usa, ni siquiera como techo).
 *
 * Si la convocatoria todavía no tiene `submission_deadline` fijado, NO se
 * usa "ahora" como aproximación (eso reabriría exactamente el patrón que
 * este hallazgo cierra): se bloquea explícitamente con 422, obligando a
 * declarar la fecha límite de presentación antes de generar la propuesta
 * económica/técnica o ejecutar el checklist de integridad.
 */
export function resolveExpedienteAsOfIso(tender: Record<string, unknown>): string {
  const deadline = (tender.submission_deadline ?? null) as string | Date | null;
  const iso = timestampToIso(deadline);
  if (iso === null) {
    throw new ValidationAppError({
      submissionDeadline:
        'fecha de presentación desconocida: esta convocatoria no tiene "submission_deadline" fijado, así que no se puede evaluar de forma segura la vigencia de tarifas/documentos de empresa a la fecha del acto. Declare la fecha límite de presentación de la convocatoria antes de generar la propuesta o ejecutar el checklist.',
    });
  }
  return iso;
}
