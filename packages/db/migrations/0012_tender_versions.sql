-- 0012_tender_versions.sql
-- Historial de versiones de una convocatoria (publicación original,
-- aclaraciones, anexos, cambios de plazo) con deduplicación por identidad de
-- origen + versión, y eventos de cambio que invalidan trabajo dependiente
-- (propuestas, checklist, aprobaciones) cuando bases o fechas cambian.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'tender_change_kind') then
    create type tender_change_kind as enum (
      'publication', 'amendment', 'annex', 'deadline_change', 'clarification', 'cancellation'
    );
  end if;
end
$$;

-- Cada versión de origen (identificada por el emisor de la fuente) se
-- guarda una sola vez por convocatoria: dedupe real vía UNIQUE, no por
-- "mejor esfuerzo" en la aplicación.
create table if not exists tender_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  tender_id uuid not null references tenders (id) on delete cascade,
  change_kind tender_change_kind not null,
  source_version text not null,
  effective_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (org_id, tender_id, source_version)
);

create index if not exists ix_tender_versions_org_tender on tender_versions (org_id, tender_id, effective_at desc);

-- Evento de cambio: qué versión disparó qué invalidación y por qué. No
-- borra ni sobrescribe el trabajo dependiente; solo lo marca como
-- pendiente de revisión (ver columnas `invalidated_at`/`invalidated_reason`
-- añadidas a las tablas dependientes más abajo).
create table if not exists tender_change_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  tender_id uuid not null references tenders (id) on delete cascade,
  tender_version_id uuid references tender_versions (id) on delete set null,
  change_kind tender_change_kind not null,
  summary text,
  created_at timestamptz not null default now()
);

create index if not exists ix_tender_change_events_org_tender on tender_change_events (org_id, tender_id, created_at desc);

-- Columnas de invalidación en tablas dependientes: un cambio de bases/plazo
-- las marca como "requiere revisión" sin perder el contenido existente.
-- Idempotente (IF NOT EXISTS) para poder reejecutar esta migración sin error
-- si en algún entorno ya existieran (protección extra, además del control
-- por schema_migrations).
alter table proposals add column if not exists invalidated_at timestamptz;
alter table proposals add column if not exists invalidated_reason text;
alter table compliance_items add column if not exists invalidated_at timestamptz;
alter table compliance_items add column if not exists invalidated_reason text;
alter table requirement_items add column if not exists invalidated_at timestamptz;
alter table requirement_items add column if not exists invalidated_reason text;
