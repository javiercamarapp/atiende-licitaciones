-- 0069_req054_fallo_autopsy.sql
-- Ronda 6 (E11, apps/api), REQ-054: autopsia del fallo -- informe
-- estructurado comparando la propuesta propia contra el fallo (motivo de
-- desechamiento, puntos/criterios, precio propio vs. ganador cuando el
-- fallo es público). REQ-054 explícito: "sin inventar datos ausentes ->
-- 'no disponible'" -- por eso `disqualification_reason`/`winner_name` NO
-- son NOT NULL con default vacío: la aplicación (`fallo-autopsy.routes.ts`)
-- escribe literalmente la constante `NO_DISPONIBLE` cuando el dato no se
-- capturó, en vez de dejar la columna NULL/"" ambigua.
create table if not exists fallo_autopsies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  tender_id uuid not null references tenders (id) on delete cascade,
  own_proposal_status text not null default 'desconocido',
  disqualification_reason text not null,
  own_score numeric(10, 2),
  winner_score numeric(10, 2),
  own_price numeric(14, 2),
  winner_price numeric(14, 2),
  winner_name text not null,
  criteria_comparison jsonb not null default '[]'::jsonb,
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table fallo_autopsies
  add constraint chk_fallo_autopsies_own_status
  check (own_proposal_status in ('ganadora', 'desechada', 'no_presentada', 'desconocido'));

create index if not exists ix_fallo_autopsies_org_tender on fallo_autopsies (org_id, tender_id);

-- ---------------------------------------------------------------------------
-- company_lessons_learned: lecciones registradas y vinculadas al PERFIL DE
-- EMPRESA (org-wide, no solo a la convocatoria puntual) -- consultables sin
-- filtrar por tender vía `GET /expediente/lessons-learned` (REQ-054: "...
-- lecciones registradas y vinculadas al perfil de empresa").
-- ---------------------------------------------------------------------------
create table if not exists company_lessons_learned (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  fallo_autopsy_id uuid not null references fallo_autopsies (id) on delete cascade,
  tender_id uuid not null references tenders (id) on delete cascade,
  lesson_text text not null,
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists ix_company_lessons_learned_org on company_lessons_learned (org_id, created_at);

alter table fallo_autopsies enable row level security;
alter table company_lessons_learned enable row level security;

do $$
declare
  all_roles org_role[] := '{owner,admin,analyst,writer,reviewer,viewer}';
  write_roles org_role[] := '{owner,admin,analyst,writer,reviewer}';
begin
  perform app.apply_org_rls('fallo_autopsies', all_roles, write_roles);
  perform app.apply_org_rls('company_lessons_learned', all_roles, write_roles);
end;
$$;
