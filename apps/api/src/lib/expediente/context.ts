/**
 * Utilidades compartidas por las rutas de `modules/expediente/*`: contexto
 * de tenant (mismo patrón `SET LOCAL ROLE app_role` que el resto de
 * apps/api, ver README "Contexto de tenant por transacción"), resolución de
 * la convocatoria, obtención/creación de la propuesta (expediente) única
 * por (org, tender), y extracción de qué documentos/tarifas usó realmente
 * la última generación de secciones (para `buildExpedienteInputs`).
 */
import { randomUUID } from 'node:crypto';
import type { DbClient, DbExecutor } from '@atiende/db';
import { NotFoundError } from '../errors.js';

export async function withTx<T>(db: DbClient, orgId: string, userId: string | undefined, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query('set local role app_role');
    await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
    await tx.query("select set_config('app.current_user_id', $1, true)", [userId ?? '']);
    return fn(tx);
  });
}

export async function requireTender(tx: DbExecutor, orgId: string, tenderId: string): Promise<Record<string, unknown>> {
  const res = await tx.query<Record<string, unknown>>('select * from tenders where id = $1 and org_id = $2', [tenderId, orgId]);
  if (res.rows.length === 0) throw new NotFoundError('Convocatoria no encontrada');
  return res.rows[0];
}

/** Obtiene la propuesta (expediente) única de (org, tender), o la crea si no existe. */
export async function getOrCreateProposal(tx: DbExecutor, orgId: string, tenderId: string, userId: string, title: string): Promise<Record<string, unknown>> {
  const existing = await tx.query<Record<string, unknown>>('select * from proposals where org_id = $1 and tender_id = $2 order by created_at asc limit 1', [orgId, tenderId]);
  if (existing.rows.length > 0) return existing.rows[0];
  const id = randomUUID();
  const inserted = await tx.query<Record<string, unknown>>(
    `insert into proposals (id, org_id, tender_id, title, status, version, created_by) values ($1, $2, $3, $4, 'draft', 1, $5) returning *`,
    [id, orgId, tenderId, title, userId]
  );
  return inserted.rows[0];
}

export async function requireProposal(tx: DbExecutor, orgId: string, tenderId: string): Promise<Record<string, unknown>> {
  const res = await tx.query<Record<string, unknown>>('select * from proposals where org_id = $1 and tender_id = $2 order by created_at asc limit 1', [orgId, tenderId]);
  if (res.rows.length === 0) {
    throw new NotFoundError('No existe expediente (propuesta) para esta convocatoria todavía; genere primero la propuesta técnica/económica.');
  }
  return res.rows[0];
}

export interface GenerationReport {
  technical?: { usedCompanyDocumentIds: string[]; blockers: unknown[]; generatedAt: string };
  economic?: { usedRateConcepts: string[]; blockedLineItems: unknown[]; totals: unknown; generatedAt: string };
}

/**
 * `proposals.generation_report` guarda, en la MISMA generación, exactamente
 * qué `company_documents.id`/`approved_rates.item_code` se usaron (el
 * subconjunto "efectivamente usado" que exige `ExpedienteInputs`, ver
 * lib/expediente/inputs.ts) -- se captura en el momento de generar (los
 * handlers de proposal.routes.ts la conocen con certeza, sin tener que
 * reconstruirla adivinando a partir de `SourceRef.refId`, que para
 * capacidades/experiencia no necesariamente es un id de `company_documents`).
 */
export async function readGenerationReport(tx: DbExecutor, orgId: string, proposalId: string): Promise<GenerationReport> {
  const res = await tx.query<{ generation_report: unknown }>('select generation_report from proposals where org_id = $1 and id = $2', [orgId, proposalId]);
  return (res.rows[0]?.generation_report as GenerationReport | null) ?? {};
}

export async function collectUsedInputs(tx: DbExecutor, orgId: string, proposalId: string): Promise<{ usedCompanyDocumentIds: string[]; usedRateConcepts: string[] }> {
  const report = await readGenerationReport(tx, orgId, proposalId);
  return {
    usedCompanyDocumentIds: report.technical?.usedCompanyDocumentIds ?? [],
    usedRateConcepts: report.economic?.usedRateConcepts ?? [],
  };
}
