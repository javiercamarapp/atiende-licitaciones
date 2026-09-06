# @atiende/api

API HTTP de Atiende Licitaciones (ronda 1: salud, autenticación,
organizaciones). Fastify + TypeScript + Zod (`fastify-type-provider-zod`) +
`@fastify/swagger` (OpenAPI en `/docs/json`) + logs `pino` con `request_id` +
`@fastify/rate-limit`. Persistencia vía `@atiende/db` (PGlite en desarrollo y
tests, Postgres real vía `pg` en producción — ver `packages/db/README.md`).

## Arranque

```bash
cp apps/api/.env.example apps/api/.env   # ajusta JWT_SECRET al menos
npm install
npm run -w apps/api dev                  # tsx watch, PGlite en memoria por defecto
```

```bash
npm run -w apps/api typecheck
npm run -w apps/api lint
npm run -w apps/api test                 # integración con fastify.inject + PGlite
```

## Variables de entorno (ver `.env.example`)

| Variable | Obligatoria | Descripción |
|---|---|---|
| `JWT_SECRET` | Sí | Secreto HS256 para firmar/verificar JWT (mín. 16 caracteres). |
| `PORT` | No (3000) | Puerto HTTP. |
| `DATABASE_URL` | No (PGlite en memoria) | `pglite://memory`, `pglite:///ruta` o `postgres://...` (ver `packages/db`). |
| `NODE_ENV` | No (development) | En `production`, los 500 no filtran mensaje/stack interno. |
| `SKIP_MIGRATIONS` | No (false) | Si es `true`, la API no aplica migraciones al arrancar (útil si se aplican en un paso de despliegue separado). |

## Cómo se conecta a un Postgres real en producción

Define `DATABASE_URL=postgres://usuario:password@host:5432/basededatos`. El
arranque (`src/index.ts` → `buildApp`) llama a `createDbClientFromEnv` (usa
`pg`) y, si `SKIP_MIGRATIONS` no es `true`, aplica las migraciones de
`packages/db` automáticamente (idempotente). El usuario de esa cadena de
conexión debe poder hacer DDL (ver `packages/db/README.md`); **el runtime de
cada request usa `SET LOCAL ROLE app_role`** internamente, nunca ese usuario
con privilegios de migración, para que RLS aísle de verdad.

## Módulos (ronda 1)

- **health**: `GET /healthz` (liveness, no toca DB), `GET /readyz` (verifica
  DB con `select 1`, responde 503 si falla).
- **auth**: `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`.
  Contraseñas con `scrypt` (`node:crypto`, sin dependencias nativas — ver
  nota de diseño abajo). JWT firmados con `jose` (access 15 min, refresh 30
  días, ambos HS256).
- **organizations**: `POST /organizations` (crear), `GET /organizations`
  (listar las mías con mi rol), `POST /organizations/invitations` (invitar,
  requiere `X-Org-Id` + rol owner/admin), `PATCH
  /organizations/memberships/:userId` (cambiar rol, owner/admin).
- **me**: `GET /me`.

Todas las rutas devuelven errores en `application/problem+json` (RFC 7807):
`{ type, title, status, detail?, requestId }`. En producción, un error 500
nunca expone mensaje interno ni stack (`lib/errors.ts` +
`plugins/error-handler.ts`).

## Decisiones de diseño relevantes

- **Contraseñas con `scrypt` en vez de argon2/bcrypt**: ambos requieren
  compilar un binario nativo, lo que es un riesgo real de build en un
  sandbox/CI sin toolchain garantizada. `scrypt` (módulo estándar de Node,
  memory-hard) da garantías equivalentes sin esa dependencia nativa. Ver
  `src/lib/passwords.ts`.
- **Resolución de organización (`X-Org-Id`)**: el middleware `app.requireOrg`
  valida el header contra la membresía real llamando a la función SQL
  `app.membership_role(org_id, user_id)` (`SECURITY DEFINER`, ver
  `packages/db`) — nunca confía en el header sin verificar contra la base de
  datos.
- **Contexto de tenant por transacción**: cada operación de negocio abre su
  propia transacción con `SET LOCAL ROLE app_role` + `set_config` de
  `app.current_org_id`/`app.current_user_id`, para que las políticas RLS de
  `packages/db` sean la última línea de defensa (incluso si hubiera un bug
  en la autorización de la ruta).
- **Idempotencia (`Idempotency-Key`)**: implementada y probada en el
  endpoint de invitación (`POST /organizations/invitations`, ver
  `src/lib/idempotency.ts`). Misma clave + mismo cuerpo → misma respuesta sin
  reejecutar; misma clave + cuerpo distinto → 422. **Alcance limitado**: solo
  cubre mutaciones que ya tienen `org_id` resuelto, porque
  `idempotency_keys.org_id` es `NOT NULL`. `POST /organizations` (crear org)
  y `POST /auth/register` quedan fuera de este mecanismo en esta ronda —
  pendiente si se necesita, requeriría permitir `org_id` nulo o una clave de
  idempotencia por usuario.
- **Rate limit**: límite global por IP (100/min, `@fastify/rate-limit`) más
  un override estricto en `POST /auth/login` (5/min) para mitigar fuerza
  bruta, probado en `test/rate-limit-and-health.test.ts`. **Alcance
  limitado**: un límite verdaderamente por organización/usuario autenticado
  requeriría resolver esa identidad en el hook `onRequest` (antes de que
  corran los `preHandler` de autenticación), lo que esta ronda no implementa;
  la tabla `rate_limits` de `packages/db` ya existe para ese uso futuro
  (contador persistente por org/subject/ruta/ventana).
- **Auditoría**: `recordAudit` (`src/lib/audit.ts`) se llama explícitamente
  dentro de la misma transacción de cada mutación implementada (crear
  organización, invitar, cambiar rol) — no hay un hook genérico automático
  todavía; extenderlo a nuevas mutaciones significa llamar a `recordAudit`
  dentro de su transacción.

## Tests de integración (`test/*.test.ts`, `fastify.inject` + PGlite, 12 casos)

- `auth-and-orgs-flow.test.ts`: registro (201) y duplicado (409); login
  correcto/incorrecto (200/401); refresh; flujo completo crear org → `/me` →
  invitar → cambiar rol, con verificación de que se registró auditoría.
- `isolation-and-idempotency.test.ts`: un owner de la organización A recibe
  403 al intentar operar sobre la organización B vía `X-Org-Id` forjado (y no
  se crea ninguna fila en B); idempotencia (misma clave/mismo cuerpo replica
  respuesta sin duplicar fila; misma clave/cuerpo distinto → 422).
- `rate-limit-and-health.test.ts`: 429 tras 5 intentos de login en la misma
  ventana; `/healthz` 200 sin tocar DB; `/readyz` 200 con DB disponible y 503
  si se cierra la conexión.

## Pendiente / fuera de alcance de esta ronda

- No hay endpoint para aceptar invitaciones (la tabla ya soporta el flujo).
- No hay revocación de refresh tokens (son JWT stateless; una lista de
  revocación o rotación con almacenamiento sería el siguiente paso).
- No se expusieron endpoints para las tablas de la ampliación back office
  (perfil de empresa, versiones de convocatoria, precios aprobados,
  aprobaciones, paquete final) — esa ronda solo alcanzó para el esquema +
  RLS + tests en `packages/db` (ver su README).
- Idempotencia y rate limit por org/usuario con alcance completo (ver
  decisiones de diseño arriba).
