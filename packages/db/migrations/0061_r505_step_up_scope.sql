-- 0061_r505_step_up_scope.sql
-- R5-05 (docs/auditoria-2/api-ronda5.md, BAJA-MEDIA, diseño): `step_up_sessions`
-- no tenía columna ni comprobación de organización/acción concreta -- un
-- `stepUpToken` emitido una vez era reutilizable, dentro de la ventana de
-- vigencia, para aprobar CUALQUIER número de tarifas/expedientes distintos,
-- en cualquier organización de la que el usuario fuera miembro. Esto es
-- coherente con el diseño declarado para el caso "genérico" (2FA es de
-- cuenta, no de organización, ver docstring del módulo) -- por eso ambas
-- columnas son NULLABLE y opcionales: una sesión creada SIN `orgId`/`purpose`
-- explícitos sigue funcionando exactamente igual que antes de esta ronda
-- (nunca rompe un cliente existente). Un cliente que SÍ los declare al
-- pedir el step-up (ver `modules/twofa/routes.ts`) obtiene una sesión
-- atada a esa organización/acción concreta -- `requireStepUp`
-- (lib/step-up.ts) rechaza consumirla para una organización/acción
-- distinta.
alter table step_up_sessions add column if not exists org_id uuid references organizations (id) on delete cascade;
alter table step_up_sessions add column if not exists purpose text;

create index if not exists ix_step_up_sessions_org on step_up_sessions (org_id) where org_id is not null;
