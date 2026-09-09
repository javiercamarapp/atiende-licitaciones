-- 0097_rate_limit_buckets.sql
-- Bloqueo B-08 (D-11, despliegue serverless en Vercel): `@fastify/rate-limit`
-- (apps/api/src/app.ts) usa por defecto un `LocalStore` en memoria del
-- PROCESO -- correcto con un único proceso de larga duración, pero roto en
-- cuanto hay más de una instancia sirviendo tráfico (cada invocación
-- serverless de Vercel puede ser una instancia de Node distinta, sin
-- memoria compartida): un atacante (o simplemente el tráfico normal
-- repartido por el balanceador) vería el límite real multiplicado por el
-- número de instancias vivas en cada momento, nunca el límite documentado
-- en `rate-limit-settings.ts`.
--
-- La tabla `rate_limits` ya existente (0003_system_tables.sql) NO sirve
-- para esto: exige `org_id not null references organizations`, pero el
-- tier `global` (el primero que corre, `onRequest`, antes de cualquier
-- autenticación -- ver app.ts) solo puede tener una IP como clave, sin
-- organización ni usuario resuelto todavía; los tiers `auth`/`twoFactor`
-- tampoco tienen org_id disponible antes de autenticar. Se necesita una
-- tabla sin esa dependencia, imprescindible para este bloqueo (número libre
-- tras el merge del 8-sep -- 0090 quedó tomado por 0090_req_whatsapp_user_phone.sql,
-- siguiente libre real: 0097, ver despacho de coordinación entre correctores).
--
-- Diseño: una fila por clave de limitador (`${prefijo de ruta}${ip o
-- clave de negocio}`, ver apps/api/src/lib/rate-limit-store.ts) con una
-- ventana de tiempo fija tipo "sliding-ish" -- mismo algoritmo que
-- `LocalStore`/`RedisStore` de @fastify/rate-limit (ver esos módulos en
-- node_modules/@fastify/rate-limit/store): al primer hit de la ventana se
-- fija `window_started_at = now()`; hits siguientes SOLO incrementan
-- `count` mientras `now() < window_started_at + window_ms`; si la ventana
-- ya expiró, se reinicia (`count = 1`, `window_started_at = now()`). Todo
-- en una única sentencia UPSERT atómica (ver rate-limit-store.ts) -- sin
-- ninguna lectura-luego-escritura en JS, así que es segura bajo N
-- instancias concurrentes incrementando la MISMA clave (el UPSERT de
-- Postgres serializa por fila).
create table if not exists rate_limit_buckets (
  key text primary key,
  count integer not null default 0,
  window_started_at timestamptz not null default now(),
  window_ms bigint not null,
  updated_at timestamptz not null default now()
);

-- TTL/limpieza (requerida explícitamente por el encargo): sin esto la
-- tabla crece sin límite (una fila por IP/clave distinta vista alguna vez).
-- `app.cleanup_rate_limit_buckets()` la invoca `apps/worker`
-- (`runWorkerTick`, ver src/runtime.ts) en cada tick -- barata (índice por
-- `updated_at`, filas ya vencidas hace tiempo) y ejecutarla más de una vez
-- por minuto no tiene efecto adicional.
create index if not exists ix_rate_limit_buckets_updated_at on rate_limit_buckets (updated_at);

-- RLS habilitada SIN políticas (mismo patrón que `oauth_states`,
-- 0071_req172_google_oidc.sql): esta tabla no tiene noción de
-- organización/usuario dueño -- el limitador global corre ANTES de
-- resolver ninguna sesión -- así que ningún rol de aplicación
-- (`app_role`/`worker_role`) debe poder leerla/escribirla directamente vía
-- una conexión con `SET LOCAL ROLE`. El único acceso real es la conexión
-- "cruda" de `app.db` sin cambiar de rol (mismo patrón ya documentado y
-- aceptado en `apps/api/src/modules/tenders/internal-ingest.routes.ts`
-- para `POST /internal/tenders/ingest`): el rol que ejecuta las
-- migraciones (propietario de la tabla) siempre evade RLS por definición,
-- que es exactamente la conexión que usa `rate-limit-store.ts`.
alter table rate_limit_buckets enable row level security;

create or replace function app.cleanup_rate_limit_buckets()
returns integer
language sql
as $$
  with deleted as (
    delete from rate_limit_buckets
    where updated_at < now() - interval '1 day'
    returning 1
  )
  select count(*)::integer from deleted;
$$;

comment on table rate_limit_buckets is
  'Almacén persistido en Postgres de @fastify/rate-limit (apps/api/src/lib/rate-limit-store.ts), '
  'imprescindible en despliegue serverless multi-instancia (B-08/D-11): sin esto, cada instancia '
  'de Vercel llevaría su propio contador en memoria y el límite real se multiplicaría por el '
  'número de instancias vivas.';
