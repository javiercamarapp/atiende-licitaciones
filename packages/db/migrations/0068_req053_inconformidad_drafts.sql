-- 0068_req053_inconformidad_drafts.sql
-- Ronda 6 (E11, apps/api), REQ-053: redactor de inconformidades. Genera un
-- BORRADOR estructurado (hechos/agravios/fundamentos/pruebas/plazo) a
-- partir de datos capturados por el usuario -- NUNCA se envía a ninguna
-- autoridad desde este sistema (ver `inconformidad.routes.ts`, sin cliente
-- HTTP saliente). Cada generación es una fila NUEVA (versionado real, no
-- edición in-place) con `content_hash` -- el contenido es INMUTABLE tras
-- crearse (ver trigger abajo); la única mutación permitida es marcarlo
-- como "revisado" por un abogado humano (`status`/`reviewed_by`/
-- `reviewed_at`), que exige step-up (`expediente.inconformidad_review`,
-- migración 0066).
create table if not exists inconformidad_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  tender_id uuid not null references tenders (id) on delete cascade,
  version integer not null,
  status text not null default 'borrador',
  content_hash text not null,
  hechos text[] not null,
  agravios text[] not null,
  pruebas text[] not null default '{}',
  -- Fundamentos legales citados (articulo/ley/jurisdicción/fecha DOF/texto),
  -- ver lib/expediente/inconformidad.ts#buildFundamentos.
  fundamentos jsonb not null,
  fallo_notified_on date not null,
  bajo_tratados boolean not null default false,
  dias_habiles integer not null,
  fecha_limite date not null,
  fundamento_legal_plazo text not null,
  viability text not null,
  viability_recommendation text not null,
  disclaimer text not null,
  reviewed_by uuid references users (id) on delete set null,
  reviewed_at timestamptz,
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, tender_id, version)
);

alter table inconformidad_drafts add constraint chk_inconformidad_drafts_status check (status in ('borrador', 'revisado'));
alter table inconformidad_drafts add constraint chk_inconformidad_drafts_viability check (viability in ('alta', 'media', 'baja'));

create index if not exists ix_inconformidad_drafts_org_tender on inconformidad_drafts (org_id, tender_id, version);

-- ---------------------------------------------------------------------------
-- Inmutabilidad del CONTENIDO (defensa en profundidad, mismo espíritu que
-- la cadena de hashes de `audit_log`, 0023): la aplicación solo debería
-- emitir un UPDATE para marcar "revisado" (status/reviewed_by/reviewed_at),
-- nunca para tocar el contenido -- este trigger lo hace IMPOSIBLE también
-- si un bug futuro intentara editarlo.
-- ---------------------------------------------------------------------------
create or replace function app.protect_inconformidad_draft_content()
returns trigger
language plpgsql
as $$
begin
  if new.content_hash is distinct from old.content_hash
     or new.hechos is distinct from old.hechos
     or new.agravios is distinct from old.agravios
     or new.pruebas is distinct from old.pruebas
     or new.fundamentos is distinct from old.fundamentos
     or new.fallo_notified_on is distinct from old.fallo_notified_on
     or new.bajo_tratados is distinct from old.bajo_tratados
     or new.dias_habiles is distinct from old.dias_habiles
     or new.fecha_limite is distinct from old.fecha_limite
     or new.version is distinct from old.version
  then
    raise exception 'inconformidad_drafts: el contenido es inmutable tras crearse -- genere una nueva versión en vez de editar (fila %).', old.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_inconformidad_draft_content on inconformidad_drafts;
create trigger trg_protect_inconformidad_draft_content
  before update on inconformidad_drafts
  for each row execute function app.protect_inconformidad_draft_content();

alter table inconformidad_drafts enable row level security;

do $$
declare
  all_roles org_role[] := '{owner,admin,analyst,writer,reviewer,viewer}';
  write_roles org_role[] := '{owner,admin,analyst,writer,reviewer}';
begin
  perform app.apply_org_rls('inconformidad_drafts', all_roles, write_roles);
end;
$$;
