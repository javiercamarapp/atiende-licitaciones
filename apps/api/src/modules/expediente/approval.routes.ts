/**
 * E8 — `ApprovalWorkflow` real (roles reviewer/admin/owner; autoaprobación
 * prohibida) con comentarios e invalidación automática al cambiar insumos o
 * versión de bases (A11), con `audit_log`. Ver
 * `lib/expediente/approval-store.pg.ts` para la estrategia de persistencia
 * (reproducción de un log de eventos sobre una instancia en memoria de
 * `ApprovalWorkflow`, requerido porque esa clase no expone API de
 * hidratación y `packages/expediente` está fuera de este ámbito).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MEMBERSHIP_ADMIN_ROLES, WRITE_ROLES, type OrgRole } from '@atiende/db';
import { sealInputs } from '@atiende/expediente';
import { ForbiddenError } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { requireStepUp } from '../../lib/step-up.js';
import { withTx, requireTender, requireProposal, collectUsedInputs } from '../../lib/expediente/context.js';
import { loadApprovalEvents, replayWorkflow, appendApprovalEvent, persistApprovalSnapshot, orgRoleToWorkflowRole } from '../../lib/expediente/approval-store.pg.js';
import { getCurrentSealedInputs, getCurrentInputsHashForDisplay, buildExpedienteInputs } from '../../lib/expediente/inputs.js';
import { requestReviewSchema, approveSchema, commentCreateSchema, approvalStateSchema } from './schemas.js';

const APPROVER_ROLES: OrgRole[] = ['owner', 'admin', 'reviewer'];

export async function expedienteApprovalRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/tenders/:tenderId/approval',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: approvalStateSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      return withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const proposal = await requireProposal(tx, orgId, request.params.tenderId);
        const events = await loadApprovalEvents(tx, orgId, proposal.id as string);
        const workflow = replayWorkflow(events);
        const { usedCompanyDocumentIds, usedRateConcepts } = await collectUsedInputs(tx, orgId, proposal.id as string);
        const sealed = await getCurrentSealedInputs(tx, { orgId, tenderId: request.params.tenderId, usedCompanyDocumentIds, usedRateConcepts });
        const fullyApproved = workflow.isFullyApprovedForCurrentHash(sealed);
        return {
          state: workflow.getState(),
          approvals: workflow.listApprovals().map((a) => ({ ...a, inputsHash: String(a.inputsHash) })),
          comments: workflow.listComments(),
          currentInputsHash: sealed.hash,
          fullyApproved,
        };
      });
    }
  );

  server.post(
    '/tenders/:tenderId/approval/request-review',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), body: requestReviewSchema, response: { 200: approvalStateSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRoleForSubmit(request.orgRole);

      return withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const proposal = await requireProposal(tx, orgId, request.params.tenderId);
        const events = await loadApprovalEvents(tx, orgId, proposal.id as string);
        const workflow = replayWorkflow(events);
        const actorRole = orgRoleToWorkflowRole(request.orgRole!);
        const result = workflow.requestReview({ scopeRef: request.body.scopeRef, actorId: userId, actorRole });
        if (!result.ok) throw new ForbiddenError(result.reason);

        await appendApprovalEvent(tx, { orgId, proposalId: proposal.id as string, kind: 'request_review', actorId: userId, actorRole: request.orgRole!, scopeRef: request.body.scopeRef });
        await tx.query("update proposals set status = 'in_review' where id = $1 and org_id = $2", [proposal.id, orgId]);
        await recordAudit(tx, { orgId, actorId: userId, action: 'approval.request_review', entity: 'proposals', entityId: proposal.id as string, after: { scopeRef: request.body.scopeRef }, requestId: request.id, correlationId: request.correlationId });

        const { usedCompanyDocumentIds, usedRateConcepts } = await collectUsedInputs(tx, orgId, proposal.id as string);
        const sealed = await getCurrentSealedInputs(tx, { orgId, tenderId: request.params.tenderId, usedCompanyDocumentIds, usedRateConcepts });
        return {
          state: workflow.getState(),
          approvals: workflow.listApprovals().map((a) => ({ ...a, inputsHash: String(a.inputsHash) })),
          comments: workflow.listComments(),
          currentInputsHash: sealed.hash,
          fullyApproved: workflow.isFullyApprovedForCurrentHash(sealed),
        };
      });
    }
  );

  server.post(
    '/tenders/:tenderId/approval/approve',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), body: approveSchema, response: { 200: approvalStateSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      // REQ-159: solo reviewer/admin/owner aprueban -- se refuerza en la
      // aplicación ADEMÁS de la política RLS de proposal_approvals (0031),
      // que ya rechaza el INSERT/UPDATE si el rol no es de este conjunto.
      if (!request.orgRole || !APPROVER_ROLES.includes(request.orgRole)) {
        throw new ForbiddenError('Solo reviewer/admin/owner pueden aprobar un expediente');
      }
      const orgRole = request.orgRole;

      return withTx(app.db, orgId, userId, async (tx) => {
        // REQ-044/064: aprobar un expediente exige verificación en dos
        // pasos (TOTP) reciente, distinta del rol que aprueba -- ver
        // lib/step-up.ts. Sin 2FA enrolado o sin X-Step-Up vigente, 403
        // explícito con instrucción, antes de tocar ningún dato.
        await requireStepUp(tx, { userId, stepUpHeader: request.headers['x-step-up'] });
        await requireTender(tx, orgId, request.params.tenderId);
        const proposal = await requireProposal(tx, orgId, request.params.tenderId);
        const events = await loadApprovalEvents(tx, orgId, proposal.id as string);
        const workflow = replayWorkflow(events);

        const { usedCompanyDocumentIds, usedRateConcepts } = await collectUsedInputs(tx, orgId, proposal.id as string);
        const inputs = await buildExpedienteInputs(tx, { orgId, tenderId: request.params.tenderId, usedCompanyDocumentIds, usedRateConcepts });
        const sealed = sealInputs(inputs);

        const actorRole = orgRoleToWorkflowRole(orgRole);
        // Autoaprobación entre cuentas distintas de la misma persona física
        // NO se puede detectar aquí (límite documentado en
        // packages/expediente/README.md, EX-EXP-08): solo se compara
        // `actorId` (el mismo userId que envió a revisión no puede
        // aprobar), que sí es una garantía real dentro de una sola cuenta.
        const result = workflow.approve({ scope: request.body.scope, scopeRef: request.body.scopeRef, actorId: userId, actorRole, inputsHash: sealed });
        if (!result.ok) throw new ForbiddenError(result.reason);

        await appendApprovalEvent(tx, {
          orgId,
          proposalId: proposal.id as string,
          kind: 'approve',
          actorId: userId,
          actorRole: orgRole,
          scope: request.body.scope,
          scopeRef: request.body.scopeRef,
          inputsSnapshot: inputs,
          inputsHashForDisplay: sealed.hash,
        });
        await persistApprovalSnapshot(tx, orgId, proposal.id as string, workflow);

        if (request.body.scope === 'expediente' && workflow.getState() === 'aprobado') {
          await tx.query("update proposals set status = 'approved' where id = $1 and org_id = $2", [proposal.id, orgId]);
        }
        const inputsHashDisplay = await getCurrentInputsHashForDisplay(tx, { orgId, tenderId: request.params.tenderId, usedCompanyDocumentIds, usedRateConcepts });
        await tx.query('update proposals set inputs_hash = $1 where id = $2 and org_id = $3', [inputsHashDisplay, proposal.id, orgId]);

        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: 'approval.approve',
          entity: 'proposal_approvals',
          entityId: proposal.id as string,
          after: { scope: request.body.scope, scopeRef: request.body.scopeRef },
          requestId: request.id, correlationId: request.correlationId,
        });

        return {
          state: workflow.getState(),
          approvals: workflow.listApprovals().map((a) => ({ ...a, inputsHash: String(a.inputsHash) })),
          comments: workflow.listComments(),
          currentInputsHash: sealed.hash,
          fullyApproved: workflow.isFullyApprovedForCurrentHash(sealed),
        };
      });
    }
  );

  server.post(
    '/tenders/:tenderId/approval/comments',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), body: commentCreateSchema, response: { 200: approvalStateSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRoleForSubmit(request.orgRole, true);

      return withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const proposal = await requireProposal(tx, orgId, request.params.tenderId);
        const events = await loadApprovalEvents(tx, orgId, proposal.id as string);
        const workflow = replayWorkflow(events);
        const actorRole = orgRoleToWorkflowRole(request.orgRole!);
        workflow.addComment({ scopeRef: request.body.scopeRef, authorId: userId, authorRole: actorRole, text: request.body.text });

        await appendApprovalEvent(tx, { orgId, proposalId: proposal.id as string, kind: 'comment', actorId: userId, actorRole: request.orgRole!, scopeRef: request.body.scopeRef, textBody: request.body.text });
        await tx.query('insert into proposal_comments (id, org_id, proposal_id, scope_ref, author_id, author_role, body) values (gen_random_uuid(), $1, $2, $3, $4, $5, $6)', [
          orgId,
          proposal.id,
          request.body.scopeRef,
          userId,
          request.orgRole,
          request.body.text,
        ]);
        await recordAudit(tx, { orgId, actorId: userId, action: 'approval.comment', entity: 'proposal_comments', entityId: proposal.id as string, after: { scopeRef: request.body.scopeRef }, requestId: request.id, correlationId: request.correlationId });

        const { usedCompanyDocumentIds, usedRateConcepts } = await collectUsedInputs(tx, orgId, proposal.id as string);
        const sealed = await getCurrentSealedInputs(tx, { orgId, tenderId: request.params.tenderId, usedCompanyDocumentIds, usedRateConcepts });
        return {
          state: workflow.getState(),
          approvals: workflow.listApprovals().map((a) => ({ ...a, inputsHash: String(a.inputsHash) })),
          comments: workflow.listComments(),
          currentInputsHash: sealed.hash,
          fullyApproved: workflow.isFullyApprovedForCurrentHash(sealed),
        };
      });
    }
  );
}

function requireOrgRoleForSubmit(role: OrgRole | undefined, allowAnyWriteRole = false): void {
  const allowed = allowAnyWriteRole ? WRITE_ROLES : (['writer', ...MEMBERSHIP_ADMIN_ROLES] as OrgRole[]);
  if (!role || !allowed.includes(role)) {
    throw new ForbiddenError(`Esta acción requiere uno de estos roles: ${allowed.join(', ')}`);
  }
}
