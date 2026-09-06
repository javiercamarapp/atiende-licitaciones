-- 0023_fix_db06_audit_log_hash_chain.sql
-- Corrige DB-06 (docs/auditoria-1/db-api.md, MEDIA): `audit_log` es
-- append-only (RLS sin política UPDATE/DELETE, verificado por mutación en
-- la auditoría), pero no tenía "hash encadenado" -- REQ-083 solo cumplido a
-- medias.
--
-- Diseño: cadena GLOBAL (no por organización) en orden de inserción real,
-- usando `sha256()` NÚCLEO de Postgres (disponible desde PG11, sin
-- necesidad de la extensión `pgcrypto`, que packages/db/README.md ya
-- documenta como no disponible en el build de PGlite usado). Cada fila
-- guarda `prev_hash` (el `hash` de la fila anterior, o NULL si es la
-- primera) y `hash` (sha256 de `prev_hash` concatenado con una
-- serialización estable de sus propios campos). Un `pg_advisory_xact_lock`
-- serializa inserciones concurrentes para que la cadena sea correcta incluso
-- con escrituras simultáneas en Postgres real (no solo en PGlite,
-- monoconexión).
--
-- `app.verify_audit_log_chain()` recorre la tabla en orden y recalcula cada
-- hash: si alguno no coincide con el guardado (fila manipulada fuera de los
-- canales normales, p.ej. por un superusuario que bypasea RLS), reporta
-- `ok=false` y el `id` de la primera fila rota -- uso previsto en CI, tal
-- como pide el criterio verificable de REQ-083.

-- `chain_seq`: orden de inserción REAL, estrictamente monótono
-- (bigserial), usado para determinar "la fila anterior" sin ambigüedad.
-- `created_at` (timestamptz) no sirve por sí solo para esto: dos INSERT en
-- la misma transacción (o muy próximos) pueden compartir el mismo valor de
-- `now()`, y desempatar por `id` (UUID aleatorio) no produce el mismo orden
-- al insertar (se necesitaría el máximo) que al verificar en orden
-- ascendente (se necesitaría el mínimo) -- eso rompería la cadena de forma
-- espuria ante timestamps empatados, no por manipulación real.
alter table audit_log add column if not exists chain_seq bigserial;
alter table audit_log add column if not exists prev_hash text;
alter table audit_log add column if not exists hash text;

create unique index if not exists ux_audit_log_chain_seq on audit_log (chain_seq);

create or replace function app.audit_log_row_payload(r audit_log)
returns text
language sql
immutable
as $$
  select coalesce(r.org_id::text, '') || '|' ||
         coalesce(r.actor_id::text, '') || '|' ||
         r.action || '|' ||
         r.entity || '|' ||
         coalesce(r.entity_id, '') || '|' ||
         coalesce(r.before::text, '') || '|' ||
         coalesce(r.after::text, '') || '|' ||
         coalesce(r.request_id, '') || '|' ||
         r.created_at::text
$$;

create or replace function app.audit_log_chain_insert()
returns trigger
language plpgsql
as $$
declare
  v_prev_hash text;
begin
  -- Serializa inserciones concurrentes para que "la fila anterior" sea
  -- siempre determinista incluso con transacciones simultáneas.
  perform pg_advisory_xact_lock(hashtext('atiende_audit_log_chain'));

  select hash into v_prev_hash from audit_log order by chain_seq desc limit 1;

  new.prev_hash := v_prev_hash;
  new.hash := encode(sha256(convert_to(coalesce(v_prev_hash, '') || '|' || app.audit_log_row_payload(new), 'UTF8')), 'hex');

  return new;
end;
$$;

drop trigger if exists trg_audit_log_chain_insert on audit_log;
create trigger trg_audit_log_chain_insert
  before insert on audit_log
  for each row execute function app.audit_log_chain_insert();

-- SECURITY DEFINER + guard de superadmin: esta función necesita ver TODAS
-- las filas de TODAS las organizaciones para verificar la cadena completa
-- (la RLS normal de audit_log restringe cada organización a sus propias
-- filas). Se ejecuta como el propietario de las migraciones (que no tiene
-- RLS aplicada) pero solo si quien llama ya es superadmin -- mismo patrón
-- que app.is_superadmin()/app.source_freshness(). Herramientas de CI/ops
-- que corran con las credenciales de propietario (fuera de app_role, como
-- ya hace `applyMigrations`) también pueden invocarla directamente sin
-- pasar por este guard, igual que cualquier otra función de este esquema.
create or replace function app.verify_audit_log_chain()
returns table (ok boolean, broken_at uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  rec audit_log%rowtype;
  v_prev_hash text := null;
  v_expected text;
begin
  if app.current_user_id() is not null and not app.is_superadmin() then
    raise exception 'verify_audit_log_chain_requires_superadmin';
  end if;

  for rec in select * from audit_log order by chain_seq asc loop
    if rec.prev_hash is distinct from v_prev_hash then
      return query select false, rec.id;
      return;
    end if;

    v_expected := encode(sha256(convert_to(coalesce(v_prev_hash, '') || '|' || app.audit_log_row_payload(rec), 'UTF8')), 'hex');
    if rec.hash is distinct from v_expected then
      return query select false, rec.id;
      return;
    end if;

    v_prev_hash := rec.hash;
  end loop;

  return query select true, null::uuid;
end;
$$;
