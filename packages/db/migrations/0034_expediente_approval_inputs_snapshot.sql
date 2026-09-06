-- 0034_expediente_approval_inputs_snapshot.sql
-- Ronda 3 (E8): tras EX-EXP-17 (packages/expediente), `ApprovalWorkflow.
-- approve()`/`revalidateAgainstCurrentHash` exigen un `HashedInputs`
-- sellado (`sealInputs(inputs)`), no un `string` plano -- `sealInputs`
-- necesita el `ExpedienteInputs` COMPLETO (recalcula y compara su hash
-- internamente). Para poder REPRODUCIR una aprobación histórica al
-- reproducir `proposal_approval_events` (ver
-- apps/api/src/lib/expediente/approval-store.pg.ts), hace falta guardar el
-- snapshot completo de insumos con el que se aprobó, no solo su hash.
alter table proposal_approval_events add column if not exists inputs_snapshot jsonb;
