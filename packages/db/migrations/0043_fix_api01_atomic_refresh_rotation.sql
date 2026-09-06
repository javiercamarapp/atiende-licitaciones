-- 0043_fix_api01_atomic_refresh_rotation.sql
-- Soporta el cierre de API-01/API-09 (docs/auditoria-1/db-api-reverificacion.md):
-- `POST /auth/refresh` hacía SELECT (`app.find_refresh_token`) y UPDATE
-- (`app.revoke_refresh_token`) en transacciones SEPARADAS, sin verificar
-- `rowCount` del UPDATE antes de emitir tokens nuevos -- contra el pool de
-- Postgres de producción (`pg.Pool({max:10})`, `packages/db/src/driver.ts`)
-- esto es una ventana TOCTOU real: dos peticiones de refresh concurrentes
-- con el MISMO token podían leer "no revocado" ambas antes de que
-- cualquiera revocara, y ambas terminar emitiendo tokens nuevos válidos
-- (dos sesiones hijas del mismo refresh, en vez de detectar el reuso).
--
-- Corrección: una única función `SECURITY DEFINER` que hace
-- check-y-mutación ATÓMICOS en una sola sentencia
-- (`UPDATE ... WHERE token_hash=$1 AND revoked_at IS NULL RETURNING`),
-- confiando en el bloqueo de fila de Postgres para serializar rotaciones
-- concurrentes del mismo token: solo UNA puede ganar la carrera y ver
-- `revoked_at IS NULL` en el momento del UPDATE; la otra ve 0 filas
-- afectadas.
--
-- Detección de reuso: si el UPDATE afecta 0 filas porque el token YA
-- estaba revocado (no porque no exista o esté expirado), es una señal de
-- robo/reuso de refresh token -- se revoca preventivamente TODA la familia
-- de sesiones activas del usuario dueño de ese token (no hay columna de
-- "familia"/cadena de rotación en el esquema actual, así que la unidad de
-- revocación defensiva es "todas las sesiones activas de ese user_id").
--
-- IMPORTANTE: en el camino de fallo la función NO usa `raise exception`,
-- sino que simplemente devuelve 0 filas (`return` sin `return query`). Un
-- `raise exception` sin capturar aborta TODA la transacción actual --
-- incluida la revocación de familia recién hecha en la misma sentencia,
-- que quedaría revertida junto con el resto (bug real detectado al
-- verificar este fix con un test de extremo a extremo: la revocación de
-- familia nunca sobrevivía al ROLLBACK implícito del RAISE). Devolver 0
-- filas dentro de la MISMA transacción permite que el UPDATE de revocación
-- de familia SÍ se confirme (COMMIT) cuando el llamador (apps/api) hace
-- commit de su transacción tras recibir un resultado vacío -- el llamador
-- decide el 401 según `rowCount`, no según una excepción.

create or replace function app.rotate_refresh_token(
  p_old_token_hash text,
  p_new_id uuid,
  p_new_token_hash text,
  p_new_expires_at timestamptz
)
returns table (user_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_reused_user_id uuid;
begin
  update refresh_tokens
     set revoked_at = now()
   where token_hash = p_old_token_hash
     and revoked_at is null
     and expires_at > now()
  returning refresh_tokens.user_id into v_user_id;

  if v_user_id is null then
    -- No se pudo rotar: o el token no existe, o ya expiró, o ya fue usado
    -- antes (reuso). Solo en este ÚLTIMO caso hay una `user_id` real detrás
    -- de un token que sigue existiendo pero con `revoked_at` no nulo.
    select rt.user_id into v_reused_user_id
      from refresh_tokens rt
     where rt.token_hash = p_old_token_hash
       and rt.revoked_at is not null;

    if v_reused_user_id is not null then
      update refresh_tokens set revoked_at = now()
       where refresh_tokens.user_id = v_reused_user_id and revoked_at is null;
    end if;

    -- Sin `raise exception` a propósito (ver nota arriba): termina la
    -- función devolviendo 0 filas, dejando que la revocación de familia de
    -- arriba (si ocurrió) se confirme con el COMMIT del llamador.
    return;
  end if;

  insert into refresh_tokens (id, user_id, token_hash, expires_at)
  values (p_new_id, v_user_id, p_new_token_hash, p_new_expires_at);

  return query select v_user_id;
end;
$$;

revoke execute on function app.rotate_refresh_token(text, uuid, text, timestamptz) from public;
grant execute on function app.rotate_refresh_token(text, uuid, text, timestamptz) to app_role;
