# @atiende/db

Esquema SQL (Postgres) multi-tenant de Atiende Licitaciones, con RLS
(Row-Level Security) por organización y rol, y un runner de migraciones que
funciona igual sobre:

- **PGlite** (`@electric-sql/pglite`): Postgres real compilado a WASM,
  embebido, sin servidor. Se usa en desarrollo y en TODOS los tests
  (`vitest`). Ejecuta el mismo SQL que producción (mismo motor: PGlite 0.5.8
  reporta `PostgreSQL 18.3`).
- **`pg`**: driver estándar de Node contra un Postgres real, para producción.

## Arranque rápido

```bash
npm install
npm run -w packages/db test        # aplica migraciones sobre PGlite en memoria y corre 90 tests
npm run -w packages/db typecheck
npm run -w packages/db lint
```

No requiere ninguna base de datos externa ni Docker: PGlite corre en el
mismo proceso de Node.

## Uso programático

```ts
import { createPgliteClient, createPgClient, applyMigrations, withTenantContext } from '@atiende/db';

// Desarrollo/tests: en memoria.
const db = await createPgliteClient();
await applyMigrations(db); // idempotente: se puede llamar varias veces sin error

// Producción: Postgres real.
const dbProd = await createPgClient({ connectionString: process.env.DATABASE_URL! });
await applyMigrations(dbProd);

// Toda operación de negocio DEBE pasar por withTenantContext para que RLS
// aísle por organización/rol:
await withTenantContext(db, { orgId, userId }, async (tx) => {
  return tx.query('select * from tenders');
});
```

`createDbClientFromEnv(env)` elige el driver según `DATABASE_URL`:
- vacío, o `pglite://memory` → PGlite en memoria.
- `pglite:///ruta/al/directorio` → PGlite con persistencia en disco.
- `postgres://...` / `postgresql://...` → `pg` (Postgres real).

## Cómo se aplica a un Postgres real (producción)

1. Define `DATABASE_URL=postgres://usuario:password@host:5432/basededatos`.
2. Ejecuta el runner una vez (por ejemplo, en el paso de despliegue o al
   arrancar `apps/api` si `SKIP_MIGRATIONS` no es `true`):
   ```ts
   import { createPgClient, applyMigrations } from '@atiende/db';
   const db = await createPgClient({ connectionString: process.env.DATABASE_URL! });
   await applyMigrations(db);
   ```
3. El usuario de conexión que ejecuta las migraciones debe poder hacer DDL
   (`CREATE TABLE`, `CREATE ROLE`, etc.) — normalmente el propietario de la
   base de datos. **El runtime de la API nunca debe conectarse con ese
   usuario**: cada request usa `SET LOCAL ROLE app_role` (rol sin privilegios
   de superusuario ni de propietario, creado por la migración 0001) para que
   las políticas RLS de 0007/0008/0016 se apliquen de verdad.
4. Las migraciones son idempotentes: reintentar `applyMigrations` (por
   ejemplo tras un despliegue fallido a medias) no falla ni duplica nada
   (tabla de control `schema_migrations`, ver `src/migrate.ts`).

## Modelo de seguridad (RLS)

- Cada tabla de negocio tiene `org_id`. RLS se activa en TODAS ellas
  (`alter table ... enable row level security`, sin `FORCE`).
- El aislamiento se basa en dos GUCs de sesión/transacción:
  `app.current_org_id` y `app.current_user_id`, fijados con
  `set_config(..., true)` (alcance de transacción) dentro de
  `withTenantContext`.
- `app.has_role(org_id, roles[])` y `app.is_superadmin()` (tabla
  `platform_admins`) son funciones `SECURITY DEFINER` que deciden qué puede
  ver/escribir cada política. Ver `migrations/0007_rls_functions.sql` para el
  razonamiento completo (incluye por qué NO se usa `FORCE ROW LEVEL
  SECURITY`: permite que esas funciones, propiedad del rol que corre las
  migraciones, lean `memberships`/`platform_admins` sin recursión).
- **Importante para quien escriba nuevas queries**: si el código de la API se
  conecta sin `SET LOCAL ROLE app_role` (por ejemplo usando el cliente crudo
  de migraciones), sigue siendo el propietario/superusuario de las
  migraciones y **todas las políticas RLS se ignoran silenciosamente**. Este
  fue el primer bug real encontrado durante la construcción (ver spike en el
  historial): PGlite conecta por defecto como el superusuario `postgres`.
- Gotcha de Postgres (no es específico de PGlite, se probó en PG 18 vía
  PGlite pero aplica igual en cualquier Postgres): un `INSERT ... RETURNING`
  exige que la fila insertada también sea visible por la política de
  `SELECT`, o lanza el mismo error 42501 de RLS. Por eso las rutas de
  "bootstrap" (crear una organización y auto-asignarse como owner, o
  registrar un usuario) generan el `id` en la aplicación (`randomUUID()`) y
  hacen el `INSERT` sin `RETURNING`.

## Migraciones (`migrations/*.sql`, numeradas)

| Rango | Contenido |
|---|---|
| 0001–0004 | Bootstrap (esquema `app`, rol `app_role`), tenancy (organizations/users/memberships/invitations/api_keys/platform_admins), tablas de sistema (audit_log/idempotency_keys/jobs/rate_limits), agentes (agent_runs/tool_calls). |
| 0005–0006 | Dominio de licitaciones: tenders, tender_matches, go_no_go_decisions, tender_documents, requirement_items, compliance_items, proposals, proposal_sections, reviews, submissions, post_award_followups. |
| 0007–0009 | Funciones de RLS (`app.has_role`, `app.is_superadmin`, `app.apply_org_rls`), políticas RLS de todas las tablas, índices adicionales. |
| 0010 | Funciones de soporte para la API (login sin contexto previo, resolución de organización desde `X-Org-Id`, listado de "mis organizaciones"). |
| 0011–0016 | Ampliación back office (ver `docs/AMPLIACION-BACKOFFICE.md`): perfil de empresa y procedencia por campo, versionado de convocatorias e invalidación de dependientes, `source_runs` (plataforma), catálogo de precios aprobados con enforcement por trigger, aprobaciones de propuesta y manifiesto de paquete final. |

El runner (`src/migrate.ts`) aplica los archivos en orden alfabético,
registra cada uno en `schema_migrations` y **lanza un error explícito** si
detecta que una migración ya aplicada cambió de contenido (protección contra
editar una migración ya desplegada en vez de crear una nueva).

## Límites conocidos de PGlite (verificados con pruebas reales, no supuestos)

1. **Una sola conexión/proceso** (como SQLite): no hay múltiples backends
   concurrentes de verdad. Esto afecta al test de `jobs` (cola con `FOR
   UPDATE SKIP LOCKED`): no se puede abrir una segunda conexión física
   simultánea contra la misma instancia para reproducir una carrera de
   sistema operativo real. El test (`test/jobs-locking.test.ts`) sí valida el
   invariante real que protege de doble procesamiento (la sentencia de
   reclamo es un único `UPDATE` atómico con subquery `FOR UPDATE SKIP
   LOCKED`), pero la concurrencia de SO no está probada en este entorno (no
   hay Postgres/Docker disponibles aquí). Queda documentado como pendiente
   de una prueba adicional contra `pg` real si se dispone de un Postgres de
   pruebas.
2. **El superusuario `postgres` (rol por defecto de la conexión) bypassa RLS
   siempre**, con o sin `FORCE ROW LEVEL SECURITY`. Verificado con un spike
   antes de construir el esquema (ver comentarios en 0001/0008). Por eso el
   runtime de la API SIEMPRE hace `SET LOCAL ROLE app_role`.
3. **`CREATE EXTENSION pgcrypto` no está disponible** por defecto en el
   build de PGlite usado (`extension "pgcrypto" is not available"`). No hizo
   falta: `gen_random_uuid()` ya es una función núcleo desde Postgres 13, sin
   extensión (confirmado: PGlite 0.5.8 = Postgres 18.3).
4. No se probó la extensión `citext`; se evitó por completo usando `text` +
   índice único sobre `lower(email)`.

Ninguna de estas limitaciones afecta el comportamiento en Postgres real
(`pg`): las mismas migraciones y el mismo modelo de roles/RLS aplican sin
cambios.

## Tests adversariales (`test/*.test.ts`, 90 casos)

- `migrate.test.ts`: las migraciones se aplican sin error y son idempotentes
  (aplicar dos veces no falla ni duplica).
- `rls-isolation.test.ts`: **34 tablas de dominio** (bucle genérico sobre
  `DOMAIN_TABLES` en `test/helpers.ts`), 2 pruebas cada una: un owner de la
  organización A no ve/edita/borra filas de la organización B, y sin
  contexto de sesión no se ve nada.
- `rls-roles.test.ts`: viewer no puede escribir, writer no puede aprobar
  go/no-go, superadmin ve todo, un usuario normal no puede auto-nombrarse
  superadmin.
- `org-bootstrap.test.ts`: un usuario nuevo puede crear una organización y
  auto-asignarse owner (caso especial de bootstrap), pero un outsider no
  puede colarse en una organización ya poblada aunque fuerce el `org_id`.
- `idempotency-and-audit.test.ts`: unicidad de `idempotency_keys` por
  `(org_id, key)`, e inmutabilidad de `audit_log` (nadie puede `UPDATE`/
  `DELETE`, ni siquiera el superadmin, vía RLS).
- `jobs-locking.test.ts`: reclamo seguro de jobs (ver limitación #1 arriba).
- `backoffice-extension.test.ts`: reglas de negocio a nivel de esquema de la
  ampliación (trigger que impide referenciar una tarifa no aprobada,
  constraint que impide un paquete "ready" sin checklist, dedupe de
  versiones de convocatoria, `source_runs` visible solo para superadmin,
  invalidación de una propuesta por cambio de bases).

## Pendiente / fuera de alcance de esta ronda

- Endpoints de `apps/api` para las tablas de la ampliación back office
  (perfil de empresa, versiones de convocatoria, precios, aprobaciones,
  paquete final): solo se construyó el **esquema + RLS + tests** en
  `packages/db`, según lo acordado con el coordinador si el tiempo no
  alcanzaba para ambas capas en la misma ronda.
- Prueba de concurrencia de `jobs` contra un Postgres real con múltiples
  conexiones físicas (no disponible en este entorno).
- No se probó "accept invitation" (aceptar invitación) como flujo de la API;
  la tabla `invitations` y su `status` ya existen para ese flujo futuro.
