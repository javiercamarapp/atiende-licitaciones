import type { DbClient } from '@atiende/db';
import type { Role } from '@atiende/agents';
import type { JobQueue } from '../queue/job-queue.js';
import { sanitizeCorrelationId } from '../lib/correlation-id.js';
import { withWorkerAgentRunsInsertContext, SchemaGrantPendingError } from './db-context.js';
import type { NamedAgent } from './named-agents.js';

export interface EnqueueAgentRunParams {
  agentName: NamedAgent;
  organizationId: string;
  actorId: string;
  actorRole: Role;
  context: Record<string, unknown>;
  correlationId?: string;
  /** Distingue el evento que disparó esta corrida (ingesta/versión/vencimiento), para la clave de dedupe. */
  eventKey: string;
}

/**
 * Encola un job `run_agent` disparado por un evento de plataforma (ingesta
 * de una convocatoria nueva, nueva versión de bases, vencimiento próximo —
 * Ronda 6, tarea 4). Deduplicado por `(agentName, eventKey)`: dos disparos
 * del mismo evento (p. ej. un reintento del propio productor del evento)
 * nunca encolan dos corridas activas del mismo agente para el mismo hecho
 * (mismo mecanismo de `payload.jobKey` + `pg_advisory_xact_lock` ya
 * documentado en `JobQueue.enqueue`, WK-04).
 *
 * Intenta abrir su PROPIA fila `agent_runs` (vía `withWorkerAgentRunsInsertContext`,
 * requiere `PROPOSAL-06`, PENDIENTE esquema) para que el resultado final
 * quede persistido y visible para revisión humana igual que una corrida
 * solicitada por un usuario. Si el grant/política de esa propuesta todavía
 * no está aplicado en este Postgres, la corrida se encola IGUAL (fail-open
 * deliberado para esta escritura de conveniencia, a diferencia de las
 * lecturas de negocio de `business-tools.ts`, que sí fallan cerrado): el
 * agente corre sin `agentRunId`, su resultado queda solo en el log
 * estructurado del proceso (ver `src/handlers/run-agent.ts`), documentado
 * como limitación explícita mientras esa migración no se aplique — nunca se
 * pierde silenciosamente el EVENTO en sí (el job sigue encolándose), solo
 * su trazabilidad en `agent_runs`.
 *
 * WK6-04 (docs/auditoria-2/worker-agentes-reverificacion.md, MEDIA;
 * reverificación de la ronda K, "audit gap" en la ruta de encolado): antes
 * de esta corrección, `correlation_id` se dejaba NULL en este INSERT
 * inicial y solo se escribía al FINAL de la corrida, en el `UPDATE` de
 * `updateAgentRunRow` (`src/handlers/run-agent.ts`) — a diferencia de
 * `apps/api/src/lib/agent-stores.pg.ts`, que sí puebla la columna desde el
 * INSERT para las corridas que abre directamente. Si el proceso moría, el
 * job quedaba huérfano/`fenced` (WK-02/WK-14) o la lease simplemente
 * expiraba antes de llegar a ese `UPDATE` final, la fila quedaba con
 * `status = 'running'` y `correlation_id is null` INDEFINIDAMENTE: un
 * hueco de auditoría real (REQ-171: no hay forma de encontrar, por
 * `correlation_id`, una corrida abierta por este camino que nunca
 * terminó). El valor ya se sanea aquí mismo para el payload del job (ver
 * más abajo); se reutiliza ese mismo resultado para que la fila nazca YA
 * correlacionable, sin esperar a que la corrida termine.
 */
export async function enqueueAgentRun(
  db: DbClient,
  queue: JobQueue,
  params: EnqueueAgentRunParams,
): Promise<{ jobId: string; deduped: boolean; agentRunId?: string; agentRunPersisted: boolean }> {
  // WK6-04: única función de saneamiento (ver docstring de
  // `../lib/correlation-id.ts`), calculada UNA vez y reutilizada tanto para
  // el INSERT inicial de `agent_runs` (abajo) como para el payload del job
  // `run_agent` (más abajo) -- ambos deben terminar con el MISMO valor
  // saneado.
  const sanitizedCorrelationId = sanitizeCorrelationId(params.correlationId)?.value;

  let agentRunId: string | undefined;
  let agentRunPersisted = false;
  try {
    const created = await withWorkerAgentRunsInsertContext(db, params.organizationId, (tx) =>
      tx.query<{ id: string }>(
        `insert into agent_runs (org_id, agent_name, input, status, correlation_id) values ($1, $2, $3::jsonb, 'running', $4) returning id`,
        [
          params.organizationId,
          params.agentName,
          JSON.stringify({ context: params.context, eventKey: params.eventKey }),
          sanitizedCorrelationId ?? null,
        ],
      ),
    );
    agentRunId = created.rows[0]?.id;
    agentRunPersisted = Boolean(agentRunId);
  } catch (error) {
    if (!(error instanceof SchemaGrantPendingError)) throw error;
    // Fail-open deliberado (ver docstring): el evento no se pierde, solo su
    // persistencia en agent_runs queda pendiente de PROPOSAL-06.
  }

  const { job, deduped } = await queue.enqueue(
    'run_agent',
    {
      agentRunId,
      organizationId: params.organizationId,
      actorId: params.actorId,
      actorRole: params.actorRole,
      agentName: params.agentName,
      context: params.context,
      correlationId: sanitizedCorrelationId,
    },
    { orgId: params.organizationId, jobKey: `run_agent:${params.agentName}:${params.eventKey}` },
  );

  return { jobId: job.id, deduped, agentRunId, agentRunPersisted };
}
