-- 0065_req051_contract_lifecycle.sql
-- Ronda 6 (E11, apps/api): REQ-051 -- máquina de estados del contrato
-- post-adjudicación. El CATÁLOGO de transiciones válidas vive en código
-- (`apps/api/src/lib/expediente/contract-lifecycle.ts`, mismo precedente
-- que `STEP_UP_PURPOSES`), no en una tabla editable en runtime; esta
-- migración solo persiste el CONTRATO (una fila por convocatoria) y su
-- HISTORIAL de transiciones ejecutadas (inmutable).

create table if not exists contracts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  tender_id uuid not null references tenders (id) on delete cascade,
  status text not null default 'adjudicado',
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, tender_id)
);

alter table contracts
  add constraint chk_contracts_status
  check (status in (
    'adjudicado', 'contrato_firmado_declarado', 'en_ejecucion', 'entregado',
    'facturado', 'pagado', 'cerrado', 'modificado', 'penalizado', 'rescindido', 'en_inconformidad'
  ));

create index if not exists ix_contracts_org_tender on contracts (org_id, tender_id);

drop trigger if exists trg_contracts_updated_at on contracts;
create trigger trg_contracts_updated_at
  before update on contracts
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- contract_status_history: historial INMUTABLE de transiciones ejecutadas.
-- `from_status` es NULL únicamente para la fila de creación del contrato
-- (transición "inicial" hacia `adjudicado`, sin estado previo real).
-- `reason` (motivo) es obligatorio siempre -- ninguna transición se
-- registra sin una justificación explícita del actor.
-- ---------------------------------------------------------------------------
create table if not exists contract_status_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  contract_id uuid not null references contracts (id) on delete cascade,
  from_status text,
  to_status text not null,
  reason text not null,
  actor_id uuid references users (id) on delete set null,
  evidence_ref text,
  correlation_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists ix_contract_status_history_org_contract on contract_status_history (org_id, contract_id, created_at);

do $$
declare
  all_roles org_role[] := '{owner,admin,analyst,writer,reviewer,viewer}';
  write_roles org_role[] := '{owner,admin,analyst,writer,reviewer}';
begin
  perform app.apply_org_rls('contracts', all_roles, write_roles);
end;
$$;

-- ---------------------------------------------------------------------------
-- contract_status_history: RLS a mano (NO se usa app.apply_org_rls) --
-- deliberadamente SIN políticas de UPDATE/DELETE: con RLS habilitada y
-- ninguna política para esas operaciones, Postgres las deniega para
-- app_role sin excepción -- el historial es append-only por diseño
-- (inmutable), no solo "no se expone una ruta para editarlo".
-- ---------------------------------------------------------------------------
alter table contract_status_history enable row level security;

drop policy if exists sel_contract_status_history on contract_status_history;
create policy sel_contract_status_history on contract_status_history
  for select using (
    app.is_superadmin() or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[]))
  );

drop policy if exists ins_contract_status_history on contract_status_history;
create policy ins_contract_status_history on contract_status_history
  for insert with check (
    app.is_superadmin() or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer}'::org_role[]))
  );
