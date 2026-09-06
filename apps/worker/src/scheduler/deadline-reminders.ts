import type { DbClient } from '@atiende/db';
import type { Logger } from '../logger.js';
import type { JobQueue } from '../queue/job-queue.js';
import { enqueueAgentRun } from '../agents/enqueue-agent-run.js';
import { withWorkerPlatformReadContext } from '../agents/db-context.js';
import { SYSTEM_ACTOR_ID, SYSTEM_ACTOR_ROLE } from '../agents/system-actor.js';

export interface DeadlineReminderOptions {
  /** Ventana de anticipación (días) para considerar un vencimiento "próximo". Por defecto 3. */
  windowDays?: number;
  now?: () => Date;
}

interface UpcomingTenderRow {
  id: string;
  org_id: string;
  title: string;
  submission_deadline: string | Date;
}

/**
 * Escanea `tenders` de TODAS las organizaciones buscando vencimientos
 * (`submission_deadline`) dentro de la ventana de anticipación, y encola
 * `recordatorios` (Ronda 6, tarea 4: "run_agent encola por evento... de
 * vencimiento") por cada una — deduplicado por `(tenderId, fecha del
 * vencimiento)`, así que llamar esta función muchas veces dentro del mismo
 * día para la MISMA convocatoria nunca encola una segunda corrida activa
 * (mismo mecanismo `jobKey` + advisory lock de `JobQueue.enqueue`, WK-04).
 *
 * Requiere `PROPOSAL-06-agent-business-tools-grants.sql` aplicada (SELECT
 * de `worker_role` sobre `tenders`) — sin ella, esta función lanza
 * `SchemaGrantPendingError` explícito (nunca "no hay vencimientos" de forma
 * fabricada). Ver `apps/worker/src/agents/db-context.ts`.
 */
export async function enqueueUpcomingDeadlineReminders(
  db: DbClient,
  queue: JobQueue,
  logger: Logger,
  options: DeadlineReminderOptions = {},
): Promise<{ scanned: number; enqueued: number }> {
  const now = options.now ?? (() => new Date());
  const windowDays = options.windowDays ?? 3;
  const nowDate = now();
  const windowEnd = new Date(nowDate.getTime() + windowDays * 24 * 60 * 60 * 1000);

  const rows = await withWorkerPlatformReadContext(db, ['tenders'], async (tx) => {
    const { rows } = await tx.query<UpcomingTenderRow>(
      `select id, org_id, title, submission_deadline from tenders
       where submission_deadline is not null
         and submission_deadline > $1
         and submission_deadline <= $2
         and status not in ('cancelled', 'lost', 'won', 'submitted')`,
      [nowDate.toISOString(), windowEnd.toISOString()],
    );
    return rows;
  });

  let enqueued = 0;
  for (const row of rows) {
    const deadline = new Date(row.submission_deadline);
    const dedupeDate = deadline.toISOString().slice(0, 10); // fecha calendario (no hora), evita re-encolar en cada tick del mismo día
    try {
      const result = await enqueueAgentRun(db, queue, {
        agentName: 'recordatorios',
        organizationId: row.org_id,
        actorId: SYSTEM_ACTOR_ID,
        actorRole: SYSTEM_ACTOR_ROLE,
        context: {
          tenderId: row.id,
          alert: {
            kind: 'vencimiento',
            scheduledFor: nowDate.toISOString(),
            message: `La convocatoria "${row.title}" vence el ${deadline.toISOString()}.`,
          },
        },
        correlationId: row.id,
        eventKey: `vencimiento:${row.id}:${dedupeDate}`,
      });
      if (!result.deduped) enqueued += 1;
    } catch (error) {
      logger.warn(
        { tender_id: row.id, err: error instanceof Error ? error.message : String(error) },
        'recordatorios: no se pudo encolar el recordatorio de vencimiento próximo',
      );
    }
  }

  return { scanned: rows.length, enqueued };
}
