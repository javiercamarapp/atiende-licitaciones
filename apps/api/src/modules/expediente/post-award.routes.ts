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
import { requireOrgRole } from '../../lib/authorize.js';
import { recordAudit } from '../../lib/audit.js';
import { NotFoundError, ValidationAppError } from '../../lib/errors.js';
import { withTx, requireTender } from '../../lib/expediente/context.js';
import { computePaymentDeadline } from '../../lib/expediente/business-days.js';
import { followupCreateSchema, followupUpdateSchema, followupSchema } from './schemas.js';

function mapFollowupRow(r: Record<string, unknown>): any {
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
      if (request.body.kind === 'pago') {
        if (!request.body.invoiceVerifiedOn) {
          throw new ValidationAppError({ invoiceVerifiedOn: 'Obligatorio para kind="pago": fecha en que se verificó la factura, para calcular el plazo de 17 días hábiles (LAASSP Art. 73).' });
        }
        const deadline = computePaymentDeadline(request.body.invoiceVerifiedOn);
        dueDate = deadline.dueDate;
        legalReference = deadline.legalReference;
      }

      const row = await withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
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
            `insert into jobs (id, org_id, kind, payload, status, next_run_at)
             values ($1, $2, 'post_award_followup_reminder', $3::jsonb, 'queued', $4)`,
            [
              jobId,
              orgId,
              JSON.stringify({ tenderId: request.params.tenderId, followupId: id, label: request.body.label, dueDate }),
              computeReminderRunAt(dueDate, request.body.reminderLeadDays),
            ]
          );
        }

        const inserted = await tx.query<Record<string, unknown>>(
          `insert into post_award_followups (id, org_id, tender_id, kind, label, due_date, amount, notes, legal_reference, reminder_lead_days, job_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
          [id, orgId, request.params.tenderId, request.body.kind, request.body.label, dueDate, request.body.amount ?? null, request.body.notes ?? null, legalReference, request.body.reminderLeadDays, jobId]
        );
        await recordAudit(tx, { orgId, actorId: userId, action: 'post_award_followup.create', entity: 'post_award_followups', entityId: id, after: { kind: request.body.kind, dueDate, legalReference }, requestId: request.id });
        return inserted.rows[0];
      });

      reply.code(201);
      return mapFollowupRow(row);
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
             due_date = case when $3::boolean then $4::date else due_date end
           where id = $5 and org_id = $6 returning *`,
          [b.status ?? null, b.notes ?? null, 'dueDate' in b, b.dueDate ?? null, request.params.id, orgId]
        );
        await recordAudit(tx, { orgId, actorId: userId, action: 'post_award_followup.update', entity: 'post_award_followups', entityId: request.params.id, before: before.rows[0], after: updated.rows[0], requestId: request.id });
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
