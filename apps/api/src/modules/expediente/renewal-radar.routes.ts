/**
 * REQ-055 — radar de renovaciones. `POST /renewals/scan` es un escaneo BAJO
 * DEMANDA (sin cron real en esta ronda, ver README) sobre los contratos de
 * la organización con `end_date` conocida: genera alertas (`renewal_alerts`
 * + un job `renewal_radar_alert` por alerta, `jobs`, SIN envío externo) con
 * antelación configurable (por defecto 90/60/30 días). Cada alerta se
 * enriquece con hasta `MAX_HISTORICAL_TENDERS` convocatorias PREVIAS de la
 * MISMA organización y el MISMO `contracting_body` (si existen) como
 * contexto de apoyo -- ver límite documentado en
 * `lib/expediente/renewal-radar.ts`.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WRITE_ROLES } from '@atiende/db';
import { requireOrgRole } from '../../lib/authorize.js';
import { recordAudit } from '../../lib/audit.js';
import { withTx } from '../../lib/expediente/context.js';
import { computeRenewalAlertCandidates, MAX_HISTORICAL_TENDERS, type RenewalCandidateContract } from '../../lib/expediente/renewal-radar.js';
import { renewalScanRequestSchema, renewalRadarRunSchema, renewalAlertSchema } from './schemas.js';

function mapAlertRow(r: Record<string, unknown>): any {
  return {
    id: r.id,
    contractId: r.contract_id,
    tenderId: r.tender_id,
    sourceKind: r.source_kind,
    predictedDate: r.predicted_date,
    leadDays: r.lead_days,
    confidence: r.confidence !== null && r.confidence !== undefined ? Number(r.confidence) : null,
    notes: r.notes,
    jobId: r.job_id,
    status: r.status,
    createdAt: r.created_at,
  };
}

function toDateOnlyString(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export async function expedienteRenewalRadarRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    '/renewals/scan',
    { preHandler: [app.authenticate, app.requireOrg], schema: { body: renewalScanRequestSchema, response: { 200: renewalRadarRunSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para escanear renovaciones');

      const runId = randomUUID();
      const today = new Date().toISOString().slice(0, 10);

      const { alertsCreated, evaluatedContracts } = await withTx(app.db, orgId, userId, async (tx) => {
        const contractsRes = await tx.query<Record<string, unknown>>(
          `select c.id as contract_id, c.tender_id, c.end_date, t.contracting_body, t.title
             from contracts c join tenders t on t.id = c.tender_id and t.org_id = c.org_id
            where c.org_id = $1 and c.end_date is not null and c.status not in ('cerrado', 'rescindido')`,
          [orgId]
        );

        const candidates: RenewalCandidateContract[] = contractsRes.rows
          .map((r) => ({ contractId: r.contract_id as string, tenderId: r.tender_id as string, endDate: toDateOnlyString(r.end_date as string | Date) as string }))
          .filter((c) => c.endDate !== null);

        const alerts = computeRenewalAlertCandidates(candidates, today, request.body.leadDaysThresholds);

        let created = 0;
        for (const alert of alerts) {
          // Dedupe: el índice único parcial (org_id, contract_id, lead_days)
          // rechazaría un duplicado exacto, pero se verifica antes para no
          // depender de capturar la excepción y para no encolar un job
          // huérfano si la fila no llegara a insertarse.
          const existing = await tx.query('select 1 from renewal_alerts where org_id = $1 and contract_id = $2 and lead_days = $3', [orgId, alert.contractId, alert.leadDays]);
          if (existing.rows.length > 0) continue;

          const contractRow = contractsRes.rows.find((r) => r.contract_id === alert.contractId)!;
          const historicalRes = await tx.query<{ id: string; title: string }>(
            `select id, title from tenders
               where org_id = $1 and contracting_body is not null and contracting_body = $2 and id <> $3
               order by published_at desc nulls last limit $4`,
            [orgId, contractRow.contracting_body, alert.tenderId, MAX_HISTORICAL_TENDERS]
          );
          const notes =
            historicalRes.rows.length > 0
              ? `Contrato con vigencia hasta ${alert.predictedDate} (entidad: ${contractRow.contracting_body ?? NO_ENTITY_LABEL}). Convocatorias históricas de la misma entidad en esta organización: ${historicalRes.rows.map((h) => h.title).join('; ')}.`
              : `Contrato con vigencia hasta ${alert.predictedDate} (entidad: ${contractRow.contracting_body ?? NO_ENTITY_LABEL}). Sin convocatorias históricas de la misma entidad registradas en esta organización.`;

          const jobId = randomUUID();
          await tx.query(
            `insert into jobs (id, org_id, kind, payload, status, next_run_at, correlation_id)
             values ($1, $2, 'renewal_radar_alert', $3::jsonb, 'queued', now(), $4)`,
            [
              jobId,
              orgId,
              JSON.stringify({ contractId: alert.contractId, tenderId: alert.tenderId, leadDays: alert.leadDays, predictedDate: alert.predictedDate }),
              request.correlationId ?? null,
            ]
          );

          await tx.query(
            `insert into renewal_alerts (id, org_id, contract_id, tender_id, source_kind, predicted_date, lead_days, confidence, notes, job_id)
             values ($1, $2, $3, $4, 'contract_end_date', $5, $6, $7, $8, $9)`,
            [randomUUID(), orgId, alert.contractId, alert.tenderId, alert.predictedDate, alert.leadDays, alert.confidence, notes, jobId]
          );
          created += 1;
        }

        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: 'renewal_radar.scan',
          entity: 'renewal_alerts',
          entityId: runId,
          after: { evaluatedContracts: candidates.length, alertsCreated: created, leadDaysThresholds: request.body.leadDaysThresholds },
          requestId: request.id,
          correlationId: request.correlationId,
        });

        return { alertsCreated: created, evaluatedContracts: candidates.length };
      });

      return { runId, alertsCreated, evaluatedContracts };
    }
  );

  server.get(
    '/renewals/alerts',
    { preHandler: [app.authenticate, app.requireOrg], schema: { response: { 200: z.array(renewalAlertSchema) } } },
    async (request) => {
      const orgId = request.orgId!;
      const rows = await withTx(app.db, orgId, request.userId, async (tx) =>
        (await tx.query<Record<string, unknown>>('select * from renewal_alerts where org_id = $1 order by predicted_date asc', [orgId])).rows
      );
      return rows.map(mapAlertRow);
    }
  );
}

const NO_ENTITY_LABEL = 'no disponible';
