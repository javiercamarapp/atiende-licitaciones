/**
 * REQ-067 — cableado REAL contra Postgres de las herramientas de solo
 * lectura declaradas en `@atiende/expediente` (`packages/expediente/src/chatgpt-app.ts`,
 * `CHATGPT_APP_TOOL_DEFINITIONS`). Ese paquete declara EL NOMBRE, la
 * descripción y el `inputSchema` de cada herramienta (regla de negocio,
 * probada de forma aislada e independiente de la base de datos); este
 * archivo es el único que sabe consultar `tenders`/`proposals`/
 * `compliance_items`/`proposal_approval_events` — mismo patrón que el resto
 * de `apps/api` (la lógica de dominio vive en `packages/*`, el adaptador de
 * Postgres vive aquí).
 *
 * Cada función reutiliza EXACTAMENTE el mismo aislamiento de tenant que el
 * resto de `apps/api` (`withTx`: `set local role app_role` +
 * `set_config('app.current_org_id', ...)`, ver `lib/expediente/context.ts`)
 * y las MISMAS tablas que ya sirven `GET /tenders`, `GET /tenders/:id`,
 * `GET /expediente/:tenderId/approval` y
 * `GET /expediente/:tenderId/checklist` — no hay una copia paralela de los
 * datos, ni un cálculo distinto del que ya ve el portal web.
 *
 * Alcance deliberado (BLUEPRINT L839-843/L945-948; docs/ACEPTACION.md
 * REQ-067, criterio literal: "solo permite `callTool` de lectura; no
 * expone documentos firmables"): ninguna función de este archivo escribe
 * nada en la base de datos. La salida de cada una pasa, en
 * `mcp.routes.ts`, por `assertNoFirmableDocumentInToolOutput` (defensa en
 * profundidad de `@atiende/expediente`) antes de salir hacia el cliente
 * MCP — pero el control PRINCIPAL es que ninguna de estas funciones
 * proyecta un campo documental en primer lugar (`evidenceRef` se omite a
 * propósito de `get_compliance_matrix`, `approvedBy`/actorId de
 * `get_approval_status` se omite también: ni siquiera un identificador de
 * usuario interno sale por este canal).
 */
import type { DbExecutor } from '@atiende/db';
import { z } from 'zod';
import { withTx } from '../../lib/expediente/context.js';
import { loadApprovalEvents, replayWorkflow } from '../../lib/expediente/approval-store.pg.js';
import { TENDER_STATUSES } from '../tenders/schemas.js';

export { withTx };

/** Error de negocio (no de protocolo): `mcp.routes.ts` lo traduce a un `CallToolResult` con `isError: true`, nunca a un 500 sin explicación ni a un dato fabricado. */
export class ChatGptAppToolError extends Error {}

// ---------------------------------------------------------------------------
// list_tenders
// ---------------------------------------------------------------------------

export const listTendersInputSchema = z.object({
  status: z.enum(TENDER_STATUSES).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type ListTendersInput = z.infer<typeof listTendersInputSchema>;

export interface TenderSummary {
  id: string;
  title: string;
  contractingBody: string | null;
  budgetAmount: number | null;
  currency: string;
  submissionDeadline: string | null;
  status: string;
}

/**
 * Misma tabla y mismo aislamiento por `org_id` que `GET /tenders`
 * (`modules/tenders/routes.ts`). Nunca acepta `orgId` como argumento de la
 * herramienta (lo fija SIEMPRE el runtime a partir de `X-Org-Id` verificado
 * por `app.requireOrg`) — el modelo del lado de ChatGPT jamás decide de qué
 * organización lee.
 */
export async function listTenders(tx: DbExecutor, orgId: string, input: ListTendersInput): Promise<{ items: TenderSummary[]; count: number }> {
  const limit = input.limit ?? 20;
  const conditions = ['org_id = $1'];
  const params: unknown[] = [orgId];
  if (input.status) {
    params.push(input.status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(limit);
  const { rows } = await tx.query<Record<string, unknown>>(
    `select id, title, contracting_body, budget_amount, currency, submission_deadline, status
       from tenders
      where ${conditions.join(' and ')}
      order by created_at desc
      limit $${params.length}`,
    params
  );
  const items = rows.map((r): TenderSummary => mapTenderSummary(r));
  return { items, count: items.length };
}

// ---------------------------------------------------------------------------
// get_tender
// ---------------------------------------------------------------------------

export const getTenderInputSchema = z.object({ tenderId: z.string().uuid() });
export type GetTenderInput = z.infer<typeof getTenderInputSchema>;

export async function getTender(tx: DbExecutor, orgId: string, input: GetTenderInput): Promise<TenderSummary> {
  const { rows } = await tx.query<Record<string, unknown>>(
    'select id, title, contracting_body, budget_amount, currency, submission_deadline, status from tenders where id = $1 and org_id = $2',
    [input.tenderId, orgId]
  );
  if (rows.length === 0) {
    throw new ChatGptAppToolError('Convocatoria no encontrada en esta organización.');
  }
  return mapTenderSummary(rows[0]);
}

function mapTenderSummary(r: Record<string, unknown>): TenderSummary {
  return {
    id: String(r.id),
    title: String(r.title),
    contractingBody: (r.contracting_body as string | null) ?? null,
    budgetAmount: r.budget_amount !== null && r.budget_amount !== undefined ? Number(r.budget_amount) : null,
    currency: String(r.currency),
    submissionDeadline: (r.submission_deadline as string | null) ?? null,
    status: String(r.status),
  };
}

// ---------------------------------------------------------------------------
// get_approval_status
// ---------------------------------------------------------------------------

export const getApprovalStatusInputSchema = z.object({ tenderId: z.string().uuid() });
export type GetApprovalStatusInput = z.infer<typeof getApprovalStatusInputSchema>;

export interface ApprovalStatusSummary {
  tenderId: string;
  state: 'borrador' | 'en_revision' | 'aprobado';
  approvals: Array<{ scope: string; scopeRef: string; approvedByRole: string; approvedAt: string; status: string }>;
  comments: Array<{ scopeRef: string; authorRole: string; text: string; createdAt: string }>;
}

/**
 * Refleja el MISMO `ApprovalWorkflow` real que `GET /expediente/:tenderId/approval`
 * (`expediente/approval.routes.ts`), reproducido desde el log de eventos
 * persistido (`lib/expediente/approval-store.pg.ts`) — nunca un cálculo
 * paralelo. Se omite deliberadamente `approvedBy` (id de usuario interno) e
 * `inputsHash` (detalle de integridad sin valor de lectura externa) — este
 * canal solo necesita saber SI hay una primera aprobación en curso, no
 * quién exactamente ni con qué hash.
 */
export async function getApprovalStatus(tx: DbExecutor, orgId: string, input: GetApprovalStatusInput): Promise<ApprovalStatusSummary> {
  const tenderRes = await tx.query<{ id: string }>('select id from tenders where id = $1 and org_id = $2', [input.tenderId, orgId]);
  if (tenderRes.rows.length === 0) {
    throw new ChatGptAppToolError('Convocatoria no encontrada en esta organización.');
  }
  const proposalRes = await tx.query<{ id: string }>(
    'select id from proposals where org_id = $1 and tender_id = $2 order by created_at asc limit 1',
    [orgId, input.tenderId]
  );
  if (proposalRes.rows.length === 0) {
    // Estado honesto: todavía no existe expediente -- nunca se fabrica un
    // estado "aprobado" ni "en_revision" por defecto.
    return { tenderId: input.tenderId, state: 'borrador', approvals: [], comments: [] };
  }
  const events = await loadApprovalEvents(tx, orgId, proposalRes.rows[0].id);
  const workflow = replayWorkflow(events);
  return {
    tenderId: input.tenderId,
    state: workflow.getState(),
    approvals: workflow.listApprovals().map((a) => ({ scope: a.scope, scopeRef: a.scopeRef, approvedByRole: a.approvedByRole, approvedAt: a.approvedAt, status: a.status })),
    comments: workflow.listComments().map((c) => ({ scopeRef: c.scopeRef, authorRole: c.authorRole, text: c.text, createdAt: c.createdAt })),
  };
}

// ---------------------------------------------------------------------------
// get_compliance_matrix
// ---------------------------------------------------------------------------

export const getComplianceMatrixInputSchema = z.object({ tenderId: z.string().uuid() });
export type GetComplianceMatrixInput = z.infer<typeof getComplianceMatrixInputSchema>;

export interface ComplianceMatrixItemSummary {
  dimension: string | null;
  result: 'verde' | 'ambar' | 'rojo' | null;
  label: string;
  notes: string | null;
}

export interface ComplianceMatrixSummary {
  tenderId: string;
  overallStatus: 'verde' | 'ambar' | 'rojo';
  items: ComplianceMatrixItemSummary[];
}

/**
 * Mismo semáforo que `GET /expediente/:tenderId/checklist`
 * (`checklist.routes.ts`), sin `evidenceRef` ni `checkedAt` — un cliente MCP
 * externo no necesita la referencia interna de evidencia para mostrar el
 * semáforo de una convocatoria (ver también la guarda de última línea
 * `assertNoFirmableDocumentInToolOutput`, que además bloquearía
 * `evidenceRef` si algún cambio futuro lo reintrodujera aquí por error).
 */
export async function getComplianceMatrix(tx: DbExecutor, orgId: string, input: GetComplianceMatrixInput): Promise<ComplianceMatrixSummary> {
  const tenderRes = await tx.query<{ id: string }>('select id from tenders where id = $1 and org_id = $2', [input.tenderId, orgId]);
  if (tenderRes.rows.length === 0) {
    throw new ChatGptAppToolError('Convocatoria no encontrada en esta organización.');
  }
  const proposalRes = await tx.query<{ id: string }>(
    'select id from proposals where org_id = $1 and tender_id = $2 order by created_at asc limit 1',
    [orgId, input.tenderId]
  );
  if (proposalRes.rows.length === 0) {
    // Estado honesto: sin expediente todavía, nunca se fabrica un semáforo "verde" por defecto.
    return { tenderId: input.tenderId, overallStatus: 'rojo', items: [] };
  }
  const { rows } = await tx.query<Record<string, unknown>>(
    "select dimension, result, label, notes from compliance_items where org_id = $1 and proposal_id = $2 and dimension is not null and invalidated_at is null order by dimension asc",
    [orgId, proposalRes.rows[0].id]
  );
  const items: ComplianceMatrixItemSummary[] = rows.map((r) => ({
    dimension: (r.dimension as string | null) ?? null,
    result: (r.result as 'verde' | 'ambar' | 'rojo' | null) ?? null,
    label: String(r.label),
    notes: (r.notes as string | null) ?? null,
  }));
  const overallStatus: 'verde' | 'ambar' | 'rojo' = items.some((i) => i.result === 'rojo')
    ? 'rojo'
    : items.some((i) => i.result === 'ambar')
      ? 'ambar'
      : 'verde';
  return { tenderId: input.tenderId, overallStatus, items };
}
