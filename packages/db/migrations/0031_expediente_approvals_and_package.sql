-- 0031_expediente_approvals_and_package.sql
-- Ronda 3 (E8/E9, apps/api): columnas de alcance jerárquico para
-- `proposal_approvals` (`ApprovalWorkflow.Approval`, REQ-159/REQ-161/
-- REQ-162), un log de eventos de aprobación (fuente de verdad reproducible
-- para reconstruir el estado en memoria de `ApprovalWorkflow` en cada
-- petición -- ver apps/api/src/lib/expediente/approval-store.pg.ts),
-- comentarios persistentes, y referencia de almacenamiento del ZIP en
-- `package_manifests`. Solo adiciones.

-- ---------------------------------------------------------------------------
-- proposal_approvals: alcance (expediente/documento/sección) + hash de
-- insumos con el que se aprobó (para poder detectar divergencia, EX-EXP-01).
-- ---------------------------------------------------------------------------
alter table proposal_approvals add column if not exists scope text not null default 'expediente';
alter table proposal_approvals
  add constraint chk_proposal_approvals_scope
  check (scope in ('seccion', 'documento', 'expediente'));

alter table proposal_approvals add column if not exists scope_ref text not null default 'expediente';
alter table proposal_approvals add column if not exists inputs_hash text;
alter table proposal_approvals add column if not exists comment text;

-- REQ-159: solo reviewer/admin/owner aprueban (nunca writer/viewer,
-- coherente con `ApprovalWorkflow.APPROVER_ROLES` de @atiende/expediente).
-- La política heredada de 0016 (decision_roles = owner/admin/analyst) NO
-- incluía `reviewer` y SÍ incluía `analyst`, que esta ronda no debe poder
-- aprobar expedientes -- mismo patrón que 0024_go_no_go_reviewer.sql
-- (redefine solo esta tabla, sin tocar `decision_roles` en ninguna otra).
drop policy if exists ins_proposal_approvals on proposal_approvals;
create policy ins_proposal_approvals on proposal_approvals
  for insert with check (
    app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,reviewer}'::org_role[]))
  );

drop policy if exists upd_proposal_approvals on proposal_approvals;
create policy upd_proposal_approvals on proposal_approvals
  for update using (
    app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,reviewer}'::org_role[]))
  )
  with check (
    app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,reviewer}'::org_role[]))
  );

drop policy if exists del_proposal_approvals on proposal_approvals;
create policy del_proposal_approvals on proposal_approvals
  for delete using (
    app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,reviewer}'::org_role[]))
  );

-- ---------------------------------------------------------------------------
-- proposal_approval_events: log append-only de acciones sobre
-- `ApprovalWorkflow` (enviar a revisión, aprobar, comentar, registrar
-- cambio). `ApprovalWorkflow` es una clase en memoria sin API de
-- "hidratar" estado externo (packages/expediente es alcance de otro
-- agente); apps/api reconstruye el estado real reproduciendo este log, en
-- orden, sobre una instancia nueva en cada petición (mismo patrón que un
-- agregado de event sourcing minimalista). `proposal_approvals` queda como
-- snapshot materializado del estado resultante para lectura simple/RLS por
-- fila, pero este log es la fuente de verdad.
-- ---------------------------------------------------------------------------
create table if not exists proposal_approval_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  proposal_id uuid not null references proposals (id) on delete cascade,
  seq bigint generated always as identity,
  kind text not null,
  actor_id uuid references users (id) on delete set null,
  actor_role org_role not null,
  scope text,
  scope_ref text,
  inputs_hash text,
  text_body text,
  reason text,
  created_at timestamptz not null default now()
);

alter table proposal_approval_events
  add constraint chk_proposal_approval_events_kind
  check (kind in ('request_review', 'approve', 'comment', 'record_change'));

create index if not exists ix_proposal_approval_events_org_proposal on proposal_approval_events (org_id, proposal_id, seq);

do $$
declare
  all_roles org_role[] := '{owner,admin,analyst,writer,reviewer,viewer}';
  write_roles org_role[] := '{owner,admin,analyst,writer,reviewer}';
begin
  perform app.apply_org_rls('proposal_approval_events', all_roles, write_roles);
end;
$$;

-- ---------------------------------------------------------------------------
-- proposal_comments: comentarios humanos legibles sobre un alcance del
-- expediente (independiente del log de eventos, que además guarda un
-- `text_body` para comentarios -- esta tabla es la vista de lectura simple
-- que usa la UI/API para listar comentarios sin tener que reproducir el
-- log completo).
-- ---------------------------------------------------------------------------
create table if not exists proposal_comments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  proposal_id uuid not null references proposals (id) on delete cascade,
  scope_ref text not null,
  author_id uuid references users (id) on delete set null,
  author_role org_role not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists ix_proposal_comments_org_proposal on proposal_comments (org_id, proposal_id, created_at);

do $$
declare
  all_roles org_role[] := '{owner,admin,analyst,writer,reviewer,viewer}';
  write_roles org_role[] := '{owner,admin,analyst,writer,reviewer}';
begin
  perform app.apply_org_rls('proposal_comments', all_roles, write_roles);
end;
$$;

-- ---------------------------------------------------------------------------
-- package_manifests: referencia al ZIP real en disco (STORAGE_DIR) y hash
-- de insumos con el que se generó (para poder explicar por qué un
-- manifiesto "ready" quedó obsoleto tras un cambio posterior).
-- ---------------------------------------------------------------------------
alter table package_manifests add column if not exists storage_ref text;
alter table package_manifests add column if not exists inputs_hash text;
