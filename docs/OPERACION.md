# Operación — Atiende Licitaciones (runbook)

Runbook operativo real (basado en el código existente hoy, no en un plan
aspiracional). Ninguna sección de este documento fue "ejecutada" para
producirlo: es documentación de cómo operar el sistema tal como está
construido, sin inventar infraestructura que no existe (no hay Kubernetes,
Terraform ni pipeline de despliegue commiteado en este repo — ver "Límites
conocidos"). Para el estado de integraciones externas ver `README.md` §
"Estado real de integraciones".

## 1. Despliegue (descripción, sin ejecutar nada)

No hay infraestructura de despliegue (Dockerfile, IaC, pipeline de release)
commiteada en este repositorio a la fecha de este documento. Cada app se
compila y arranca como un proceso Node estándar:

```bash
npm ci
npm run build --workspace=apps/api      # tsc -p tsconfig.json -> dist/
npm run build --workspace=apps/worker   # idem
npm run build --workspace=apps/web      # tsc -b && vite build -> dist/ (estático)
```

- **`apps/api`**: `node dist/index.js` (o `npm run -w apps/api start`).
  Necesita `JWT_SECRET`, `DATABASE_URL` (Postgres real en producción) y el
  resto de variables de `apps/api/.env.example`. Al arrancar, si
  `SKIP_MIGRATIONS` no es `true`, aplica las migraciones de `packages/db`
  automáticamente (`createDbClientFromEnv` + `applyMigrations`, ver
  `apps/api/src/index.ts`).
- **`apps/worker`**: `node dist/index.js` (o `npm run -w apps/worker start`).
  Mismo mecanismo de migraciones automáticas; necesita `DATABASE_URL`,
  `API_BASE_URL`/`PLATFORM_API_KEY` para hablar con `apps/api`, y
  opcionalmente `OPENAI_API_KEY` (ver "Estado real de integraciones" en el
  README — sin esa variable usa `FakeProvider`, determinista y sin red).
- **`apps/web`**: es un sitio estático tras `npm run -w apps/web build`
  (`dist/`) — se sirve con cualquier servidor de estáticos/CDN detrás de
  `VITE_API_URL` apuntando a `apps/api`. `npm run -w apps/web preview` sirve
  ese build localmente para verificarlo antes de publicarlo.

**Orden recomendado** (si se despliega manualmente): 1) aplicar migraciones
(o dejar que `apps/api`/`apps/worker` las apliquen al arrancar, nunca ambos
a la vez de forma descoordinada la primera vez — ver §2), 2) `apps/api`,
3) `apps/worker`, 4) `apps/web` (estático, sin dependencia de orden real).

## 2. Migraciones

- Runner: `packages/db/src/migrate.ts` (`applyMigrations`). Aplica los
  archivos de `packages/db/migrations/*.sql` **en orden alfabético, uno por
  uno**, registrando cada uno en la tabla de control `schema_migrations`
  (nombre + checksum sha256).
- **Idempotente**: reintentar `applyMigrations` tras un despliegue fallido a
  medias no falla ni duplica nada — las ya aplicadas se saltan.
- **Protección contra edición de migraciones ya desplegadas**: si el
  contenido de un archivo ya registrado cambió (checksum distinto), el
  runner **lanza un error explícito** en vez de reaplicarlo. La corrección
  correcta es SIEMPRE una migración nueva, nunca editar una ya aplicada.
- **Cómo aplicarlas manualmente** (por ejemplo en un paso de despliegue
  separado, con `SKIP_MIGRATIONS=true` en las apps):
  ```bash
  DATABASE_URL=postgres://usuario:password@host:5432/basededatos \
    npx tsx scripts/db-postgres-migrate.mjs
  ```
  (Ese mismo script es el que corre el job `db-postgres` de CI contra un
  Postgres de servicio — ver `.github/workflows/quality.yml` — y es seguro
  de usar contra producción: usa la misma API pública `@atiende/db` que usan
  `apps/api`/`apps/worker` al arrancar, solo que sin arrancar el proceso
  completo.)
- **Usuario de conexión**: debe poder hacer DDL (`CREATE TABLE`, `CREATE
  ROLE`, etc. — normalmente el propietario de la base de datos). El runtime
  de cada request de `apps/api` **nunca** debe conectarse con ese usuario:
  usa `SET LOCAL ROLE app_role` (rol sin privilegios elevados, creado por
  `0001_bootstrap.sql`) para que las políticas RLS se apliquen de verdad
  (ver `packages/db/README.md` § "Modelo de seguridad").
- **Rollback**: no existe un mecanismo de "down migration" en este runner
  (las migraciones son solo hacia adelante). Revertir un cambio de esquema
  significa escribir una migración nueva que deshaga el efecto — nunca
  editar ni borrar una migración ya aplicada en un entorno con datos.

## 3. Variables de entorno

Ver `README.md` § "Variables de entorno" para la lista completa por app y
`apps/*/.env.example` para el detalle línea por línea. Resumen de las que
importan operativamente:

| Variable | App(s) | Efecto operativo |
|---|---|---|
| `DATABASE_URL` | api, worker | `pglite://memory` (dev/test) o `postgres://...` (producción real). Sin esta variable en producción, el proceso usa PGlite en memoria — **se pierde todo al reiniciar**: nunca dejar así en producción. |
| `SKIP_MIGRATIONS` | api, worker | Si `true`, el proceso NO aplica migraciones al arrancar (usar cuando las migraciones se aplican en un paso de despliegue separado, ver §2). |
| `JWT_SECRET` | api | Rotar invalida TODOS los tokens vigentes (access y refresh) de inmediato — ver §7 "Rotación de secretos". |
| `PLATFORM_API_KEY` | api, worker | Autentica `apps/worker` contra `POST /internal/tenders/ingest`. Sin definirla en `apps/api`, ese endpoint **rechaza toda solicitud** (falla cerrado). Debe ser el MISMO valor en ambos procesos. |
| `CORS_ORIGINS` | api | Vacío = ningún origen cross-site permitido. Ajustar antes de exponer `apps/web` en un dominio real. |
| `OPENAI_API_KEY` | worker | Si no está definida, `run_agent` usa `FakeProvider` (sin red, determinista) — ver "Estado real de integraciones" en el README: esta integración NO se ha ejercitado contra la API real de OpenAI en este repositorio. |
| `WORKER_LEASE_SECONDS` / `WORKER_HEARTBEAT_INTERVAL_MS` | worker | Ver §6 "Jobs" — controlan cuándo un job `running` se considera abandonado. |
| `LOG_LEVEL` | worker | `trace..fatal` (pino). |

## 4. Healthchecks

- **`GET /healthz`** (`apps/api/src/modules/health/routes.ts`): liveness,
  responde `{status:"ok"}` sin tocar la base de datos. Úsalo para el
  liveness probe del orquestador de procesos (reinicia el proceso si esto
  falla o cuelga).
- **`GET /readyz`**: readiness real — ejecuta `select 1` contra la base de
  datos. Responde `200 {status:"ok"}` si la DB responde, **`503`
  `{status:"error", detail:"database unreachable"}`** si no. Úsalo para el
  readiness probe (saca la instancia del balanceador si esto falla, sin
  reiniciar el proceso).
- **`GET /metrics`** (`apps/api/src/plugins/metrics.plugin.ts`): formato
  Prometheus (`prom-client`). Expone `atiende_http_request_duration_seconds`
  (histograma) y `atiende_http_requests_total` (contador), ambos con
  etiquetas `method`/`route`/`status_code` **a propósito sin ningún dato de
  tenant** (sin `org_id`, `user_id`, email — ver REQ-086/REQ-169) más las
  métricas default de Node/proceso (`client.collectDefaultMetrics`). Ruta
  oculta del OpenAPI (`schema: { hide: true }`), pero sin autenticación
  propia — restringe el acceso a `/metrics` a la red interna/scraper de
  Prometheus vía firewall/proxy, no vía la API misma.
- **`apps/worker`** no expone un puerto HTTP propio en esta ronda: su salud
  se observa vía logs estructurados (ver §5) y la tabla `jobs`/`source_runs`
  (ver §6) — no hay un `/healthz` de worker todavía (pendiente, ver §9
  Límites conocidos).

## 5. Logs y correlación

- **`apps/api`**: logger Fastify/pino por defecto; cada request lleva
  `request.id` (Fastify lo genera si no llega `X-Request-Id`/similar). Los
  errores no controlados se registran con `request.log.error({ err,
  requestId }, 'unhandled error')` (`plugins/error-handler.ts`) y el mismo
  `requestId` viaja en el cuerpo del error `application/problem+json` (RFC
  7807) que recibe el cliente — úsalo para correlacionar un reporte de
  usuario con la línea de log exacta. Las mutaciones auditadas
  (`recordAudit`, `lib/audit.ts`) guardan ese `request_id` en la fila de
  `audit_log`.
- **`apps/worker`**: logger raíz `pino` (`src/logger.ts`, `base: {app:
  "atiende-worker"}`). Cada job procesado deriva un logger hijo con
  `logger.child({ job_id, correlation_id, kind, attempts })`
  (`queue/worker.ts`) — TODAS las líneas de esa ejecución del job comparten
  esos campos, así que filtrar por `job_id` (o `correlation_id`, hoy igual a
  `job.id`) reconstruye el historial completo de un job específico en
  cualquier agregador de logs (grep, o un backend real tipo Loki/CloudWatch
  si se conecta uno). `run-agent.ts` propaga `correlationId: job.id` también
  al `AgentRunner` de `packages/agents`, para correlacionar sus trazas.
- **Redacción de PII/secretos**: no hay un redactor de logs genérico
  verificado en este repo todavía (pendiente — ver §9). No loguees el
  cuerpo completo de requests que puedan traer contraseñas/tokens sin
  revisar antes que el logger de Fastify no los incluya por defecto.
- **Sin backend de logs centralizado configurado**: hoy los logs van a
  stdout/stderr del proceso (formato JSON de pino) — la agregación real
  (Loki, CloudWatch, Datadog, etc.) es responsabilidad de quien despliegue,
  no está configurada en este repo.

## 6. Jobs: reintentos, dead letter y cómo reencolar

Todo en `apps/worker/src/queue/job-queue.ts` sobre la tabla `jobs`
(`packages/db/migrations/0003_system_tables.sql`, enum `job_status`:
`queued|running|succeeded|failed|dead`).

- **Reclamo atómico**: `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP
  LOCKED)` — varios workers pueden correr a la vez sin reclamar el mismo job
  dos veces.
- **Lease**: un job `running` cuyo `locked_at` es más viejo que
  `WORKER_LEASE_SECONDS` es reclamable de nuevo por otro worker.
  `heartbeat()` refresca `locked_at` periódicamente
  (`WORKER_HEARTBEAT_INTERVAL_MS`, típicamente 1/4 del lease) mientras el
  job sigue vivo — si el proceso muere sin liberar el lock, el job queda
  disponible de nuevo automáticamente después de ese tiempo, sin
  intervención manual.
- **Reintentos**: backoff exponencial + jitter simétrico
  (`queue/backoff.ts`, `computeBackoffDelayMs`). `fail(job, error)` decide
  entre reprogramar (`queued` con `next_run_at` recalculado) o pasar a
  `dead` según `attempts >= max_attempts` (default `max_attempts = 5`,
  columna de `jobs`). Errores irrecuperables conocidos usan
  `deadLetterPermanent()` para saltar directo a `dead` sin agotar reintentos
  (evita desperdiciar el backoff completo en un error que nunca se va a
  resolver reintentando).
- **Dead letter**: un job `dead` queda con `last_error` describiendo la
  causa y `locked_at`/`locked_by` en `null`. **Cómo reencolarlo
  manualmente** (no hay UI/endpoint para esto todavía — ver §9): actualizar
  la fila directamente contra la base de datos real, reseteando el conteo de
  intentos para que vuelva a tener las oportunidades completas:
  ```sql
  update jobs
     set status = 'queued', attempts = 0, next_run_at = now(), last_error = null
   where id = '<uuid del job>' and status = 'dead';
  ```
  Antes de reencolar, **diagnosticar `last_error` primero** — si la causa
  fue un bug real (no un error transitorio de red), corregirlo antes de
  reencolar evita repetir el mismo fallo `max_attempts` veces de nuevo.
- **Cancelación**: no existe un estado `cancelled` propio (ver §9): `cancel()`
  usa `dead` con `last_error` describiendo el motivo — indistinguible en la
  columna `status` de un dead-letter real; el motivo en `last_error` es lo
  que los diferencia.
- **`source_runs`** (`apps/worker/src/source-runs/`): cada corrida de
  `discover_tenders` registra una fila con estado explícito
  (`ok|failed|captcha|interface_changed|permission_missing|down`), incluso
  si el job termina en error — es la fuente de verdad para saber si una
  fuente de convocatorias está sana, no el estado del job en sí.

## 7. Rotación de secretos

No hay automatización de rotación en este repo (ni Vault, ni un cron de
rotación) — es un procedimiento manual documentado aquí:

- **`JWT_SECRET`**: rotarlo invalida de inmediato TODOS los access/refresh
  tokens vigentes (son HS256 firmados con ese secreto, sin lista de
  revocación — ver `apps/api/README.md` § Pendiente: "no hay revocación de
  refresh tokens"). Rotar en una ventana de mantenimiento anunciada, o
  aceptar que todos los usuarios deben volver a iniciar sesión.
- **`PLATFORM_API_KEY`**: compartida entre `apps/api` y `apps/worker`
  (cabecera `X-Platform-Api-Key` en `POST /internal/tenders/ingest`). Al
  rotarla, actualizar **ambos** procesos antes de que el worker vuelva a
  correr `discover_tenders`, o la ingesta empezará a fallar con 401/403 (el
  endpoint falla cerrado si la clave no coincide o no está definida). No
  hay todavía un mecanismo de rotación sin downtime (dos claves válidas a la
  vez) — pendiente, ver §9 y `apps/worker/.env.example`.
- **`OPENAI_API_KEY`**: rotar en el proveedor y actualizar la variable de
  entorno del proceso `apps/worker`; sin ella, el sistema sigue funcionando
  con `FakeProvider` (fail-safe, no fail-open: nunca llama a un proveedor
  real sin la clave).
- **Credenciales de `DATABASE_URL`**: rotar la contraseña del usuario de
  Postgres en el motor de base de datos primero, luego actualizar la
  variable en `apps/api`/`apps/worker` y reiniciar ambos procesos. El
  usuario de migraciones (con privilegios DDL) y el runtime (que hace `SET
  LOCAL ROLE app_role` por transacción) comparten hoy la misma cadena de
  conexión inicial — ver `packages/db/README.md` para el modelo de roles.
- **Nunca commitear un secreto real**: `scripts/check-secrets.sh` (también
  en CI, job `check-secrets`) grep-ea patrones conocidos (`sk-...`, claves
  privadas, tokens de Slack/GitHub, `AKIA...`, dominios `*.supabase.co`,
  cadenas `postgres://usuario:password@host` con host real) excluyendo
  `node_modules` y `*.env.example`. Correrlo localmente antes de un commit
  con `bash scripts/check-secrets.sh` (o `npm run ci:check-secrets`).

## 8. Respaldo / restauración

No hay un mecanismo de backup automatizado configurado en este repo (es
responsabilidad de la infraestructura de Postgres real que se use en
producción — ninguna existe todavía, ver §9). Recomendación operativa
mínima con las herramientas estándar de Postgres, hasta que se defina algo
más específico:

- **Respaldo**: `pg_dump` regular de la base completa (incluye
  `schema_migrations`, así que un restore aplica sobre el mismo punto de
  migraciones sin re-ejecutarlas) — `pg_dump --format=custom
  "$DATABASE_URL" > backup.dump`.
- **Restauración**: `pg_restore --clean --if-exists -d "$DATABASE_URL"
  backup.dump`, seguido de `npx tsx scripts/db-postgres-migrate.mjs` (idempotente:
  si el backup ya tiene todas las migraciones aplicadas, no hace nada; si el
  backup es de antes de una migración nueva, la aplica).
- **RLS y roles no viajan en un `pg_dump` de solo datos**: si se restaura
  solo el esquema `public` sin las migraciones 0001/0007/0008 (roles
  `app_role`, funciones `SECURITY DEFINER`, políticas), el aislamiento
  multi-tenant queda roto silenciosamente. Restaurar SIEMPRE un dump que
  incluya roles/funciones, o re-aplicar las migraciones sobre una base
  vacía antes de importar solo los datos.
- **Nada de esto está probado en este repositorio** (no hay un test ni una
  corrida real de backup/restore documentada) — tratar esta sección como
  procedimiento de referencia a validar antes de depender de ella en un
  incidente real.

## 9. Incidentes y escalado

- **`GET /readyz` en 503 sostenido**: la base de datos no responde. Revisar
  primero conectividad de red/credenciales (`DATABASE_URL`), luego el propio
  Postgres (carga, conexiones agotadas). `apps/api` no reintenta la conexión
  internamente en el healthcheck — cada llamada a `/readyz` es un intento
  nuevo, así que un readiness probe periódico ya actúa como reintento.
- **`source_runs` en `captcha`/`permission_missing`/`down` repetido para una
  fuente**: no es un bug del worker — es el estado real de esa fuente
  externa (ver README § "Estado real de integraciones", `docs/BLOQUEOS.md`
  B-02 para ComprasMX). No reintentar agresivamente contra una fuente que
  devuelve reCAPTCHA: eso empeora el bloqueo, no lo resuelve. Escalar como
  bloqueo externo (requiere acceso/permiso oficial), no como incidente de
  código.
- **Jobs acumulándose en `queued` sin procesarse**: verificar que al menos
  un proceso `apps/worker` esté corriendo y no esté atascado en un job largo
  (ver `WORKER_SHUTDOWN_TIMEOUT_MS`/métricas en memoria de
  `queue/metrics.ts` — no persistidas, se pierden al reiniciar el proceso,
  ver §9 límites). Un job con `attempts` cerca de `max_attempts` y
  reapareciendo indica un error sistemático, no transitorio — revisar
  `last_error` antes de dejar que se agote solo hacia `dead`.
- **Escalado horizontal de `apps/worker`**: soportado por diseño (reclamo
  atómico `SKIP LOCKED`, sin estado compartido en memoria entre procesos) —
  correr N réplicas del mismo proceso worker es seguro. `apps/api` es
  stateless por request (toda persistencia va a Postgres) y también escala
  horizontalmente sin coordinación adicional.
- **Escalado de Postgres**: fuera del alcance de este repo (no hay
  configuración de réplicas/pooling commiteada). Con múltiples réplicas de
  `apps/api`/`apps/worker`, considerar un pooler (PgBouncer o similar) antes
  de escalar mucho el número de procesos, dado que cada uno abre su propio
  pool de conexiones (`pg.Pool`, default `max: 10`, ver
  `packages/db/src/driver.ts`).

## 10. Límites conocidos

- **No hay pipeline de despliegue ni infraestructura como código en este
  repo** — este documento describe cómo correr los procesos, no cómo
  aprovisionar servidores/contenedores.
- **`apps/worker` no expone healthcheck HTTP propio** — su salud se infiere
  de logs y del estado de `jobs`/`source_runs`.
- **Métricas de `JobMetrics` (`apps/worker/src/queue/metrics.ts`) son
  contadores en memoria del proceso**, no persistidos ni expuestos en un
  endpoint `/metrics` propio del worker (a diferencia de `apps/api`) — se
  pierden al reiniciar y no son visibles entre réplicas.
- **Sin redactor de logs genérico verificado** para PII/secretos en
  `apps/api`/`apps/worker` (ver §5).
- **Sin rotación de `PLATFORM_API_KEY` sin downtime** (una sola clave activa
  a la vez).
- **Sin revocación de refresh tokens** (`apps/api/README.md` § Pendiente) —
  rotar `JWT_SECRET` es hoy el único mecanismo para invalidar sesiones.
- **PGlite (desarrollo/tests) no reproduce concurrencia real de sistema
  operativo** (una sola conexión/proceso, como SQLite) — el job `db-postgres`
  de CI (`.github/workflows/quality.yml`, `scripts/db-postgres-migrate.mjs` +
  `scripts/db-postgres-rls-check.mjs`) es, a la fecha de este documento, la
  única vez que las migraciones y un ataque RLS dinámico corren contra un
  Postgres real en este proyecto — la prueba de concurrencia real de `jobs`
  con múltiples conexiones físicas sigue pendiente (ver
  `packages/db/README.md` § "Límites conocidos de PGlite").
- **La suite de vitest de `packages/db` (y de `apps/api`/`apps/worker` que
  la usan) está hardcodeada a PGlite** (`test/helpers.ts` llama
  `createPgliteClient()` directamente, sin leer `DATABASE_URL`) — no hay
  forma de re-ejecutar esa suite exacta contra Postgres real sin modificar
  `packages/db` (fuera del alcance de quien escribió este runbook). El job
  `db-postgres` de CI compensa esto con verificaciones propias contra
  Postgres real (migraciones + ataques RLS), no repitiendo la suite de
  PGlite.
- **ComprasMX bloqueado por reCAPTCHA (B-02)** y la mayoría de las fuentes
  oficiales sin API verificada en vivo — ver README § "Estado real de
  integraciones" y `docs/BLOQUEOS.md`.
- **`OPENAI_API_KEY` nunca ejercitada contra la API real** en este
  repositorio — el camino de `run_agent` con un proveedor real de LLM está
  implementado pero no probado end-to-end con credenciales de producción.
- **WhatsApp (REQ-090) no implementado** en este alcance.
- **Sin respaldo/restauración probados** (ver §8: es un procedimiento de
  referencia, no verificado con una corrida real en este repo).
