-- 0062_r509_step_up_mandatory_scope.sql
-- R5-09 (docs/auditoria-2/api-ronda5-reverificacion.md, BAJA-MEDIA): la
-- reverificación adversarial de ronda 5 confirmó que el alcance opcional de
-- `step_up_sessions` (org_id/purpose NULLABLE, migración 0061) NUNCA se
-- activaba en el flujo real de `apps/web` -- ningún cliente declaraba
-- `X-Org-Id`/`purpose` al pedir un step-up, así que TODA sesión emitida en
-- producción quedaba "genérica" y `requireStepUp` (lib/step-up.ts) nunca
-- aplicaba ninguna restricción: el riesgo original de R5-05 (un mismo
-- `stepUpToken` aprueba cualquier tarifa/expediente en cualquier
-- organización del usuario, dentro de la ventana de vigencia) seguía
-- completamente vigente en la práctica.
--
-- Esta migración cierra el hueco a nivel de esquema (el fix real de
-- `apps/api` -- exigir ambos campos al crear la sesión, ver
-- `modules/twofa/routes.ts` -- no puede, por sí solo, invalidar sesiones
-- YA emitidas antes del despliegue):
--   1. Cualquier sesión preexistente sin `org_id`/`purpose` (creada bajo el
--      diseño opcional de R5-05) es, por definición, una sesión "genérica"
--      -- se ELIMINA (no se puede "rellenar" retroactivamente con un
--      org/purpose real sin inventar datos que el usuario nunca declaró).
--      `step_up_sessions` es una tabla de sesiones efímeras (vigencia de
--      minutos, ver STEP_UP_WINDOW_MINUTES) -- borrar una fila vieja aquí
--      nunca pierde información de negocio real, a diferencia de borrar de
--      una tabla de registro/auditoría.
--   2. `org_id`/`purpose` pasan a NOT NULL: ninguna sesión nueva puede
--      volver a quedar "genérica", cualquiera sea el cliente.
--   3. `consumed_at` (nueva columna, NULL hasta que la sesión se usa):
--      una sesión de step-up ahora es de UN SOLO USO -- `requireStepUp`
--      la marca consumida atómicamente (UPDATE ... WHERE consumed_at IS
--      NULL, mismo patrón que `app.rotate_refresh_token`) la primera vez
--      que autoriza una acción, y rechaza cualquier reintento posterior
--      con el MISMO `stepUpToken`, aunque siga vigente y el
--      org/purpose/usuario coincidan.
delete from step_up_sessions where org_id is null or purpose is null;

alter table step_up_sessions add column if not exists consumed_at timestamptz;

alter table step_up_sessions alter column org_id set not null;
alter table step_up_sessions alter column purpose set not null;

-- Consultas típicas de `requireStepUp` filtran por sesiones NO consumidas
-- todavía; índice parcial acorde (mismo criterio que ix_step_up_sessions_org).
create index if not exists ix_step_up_sessions_unconsumed on step_up_sessions (id) where consumed_at is null;
