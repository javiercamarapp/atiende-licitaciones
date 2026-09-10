import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { DbClient, DbExecutor } from '@atiende/db';
import { ingestBodySchema, ingestResponseSchema, type TenderRecordIngest } from './schemas.js';
import { fireAndForgetMail } from '../../lib/mail/pending.js';
import { notifyTenderChangeToResponsibles } from '../../lib/mail/tender-change-notify.js';
import { notifyNewTenderMatchToResponsibles } from '../../lib/mail/new-tender-match-notify.js';

interface IngestOutcome {
  source: string;
  externalId: string;
  organizationId: string;
  action: 'created' | 'updated' | 'unchanged';
  tenderId: string;
  versionId: string | null;
  /** Solo en `action: 'updated'` -- el `change_kind` inferido de ESTE cambio (ver `notifyTenderChangeToResponsibles`, REQ-155). */
  changeKind?: string;
  /** Solo en `action: 'updated'` -- el plazo previo a este cambio (`tenders.submission_deadline` antes del UPDATE), para el aviso de cambio. */
  priorDeadlineIso?: string | null;
}

/**
 * DECISIÓN DE DISEÑO (documentada también en apps/api/README.md): este
 * endpoint escribe usando la conexión "cruda" de `app.db` (SIN `SET LOCAL
 * ROLE app_role`), es decir, bypassea RLS deliberadamente. Es la ÚNICA ruta
 * de escritura de toda la API que lo hace, y es seguro porque:
 *  1. No representa a ningún usuario/tenant: está autenticado con
 *     `X-Platform-Api-Key` (ver plugins/auth.plugin.ts), un secreto de
 *     plataforma que solo conoce el propio backend (apps/worker).
 *  2. `tenders` en este esquema es per-organización (unique(org_id, source,
 *     external_id), ver packages/db/migrations/0005), así que una sola
 *     convocatoria pública descubierta debe replicarse en N organizaciones
 *     de una sola vez -- ninguna identidad de usuario individual tiene ese
 *     rol de escritura multi-org por diseño (y no debería tenerlo).
 *  3. Nunca acepta datos de un tenant: todo el payload es de fuentes
 *     oficiales públicas (packages/sources), no del cliente HTTP en nombre
 *     de una organización.
 * Alternativa considerada y descartada: impersonar a un "usuario de
 * sistema" marcado `platform_admin`. Se descartó por añadir un usuario
 * ficticio a seedear en cada entorno sin beneficio de seguridad real (el
 * secreto de plataforma ya es el control de acceso).
 */
export async function internalIngestRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    '/ingest',
    {
      preHandler: [app.requirePlatformApiKey],
      schema: { body: ingestBodySchema, response: { 200: ingestResponseSchema } },
    },
    async (request) => {
      const { records, organizationIds } = request.body;
      // R5-04 (docs/auditoria-2/api-ronda5.md, MEDIA): `request.correlationId`
      // ya lo resuelve el plugin global (hereda `X-Correlation-Id` o genera
      // uno) para CUALQUIER request, esta incluida -- el hueco no era la
      // resolución, sino que nunca se PERSISTÍA en ningún dato de esta
      // request (ni en `tenders`/`tender_versions`, que no tenían la
      // columna, ni en el `audit_log` de ingesta). Ahora nace aquí y se
      // hereda en ambas tablas.
      const correlationId = request.correlationId ?? randomUUID();

      const targetOrgIds =
        organizationIds && organizationIds.length > 0
          ? organizationIds
          : (await app.db.query<{ id: string }>('select id from organizations')).rows.map((r) => r.id);

      const results: IngestOutcome[] = [];
      let created = 0;
      let updated = 0;
      let unchanged = 0;

      for (const record of records) {
        for (const orgId of targetOrgIds) {
          const outcome = await ingestOneRecordForOrg(app.db, orgId, record, correlationId);
          results.push(outcome);
          if (outcome.action === 'created') {
            created += 1;
            // REQ-181 (plantilla `new-tender-match`): el INSERT de
            // `outcome.tenderId` ya hizo COMMIT (misma `ingestOneRecordForOrg`
            // de arriba) -- primera vez que ESTA organización ve esta
            // convocatoria, el único evento real al que puede engancharse
            // "nuevo match" (ver docstring de `new-tender-match-notify.ts`:
            // nunca en cada GET de la pantalla de matching). En segundo
            // plano, nunca bloquea ni puede revertir la ingesta ya aplicada.
            fireAndForgetMail(app, 'new-tender-match', () =>
              notifyNewTenderMatchToResponsibles(app, { organizationId: orgId, tenderId: outcome.tenderId })
            );
          } else if (outcome.action === 'updated') {
            updated += 1;
            // REQ-155: la invalidación en cascada de `outcome.tenderId` ya
            // hizo COMMIT dentro de `ingestOneRecordForOrg` (el trigger
            // `app.invalidate_tender_dependents` corrió como parte de esa
            // misma transacción, ver el comentario ahí) -- este aviso corre
            // DESPUÉS y en segundo plano (`fireAndForgetMail`, nunca con
            // `await` directo): un fallo al notificar (lectura de miembros,
            // correo, WhatsApp) nunca debe bloquear ni hacer fallar esta
            // respuesta HTTP, y estructuralmente no puede revertir una
            // invalidación que ya es un hecho consumado.
            fireAndForgetMail(app, 'tender-change', () =>
              notifyTenderChangeToResponsibles(app, {
                organizationId: orgId,
                tenderId: outcome.tenderId,
                // Siempre poblado en `action: 'updated'` (ver el return de
                // `ingestOneRecordForOrg` arriba) -- `IngestOutcome.versionId`
                // es `string | null` solo porque otras acciones no lo usan.
                versionId: outcome.versionId as string,
                tenderTitle: record.title,
                changeKind: outcome.changeKind ?? 'amendment',
                previousDeadlineIso: outcome.priorDeadlineIso ?? null,
                newDeadlineIso: record.submissionDeadline ?? null,
              })
            );
          } else unchanged += 1;
        }
      }

      return {
        results,
        summary: { created, updated, unchanged, organizationsAffected: targetOrgIds.length },
      };
    }
  );
}

async function ingestOneRecordForOrg(
  db: DbClient,
  orgId: string,
  record: TenderRecordIngest,
  correlationId: string
): Promise<IngestOutcome> {
  return db.transaction(async (tx) => {
    const existing = await tx.query<{
      id: string;
      submission_deadline: string | null;
    }>('select id, submission_deadline from tenders where org_id = $1 and source = $2 and external_id = $3', [
      orgId,
      record.source,
      record.externalId,
    ]);

    const status = record.status ?? 'discovered';
    const cpvCodes = record.cpvCodes ?? [];

    if (existing.rows.length === 0) {
      const tenderId = randomUUID();
      await tx.query(
        `insert into tenders (id, org_id, source, external_id, title, contracting_body, cpv_codes, budget_amount, currency, submission_deadline, published_at, url, status, raw_data, correlation_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)`,
        [
          tenderId,
          orgId,
          record.source,
          record.externalId,
          record.title,
          record.contractingEntity ?? null,
          cpvCodes,
          record.budgetAmount ?? null,
          record.currency ?? 'MXN',
          record.submissionDeadline ?? null,
          record.publishedAt ?? null,
          record.url ?? null,
          status,
          JSON.stringify(record.rawData ?? {}),
          correlationId,
        ]
      );
      const versionId = await createVersionAndEvent(tx, orgId, tenderId, record, record.changeKind ?? 'publication', correlationId);
      await auditIngest(tx, orgId, 'tender.ingest.created', tenderId, record, correlationId);
      return { source: record.source, externalId: record.externalId, organizationId: orgId, action: 'created', tenderId, versionId };
    }

    const tenderId = existing.rows[0].id;

    const priorVersion = await tx.query<{ id: string }>(
      'select id from tender_versions where org_id = $1 and tender_id = $2 and source_version = $3',
      [orgId, tenderId, record.sourceVersion]
    );

    if (priorVersion.rows.length > 0) {
      // Replay/duplicado exacto de la misma versión de origen: NO-OP real
      // (REQ-073/REQ-074/REQ-152/REQ-154, prueba mínima A2). No se
      // actualiza `tenders`, no se crea versión ni evento, no se invalida
      // nada de nuevo.
      return {
        source: record.source,
        externalId: record.externalId,
        organizationId: orgId,
        action: 'unchanged',
        tenderId,
        versionId: priorVersion.rows[0].id,
      };
    }

    const priorDeadline = existing.rows[0].submission_deadline;
    const newDeadline = record.submissionDeadline ?? null;
    const inferredKind =
      record.changeKind ?? (newDeadline !== null && priorDeadline !== newDeadline ? 'deadline_change' : 'amendment');

    await tx.query(
      `update tenders set title = $1, contracting_body = $2, cpv_codes = $3, budget_amount = $4, currency = $5,
         submission_deadline = $6, published_at = $7, url = $8, status = $9, raw_data = $10::jsonb, correlation_id = $13
       where id = $11 and org_id = $12`,
      [
        record.title,
        record.contractingEntity ?? null,
        cpvCodes,
        record.budgetAmount ?? null,
        record.currency ?? 'MXN',
        record.submissionDeadline ?? null,
        record.publishedAt ?? null,
        record.url ?? null,
        status,
        JSON.stringify(record.rawData ?? {}),
        tenderId,
        orgId,
        correlationId,
      ]
    );

    // Invalidación automática de dependientes (REQ-155/REQ-162, prueba
    // mínima A3): a partir de DB-05 (docs/auditoria-1/db-api.md), el propio
    // INSERT de `tender_change_events` dispara el trigger
    // `app.invalidate_tender_dependents` (packages/db/migrations/
    // 0022_fix_db05_change_event_invalidation.sql), que marca
    // proposals/requirement_items/compliance_items/proposal_approvals sin
    // que esta ruta tenga que repetir esa lógica a mano (defensa en
    // profundidad: cualquier otro código que inserte un change_event futuro
    // también la dispara).
    const versionId = await createVersionAndEvent(tx, orgId, tenderId, record, inferredKind, correlationId);

    await auditIngest(tx, orgId, 'tender.ingest.updated', tenderId, record, correlationId);

    return {
      source: record.source,
      externalId: record.externalId,
      organizationId: orgId,
      action: 'updated',
      tenderId,
      versionId,
      changeKind: inferredKind,
      // `priorDeadline` viene del driver de PG como `Date` para una columna
      // `timestamptz` (NO como string, pese a que `existing.rows[0]` se
      // tipa como `{ submission_deadline: string | null }` arriba -- esa
      // anotación es solo un cast de TypeScript, no una conversión real).
      // El resto de esta ruta nunca lo necesitó como string (solo lo
      // compara con `newDeadline` arriba), pero `TenderChangeVariablesSchema`
      // (`packages/mail`) sí exige `z.string()` -- sin normalizar aquí,
      // `MailService.send()` devuelve `invalid_variables` en silencio (no
      // lanza) y el correo nunca sale, sin que nada lo marque como error.
      priorDeadlineIso: priorDeadline ? new Date(priorDeadline).toISOString() : null,
    };
  });
}

async function createVersionAndEvent(
  tx: DbExecutor,
  orgId: string,
  tenderId: string,
  record: TenderRecordIngest,
  changeKind: string,
  correlationId: string
): Promise<string> {
  const versionId = randomUUID();
  await tx.query(
    `insert into tender_versions (id, org_id, tender_id, change_kind, source_version, payload, correlation_id)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [versionId, orgId, tenderId, changeKind, record.sourceVersion, JSON.stringify(record), correlationId]
  );
  const eventId = randomUUID();
  await tx.query(
    `insert into tender_change_events (id, org_id, tender_id, tender_version_id, change_kind, summary)
     values ($1, $2, $3, $4, $5, $6)`,
    [eventId, orgId, tenderId, versionId, changeKind, `Versión de origen ${record.sourceVersion} (${changeKind})`]
  );
  return versionId;
}

async function auditIngest(tx: DbExecutor, orgId: string, action: string, tenderId: string, record: TenderRecordIngest, correlationId: string): Promise<void> {
  await tx.query(
    `insert into audit_log (org_id, actor_id, action, entity, entity_id, after, request_id, correlation_id)
     values ($1, null, $2, 'tenders', $3, $4::jsonb, null, $5)`,
    [orgId, action, tenderId, JSON.stringify({ source: record.source, externalId: record.externalId, sourceVersion: record.sourceVersion }), correlationId]
  );
}
