-- 0094_req051_collection_lifecycle.sql
-- REQ-051 (máquina de estados de COBRANZA para convocatorias adjudicadas):
-- `post_award_followups` de kind='facturacion'/'pago' YA tienen
-- `cfdi_reference`/`acceptance_date` (migración 0055) -- esta migración NO
-- duplica ese modelo, solo AÑADE el ciclo de cobro de cada factura/pago
-- individual. Mismo precedente que 0065 (contract_status_history): el
-- CATÁLOGO de transiciones válidas vive en código
-- (`apps/api/src/lib/expediente/collection-lifecycle.ts`), esta migración
-- solo persiste el ESTADO ACTUAL (columna en `post_award_followups`) y el
-- HISTORIAL de transiciones ejecutadas (`collection_status_history`,
-- inmutable).

alter table post_award_followups add column if not exists collection_status text;

-- Solo los `kind` con ciclo de cobro real (facturación/pago) pueden tener
-- `collection_status`; para cualquier otro `kind` debe quedar NULL siempre
-- (defensa en profundidad -- `apps/api` ya no lo asigna a otros `kind`,
-- pero el esquema lo hace imposible incluso si un futuro cambio lo
-- olvidara).
alter table post_award_followups
  add constraint chk_post_award_followups_collection_status_kind
  check (collection_status is null or kind in ('facturacion', 'pago'));

alter table post_award_followups
  add constraint chk_post_award_followups_collection_status
  check (collection_status is null or collection_status in (
    'emitida', 'enviada', 'en_revision', 'aprobada_para_pago', 'pagada', 'vencida_sin_pago', 'en_disputa'
  ));

create index if not exists ix_post_award_followups_collection_status on post_award_followups (org_id, collection_status) where collection_status is not null;

-- ---------------------------------------------------------------------------
-- collection_status_history: historial INMUTABLE de transiciones de
-- cobranza ejecutadas. `from_status` es NULL únicamente para la fila de
-- alta automática (al crear un seguimiento de kind='facturacion'/'pago', se
-- inicializa en 'emitida' -- ver `post-award.routes.ts`). `reason` es
-- obligatorio siempre, igual que `contract_status_history`.
-- ---------------------------------------------------------------------------
create table if not exists collection_status_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  followup_id uuid not null references post_award_followups (id) on delete cascade,
  from_status text,
  to_status text not null,
  reason text not null,
  actor_id uuid references users (id) on delete set null,
  evidence_ref text,
  correlation_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists ix_collection_status_history_org_followup on collection_status_history (org_id, followup_id, created_at);

-- RLS a mano (NO se usa app.apply_org_rls) -- deliberadamente SIN políticas
-- de UPDATE/DELETE: con RLS habilitada y ninguna política para esas
-- operaciones, Postgres las deniega para app_role sin excepción -- el
-- historial es append-only por diseño (inmutable), mismo patrón que
-- `contract_status_history` (migración 0065).
alter table collection_status_history enable row level security;

drop policy if exists sel_collection_status_history on collection_status_history;
create policy sel_collection_status_history on collection_status_history
  for select using (
    app.is_superadmin() or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[]))
  );

drop policy if exists ins_collection_status_history on collection_status_history;
create policy ins_collection_status_history on collection_status_history
  for insert with check (
    app.is_superadmin() or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer}'::org_role[]))
  );

-- Marcar una cobranza como "pagada" es dinero real confirmado -- nunca se
-- infiere ni se marca automáticamente, exige 2FA reciente (mismo patrón
-- que 0063/0066/0091: el CHECK a nivel de esquema debe mantenerse
-- sincronizado a mano con STEP_UP_PURPOSES, lib/step-up.ts).
alter table step_up_sessions drop constraint if exists chk_step_up_sessions_purpose;
alter table step_up_sessions
  add constraint chk_step_up_sessions_purpose
  check (purpose in (
    'company.rate_approval',
    'expediente.approval',
    'tool_call.approval',
    'admin.action',
    'expediente.contract_transition',
    'expediente.inconformidad_review',
    'twofa.disable',
    'twofa.backup_codes_regenerate',
    'auth.password_change',
    'auth.google_unlink',
    'expediente.collection_transition'
  ));
