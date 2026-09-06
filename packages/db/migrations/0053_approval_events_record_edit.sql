-- 0053_approval_events_record_edit.sql
-- AE-11 (docs/auditoria-2/api-expediente.md): `packages/expediente` agregó
-- `ApprovalWorkflow.recordEdit({scopeRef, actorId})`/`authorsOf(scopeRef)`
-- (commit 50fb7ea) -- `approve()` ahora rechaza a un aprobador que conste
-- como autor de contenido del alcance que intenta aprobar (o de cualquier
-- alcance descendiente cubierto). El cambio es aditivo/retrocompatible en
-- la librería pura, pero solo tiene efecto real si `apps/api` PERSISTE la
-- llamada a `recordEdit` como un evento más del log append-only
-- (`proposal_approval_events`, ver `lib/expediente/approval-store.pg.ts`) --
-- sin esto, `replayWorkflow` nunca reconstruiría el mapa de autores entre
-- una petición y la siguiente (cada petición reproduce el log sobre una
-- instancia NUEVA de `ApprovalWorkflow`).
--
-- Amplía el `CHECK` de `kind` (0031_expediente_approvals_and_package.sql)
-- para admitir el nuevo tipo de evento `record_edit`, sin tocar ninguna
-- fila existente.
alter table proposal_approval_events
  drop constraint if exists chk_proposal_approval_events_kind;

alter table proposal_approval_events
  add constraint chk_proposal_approval_events_kind
  check (kind in ('request_review', 'approve', 'comment', 'record_change', 'record_edit'));
