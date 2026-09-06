-- 0070_req055_renewal_radar.sql
-- Ronda 6 (E11, apps/api), REQ-055: radar de renovaciones. `contracts`
-- (migración 0065) todavía no tenía fecha de fin/vigencia ni número de
-- contrato -- se agregan aquí porque son el insumo directo del radar
-- (contrato con fecha de fin próxima -> alerta de renovación probable).
alter table contracts add column if not exists end_date date;
alter table contracts add column if not exists contract_number text;

create index if not exists ix_contracts_end_date on contracts (org_id, end_date) where end_date is not null;

-- ---------------------------------------------------------------------------
-- renewal_alerts: alertas generadas por `POST /expediente/renewals/scan`
-- (bajo demanda en esta ronda -- sin cron real, ver README). Cada alerta
-- se corresponde con un job encolado (`jobs`, kind='renewal_radar_alert',
-- SIN envío externo) referenciado por `job_id`. El índice único parcial
-- evita alertar dos veces el MISMO umbral de antelación para el MISMO
-- contrato en escaneos repetidos.
-- ---------------------------------------------------------------------------
create table if not exists renewal_alerts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  contract_id uuid references contracts (id) on delete cascade,
  tender_id uuid references tenders (id) on delete cascade,
  source_kind text not null,
  predicted_date date not null,
  lead_days integer not null,
  confidence numeric(3, 2) not null,
  notes text not null default '',
  job_id uuid references jobs (id) on delete set null,
  status text not null default 'queued',
  created_at timestamptz not null default now()
);

alter table renewal_alerts add constraint chk_renewal_alerts_source_kind check (source_kind in ('contract_end_date', 'historical_pattern'));
alter table renewal_alerts add constraint chk_renewal_alerts_status check (status in ('queued', 'acknowledged', 'dismissed'));

create unique index if not exists ux_renewal_alerts_contract_lead on renewal_alerts (org_id, contract_id, lead_days) where contract_id is not null;
create index if not exists ix_renewal_alerts_org_predicted on renewal_alerts (org_id, predicted_date);

alter table renewal_alerts enable row level security;

do $$
declare
  all_roles org_role[] := '{owner,admin,analyst,writer,reviewer,viewer}';
  write_roles org_role[] := '{owner,admin,analyst,writer,reviewer}';
begin
  perform app.apply_org_rls('renewal_alerts', all_roles, write_roles);
end;
$$;
