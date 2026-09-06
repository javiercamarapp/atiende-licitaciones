/**
 * E11 — seguimiento post-adjudicación: hitos, garantías, facturación, y
 * plazo de pago (17 días hábiles, LAASSP Art. 73 -- regla CONFIGURABLE con
 * fuente legal citada, ver `lib/expediente/business-days.ts` y
 * `docs/legal/verificacion-legal.md`). Los recordatorios se ENCOLAN como
 * `jobs` (tabla genérica ya usada por apps/worker) -- esta ruta nunca envía
 * nada, solo inserta la fila; el envío real está fuera de alcance de esta
 * ronda (ver README).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WRITE_ROLES } from '@atiende/db';
import type { DbExecutor } from '@atiende/db';
import { requireOrgRole } from '../../lib/authorize.js';
import { recordAudit } from '../../lib/audit.js';
import { NotFoundError, ValidationAppError } from '../../lib/errors.js';
import { withTx, requireTender } from '../../lib/expediente/context.js';
import { computePaymentDeadline } from '../../lib/expediente/business-days.js';
import { timestampToIso } from '../../lib/expediente/dates.js';
import { followupCreateSchema, followupUpdateSchema, followupSchema } from './schemas.js';

/** Normaliza una columna `date` del driver (Date u "YYYY-MM-DD") a "YYYY-MM-DD" -- el driver (pg/PGlite) puede devolver un `Date` (medianoche LOCAL del proceso, no UTC), así que nunca se usa directamente `String(date)`. */
function toDateOnlyString(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    // El driver (pg/PGlite) construye una columna `date` a medianoche UTC
    // -- se usan getters UTC (nunca locales) para no desplazar un día en
    // zonas horarias detrás de UTC (p. ej. America/Mexico_City, -06:00).
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

/** REQ-056: alerta binaria por día (ver `alertLevel` en schemas.ts). Nunca marca alerta para un seguimiento ya cerrado (done/cancelled). */
function computeAlertLevel(dueDate: string | Date | null | undefined, status: string, reminderLeadDays: number, nowIso = new Date().toISOString()): 'vencido' | 'proximo' | null {
  const dueDateOnly = toDateOnlyString(dueDate);
  if (!dueDateOnly || status === 'done' || status === 'cancelled') return null;
  const due = new Date(`${dueDateOnly}T00:00:00Z`).getTime();
  const now = new Date(nowIso).getTime();
  if (Number.isNaN(due)) return null;
  if (due < now) return 'vencido';
  const leadMs = reminderLeadDays * 24 * 60 * 60 * 1000;
  if (due - now <= leadMs) return 'proximo';
  return null;
}

function mapFollowupRow(r: Record<string, unknown>): any {
  const metadata = (r.metadata as Record<string, unknown> | null) ?? {};
  return {
    id: r.id,
    tenderId: r.tender_id,
    kind: r.kind,
    label: r.label,
    dueDate: r.due_date,
    status: r.status,
    amount: r.amount !== null && r.amount !== undefined ? Number(r.amount) : null,
    notes: r.notes,
    legalReference: r.legal_reference,
    reminderLeadDays: r.reminder_lead_days,
    jobId: r.job_id,
    createdAt: r.created_at,
    responsibleParty: r.responsible_party ?? null,
    guaranteeType: r.guarantee_type ?? null,
    cfdiReference: r.cfdi_reference ?? null,
    acceptanceDate: r.acceptance_date ?? null,
    modificationReference: r.modification_reference ?? null,
    // AE-09: solo presentes para kind='pago'/'facturacion' (ver computePaymentDeadline).
    calendarNote: (metadata.calendarNote as string | undefined) ?? null,
    legalRegime: (metadata.legalRegime as Record<string, unknown> | undefined) ?? null,
    alertLevel: computeAlertLevel(r.due_date as string | Date | null | undefined, String(r.status), Number(r.reminder_lead_days ?? 3)),
  };
}

export async function expedientePostAwardRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/tenders/:tenderId/post-award',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: z.array(followupSchema) } } },
    async (request) => {
      const orgId = request.orgId!;
      const rows = await withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        return (await tx.query<Record<string, unknown>>('select * from post_award_followups where org_id = $1 and tender_id = $2 order by due_date asc nulls last, created_at asc', [orgId, request.params.tenderId])).rows;
      });
      return rows.map(mapFollowupRow);
    }
  );

  server.post(
    '/tenders/:tenderId/post-award',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), body: followupCreateSchema, response: { 201: followupSchema } } },
    async (request, reply) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para registrar un seguimiento post-adjudicación');

      let dueDate = request.body.dueDate ?? null;
      let legalReference: string | null = null;
      let metadata: Record<string, unknown> = {};

      // REQ-050/056: campos obligatorios por `kind`, validados explícitamente
      // (nunca inferidos) para no dejar un registro incompleto/engañoso.
      if (request.body.kind === 'hito' && !request.body.responsibleParty) {
        throw new ValidationAppError({ responsibleParty: 'Obligatorio para kind="hito": responsable (nombre/rol/correo) del hito.' });
      }
      if (request.body.kind === 'garantia' && !request.body.guaranteeType) {
        throw new ValidationAppError({ guaranteeType: 'Obligatorio para kind="garantia": tipo de garantía (cumplimiento/anticipo/vicios_ocultos/otro).' });
      }
      if (request.body.kind === 'facturacion' && !request.body.cfdiReference) {
        throw new ValidationAppError({ cfdiReference: 'Obligatorio para kind="facturacion": folio fiscal/UUID del CFDI referenciado.' });
      }
      if ((request.body.kind === 'penalizacion' || request.body.kind === 'convenio_modificatorio') && !request.body.modificationReference) {
        throw new ValidationAppError({ modificationReference: `Obligatorio para kind="${request.body.kind}": número/expediente registrado.` });
      }

      const row = await withTx(app.db, orgId, userId, async (tx) => {
        const tender = await requireTender(tx, orgId, request.params.tenderId);

        if (request.body.kind === 'pago' || request.body.kind === 'facturacion') {
          const verifiedOn = request.body.kind === 'facturacion' ? request.body.acceptanceDate : request.body.invoiceVerifiedOn;
          if (!verifiedOn) {
            throw new ValidationAppError(
              request.body.kind === 'facturacion'
                ? { acceptanceDate: 'Obligatorio para kind="facturacion": fecha en que se aceptó la factura, para calcular el plazo de pago (LAASSP Art. 73/Art. 51, según REQ-050).' }
                : { invoiceVerifiedOn: 'Obligatorio para kind="pago": fecha en que se verificó la factura, para calcular el plazo de pago (LAASSP Art. 73/Art. 51, según REQ-050).' }
            );
          }
          // REQ-050/AE-09: el régimen legal (17 días hábiles vs. 20 días
          // naturales) se decide por la fecha de PUBLICACIÓN de la
          // convocatoria (tender.published_at), nunca fija a la ley nueva.
          // Los días inhábiles combinan el calendario OFICIAL cargado en
          // `calendar_holidays` (si lo hay para el año relevante) con los
          // que el llamador declare a mano en `holidays`.
          const officialHolidays = await loadOfficialHolidays(tx, verifiedOn);
          const combinedHolidays = Array.from(new Set([...officialHolidays, ...request.body.holidays]));
          const deadline = computePaymentDeadline(verifiedOn, timestampToIso(tender.published_at as string | Date | null), combinedHolidays);
          dueDate = deadline.dueDate;
          legalReference = deadline.legalReference;
          // R5-01: `calendarNote` solo puede AFIRMAR que un feriado oficial
          // "fue incluido en el cómputo" cuando de verdad cayó dentro de la
          // ventana real [verifiedOn, dueDate] -- antes se contaban TODOS
          // los feriados cargados para el año (aunque cayeran fuera de la
          // ventana de este cómputo concreto, o aunque el régimen aplicable
          // fuera de días NATURALES, que nunca excluye inhábiles) como si
          // hubieran afectado el resultado. El mensaje ahora distingue los
          // tres casos honestamente.
          let calendarNote = deadline.calendarNote;
          if (deadline.legalRegime.unit === 'dias_habiles') {
            const officialHolidaysInRange = countHolidaysInWindow(officialHolidays, verifiedOn, deadline.dueDate);
            if (officialHolidaysInRange > 0) {
              calendarNote = `${calendarNote}; ${officialHolidaysInRange} día(s) inhábil(es) oficial(es) cargado(s) en calendar_holidays cayó/cayeron dentro de la ventana de este cómputo y fue/fueron excluido(s) del plazo.`;
            } else if (officialHolidays.length > 0) {
              calendarNote = `${calendarNote}; ${officialHolidays.length} día(s) inhábil(es) oficial(es) cargado(s) en calendar_holidays para este año, pero ninguno cayó dentro de la ventana de este cómputo (no afectaron el plazo calculado).`;
            }
          } else if (officialHolidays.length > 0) {
            calendarNote = `${calendarNote}; ${officialHolidays.length} día(s) inhábil(es) oficial(es) cargado(s) en calendar_holidays, pero el régimen aplicable a esta convocatoria es de días NATURALES (nunca excluye inhábiles).`;
          }
          metadata = {
            calendarNote,
            legalRegime: deadline.legalRegime,
            holidays: combinedHolidays,
          };
        }

        const id = randomUUID();

        // Recordatorio encolado como `jobs` (SIN envío externo, ver
        // docstring del módulo): `apps/worker` es responsable de procesar
        // esta cola en general, pero ningún "kind" de esta ronda implica
        // enviar nada a un tercero -- es deliberadamente una fila inerte
        // hasta que un futuro canal de notificación (fuera de alcance) la
        // consuma.
        let jobId: string | null = null;
        if (dueDate) {
          jobId = randomUUID();
          await tx.query(
            `insert into jobs (id, org_id, kind, payload, status, next_run_at, correlation_id)
             values ($1, $2, 'post_award_followup_reminder', $3::jsonb, 'queued', $4, $5)`,
            [
              jobId,
              orgId,
              JSON.stringify({ tenderId: request.params.tenderId, followupId: id, label: request.body.label, dueDate }),
              computeReminderRunAt(dueDate, request.body.reminderLeadDays),
              request.correlationId ?? null,
            ]
          );
        }

        const inserted = await tx.query<Record<string, unknown>>(
          `insert into post_award_followups
             (id, org_id, tender_id, kind, label, due_date, amount, notes, legal_reference, reminder_lead_days, job_id, metadata,
              responsible_party, guarantee_type, cfdi_reference, acceptance_date, modification_reference)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17) returning *`,
          [
            id,
            orgId,
            request.params.tenderId,
            request.body.kind,
            request.body.label,
            dueDate,
            request.body.amount ?? null,
            request.body.notes ?? null,
            legalReference,
            request.body.reminderLeadDays,
            jobId,
            JSON.stringify(metadata),
            request.body.responsibleParty ?? null,
            request.body.guaranteeType ?? null,
            request.body.cfdiReference ?? null,
            request.body.kind === 'facturacion' ? (request.body.acceptanceDate ?? null) : null,
            request.body.modificationReference ?? null,
          ]
        );
        await recordAudit(tx, { orgId, actorId: userId, action: 'post_award_followup.create', entity: 'post_award_followups', entityId: id, after: { kind: request.body.kind, dueDate, legalReference }, requestId: request.id, correlationId: request.correlationId });
        return inserted.rows[0];
      });

      reply.code(201);
      return mapFollowupRow(row);
    }
  );

  server.get(
    '/post-award-alerts',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { response: { 200: z.array(followupSchema.extend({ alertLevel: z.enum(['vencido', 'proximo']) })) } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const rows = await withTx(app.db, orgId, request.userId, async (tx) =>
        (
          await tx.query<Record<string, unknown>>(
            `select * from post_award_followups
             where org_id = $1 and status not in ('done', 'cancelled') and due_date is not null
             order by due_date asc`,
            [orgId]
          )
        ).rows
      );
      return rows.map(mapFollowupRow).filter((f: { alertLevel: string | null }) => f.alertLevel !== null);
    }
  );

  server.patch(
    '/tenders/:tenderId/post-award/:id',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid(), id: z.string().uuid() }), body: followupUpdateSchema, response: { 200: followupSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para actualizar un seguimiento post-adjudicación');

      const row = await withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const before = await tx.query('select * from post_award_followups where id = $1 and org_id = $2 and tender_id = $3', [request.params.id, orgId, request.params.tenderId]);
        if (before.rows.length === 0) return null;
        const b = request.body;
        const updated = await tx.query<Record<string, unknown>>(
          `update post_award_followups set
             status = coalesce($1, status),
             notes = coalesce($2, notes),
             due_date = case when $3::boolean then $4::date else due_date end,
             responsible_party = coalesce($7, responsible_party),
             guarantee_type = coalesce($8, guarantee_type),
             cfdi_reference = coalesce($9, cfdi_reference),
             modification_reference = coalesce($10, modification_reference)
           where id = $5 and org_id = $6 returning *`,
          [
            b.status ?? null,
            b.notes ?? null,
            'dueDate' in b,
            b.dueDate ?? null,
            request.params.id,
            orgId,
            b.responsibleParty ?? null,
            b.guaranteeType ?? null,
            b.cfdiReference ?? null,
            b.modificationReference ?? null,
          ]
        );
        await recordAudit(tx, { orgId, actorId: userId, action: 'post_award_followup.update', entity: 'post_award_followups', entityId: request.params.id, before: before.rows[0], after: updated.rows[0], requestId: request.id, correlationId: request.correlationId });
        return updated.rows[0];
      });
      if (!row) throw new NotFoundError('Seguimiento post-adjudicación no encontrado');
      return mapFollowupRow(row);
    }
  );
}

/** Fecha de ejecución del recordatorio: `reminderLeadDays` días naturales antes del vencimiento (a las 09:00 UTC), nunca después. */
function computeReminderRunAt(dueDateIso: string, leadDays: number): string {
  const due = new Date(`${dueDateIso}T09:00:00Z`);
  due.setUTCDate(due.getUTCDate() - leadDays);
  return due.toISOString();
}

/**
 * REQ-050/056: carga el calendario OFICIAL de días inhábiles federales
 * (`calendar_holidays`, cargado por un administrador vía
 * `POST /admin/calendar-holidays` -- ver docs/e11-cobertura.md) para el/los
 * año(s) relevantes al cómputo (año de `verifiedOn` y, por si el plazo
 * cruza el 1-ene, el año siguiente). Con la tabla vacía (nada cargado
 * todavía) regresa `[]` sin lanzar: el motor sigue funcionando con la
 * aproximación documentada (solo sábado/domingo), nunca inventa un feriado.
 */
async function loadOfficialHolidays(tx: DbExecutor, verifiedOnIsoDate: string): Promise<string[]> {
  const year = Number(verifiedOnIsoDate.slice(0, 4));
  if (!Number.isInteger(year)) return [];
  const { rows } = await tx.query<{ holiday_date: string | Date }>(
    `select holiday_date from calendar_holidays where jurisdiction = 'federal' and year in ($1, $2)`,
    [year, year + 1]
  );
  // R5-01 (docs/auditoria-2/api-ronda5.md, CRÍTICA): el driver (pg/PGlite)
  // devuelve la columna `date` como una instancia de `Date` -- `String(date)`
  // invoca `Date.prototype.toString()` (formato dependiente de la zona
  // horaria LOCAL del proceso, p.ej. "Thu Sep 10 2026 ..."), NUNCA
  // `toISOString()`. El resultado nunca coincidía con las claves "YYYY-MM-DD"
  // que usa `addBusinessDays()`, así que un feriado oficial cargado NUNCA
  // excluía el día real del cómputo, aunque `calendarNote` afirmara lo
  // contrario. `toDateOnlyString` (arriba en este mismo archivo, ya usado
  // por `computeAlertLevel`) normaliza con getters UTC, determinista sin
  // importar `TZ` del proceso -- se reutiliza aquí en vez de duplicar lógica.
  return rows.map((r) => toDateOnlyString(r.holiday_date) as string);
}

/**
 * R5-01: cuenta cuántas fechas de `holidays` caen estrictamente DESPUÉS de
 * `startIsoDate` y hasta `endIsoDate` inclusive -- exactamente la ventana
 * que `addBusinessDays` recorre (empieza en `startIsoDate + 1 día`, termina
 * en `endIsoDate`, que por construcción nunca es un fin de semana/feriado).
 * Comparación por fecha civil pura (sin componente de hora), determinista
 * sin importar `TZ` del proceso.
 */
function countHolidaysInWindow(holidays: readonly string[], startIsoDate: string, endIsoDate: string): number {
  const startMs = new Date(`${startIsoDate.slice(0, 10)}T00:00:00Z`).getTime();
  const endMs = new Date(`${endIsoDate.slice(0, 10)}T00:00:00Z`).getTime();
  return holidays.filter((h) => {
    const t = new Date(`${h.slice(0, 10)}T00:00:00Z`).getTime();
    return t > startMs && t <= endMs;
  }).length;
}
