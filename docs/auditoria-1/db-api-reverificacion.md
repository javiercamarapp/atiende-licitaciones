# Reverificación adversarial — packages/db + apps/api (ronda 2)

**Ámbito reverificado**: `packages/db/**` y `apps/api/**`, contrastando la
auditoría original `docs/auditoria-1/db-api.md` (14 hallazgos DB-01..07 /
API-01..07, todos declarados **CERRADO** salvo DB-07 **PARCIAL**) contra el
estado real del código en HEAD `9cb38be` (worktrees de trabajo) /
`c96484a` (repo principal en el momento de escribir este informe — ningún
commit relevante a `packages/db`/`apps/api` entre ambos, verificado con
`git log 9cb38be..c96484a -- packages/db apps/api`).

**Auditor**: agente Sonnet independiente ("reverificador adversarial"), sin
participación en la construcción ni en la reparación de estos paquetes.
Trabajo repartido en **3 sub-agentes Sonnet** en **3 git worktrees separados**
(`<scratch>/reverify-db`, `<scratch>/reverify-api`, `<scratch>/reverify-regr`),
todos creados desde el mismo HEAD (`9cb38be`), con `npm install` real
ejecutado en cada uno, y eliminados al terminar. Nunca se tocó el árbol
principal del repositorio ni se usó `git reset`/`checkout <commit>`/`stash`/
`rebase` en él.

**Comandos y salidas**: `docs/logs/reverify-dbapi.log` (resumen de comandos
ejecutados por los 3 sub-agentes, transcritos desde sus reportes; los
scripts adversariales temporales que escribieron fueron borrados al cerrar
cada worktree, como en la ronda 1).

---

## Resumen ejecutivo

La reparación de ronda 1 es **real y verificable en 10 de los 14 hallazgos
originales** (DB-02 solo parcialmente: corrige el caso trivial pero no el
caso completo pedido en esta reverificación). Sin embargo, esta ronda
encuentra que **el patrón de vulnerabilidad de DB-01 y API-02 no se erradicó
de raíz**: se corrigieron los dos síntomas puntuales que la auditoría
original encontró, pero **el mismo patrón reaparece en código nuevo o
adyacente que no fue revisado**:

- **DB-08 (CRÍTICA, nuevo)**: las funciones `SECURITY DEFINER` de
  `refresh_tokens` (`0017_ronda2_extensions.sql`) — introducidas en la misma
  ronda que corrigió DB-01 — tienen exactamente el mismo defecto que DB-01
  (invocables por cualquier sesión autenticada con parámetros arbitrarios,
  sin validación de llamador) pero **nunca fueron revisadas** cuando 0019
  cerró DB-01. Permiten a cualquier usuario autenticado acuñar un refresh
  token válido para **cualquier otro `user_id`** (toma de sesión completa) y
  revocar todas las sesiones de cualquier usuario conociendo solo su
  `user_id`.
- **API-08 (ALTA, nuevo, mismo mecanismo que API-02)**: la reparación de
  API-02 protegió `PATCH /organizations/memberships/:userId` contra
  autopromoción a `owner`, pero **`POST /organizations/invitations` no
  recibió la misma protección**: un `admin` (no-owner) puede invitar a un
  tercero directamente con `role:'owner'`, y al aceptar la invitación el rol
  se concede sin control — el mismo resultado que API-02 consideraba
  cerrado, por una puerta distinta.
- **DB-02/DB-10**: el trigger de vigencia de tarifa (`0020`) sí corrige el
  caso "tarifa vencida hoy", pero compara contra `current_date`, nunca contra
  la fecha de presentación del acto (`tenders.submission_deadline`, que ya
  existe en el esquema desde 0005) — una tarifa vigente hoy pero que **habría
  estado vencida a la fecha de presentación** se acepta igual, contradiciendo
  REQ-023.
- **API-03**: el vector de `/auth/register` está genuinamente cerrado, pero
  `/auth/login` sigue siendo un **oráculo de timing de 24×** (scrypt solo se
  ejecuta si el email existe) — la auditoría original ya lo señaló
  textualmente pero lo calificó "OK" con una medición contaminada por el
  rate-limiter; con metodología correcta (app aislada por muestra) la
  separación es total (0% overlap en 15/15 muestras).
- **API-09 (MEDIA, nuevo)**: mismo patrón TOCTOU (check-then-act sin
  atomicidad) en `/auth/refresh` y en `POST /agents/tool-calls/:id/approve`
  — no reproducible bajo PGlite (conexión física única) pero real por
  lectura de código contra el pool de Postgres de producción
  (`pg.Pool({max:10})`).

**Los "2 timeouts de ci-local" documentados sí están identificados y
reproducidos como NO reproducibles en aislamiento** — ya resueltos por
`apps/api/vitest.config.ts` (timeouts subidos a 20s, `pool:'forks'`).

**El mecanismo de RLS por tabla (`app.apply_org_rls`) sigue perfecto**: 0
fugas en 173/173 ataques sobre las 35 tablas de dominio (incluidas las
nuevas de 0011-0028) y sobre `worker_role`. Las 3 fugas nuevas de esta ronda
están, igual que en la ronda 1, **fuera** de ese mecanismo — en funciones
`SECURITY DEFINER` sin control de llamador.

**Conteo de hallazgos de esta ronda**: 4 nuevos DB (DB-08 CRÍTICA, DB-09
BAJA, DB-10 MEDIA, DB-11 BAJA) + 5 nuevos API (API-08 ALTA, API-09 MEDIA,
API-10 MEDIA, API-11 MEDIA, API-12 BAJA). De los 14 originales: **10
CONFIRMADO_CERRADO, 2 REABIERTO (DB-02/DB-10, API-02/API-08), 1 PARCIAL
confirmado sin cambios (DB-07), 1 PARCIAL con hueco no cubierto (API-01)**.

---

## 1. Reverificación de hallazgos originales

### 1.1 packages/db

| ID | Veredicto ronda 2 | Evidencia clave |
|---|---|---|
| DB-01 | **CONFIRMADO_CERRADO** (con nota) | Hash `c1c0f1c` resuelve, migración `0019_fix_db01_security_definer_scope.sql`. `npm run -w packages/db test -- audit-db01-security-definer-scope.test.ts` → 4/4 verde. Reataque: `app.membership_role` (1 arg) solo resuelve el propio `current_user_id()`; sin contexto devuelve `NULL`. `app.find_user_by_email` rechaza con sesión activa (`find_user_by_email_not_allowed_in_session_context`). **Pero el mismo patrón no se corrigió en 0017/0025 → ver DB-08/DB-09.** |
| DB-02 | **REABIERTO (parcial)** | Hash `62a77e0`, `0020_fix_db02_rate_validity.sql`. Test oficial 3/3 verde (vencida/vigente/aún-no-vigente contra `current_date`). Variante pedida por este encargo: tarifa `approved`, `valid_until=hoy+5`, tender con `submission_deadline=hoy+60` → `INSERT` en `proposal_pricing_lines` **se acepta** (`insertedLine=true`). El trigger nunca mira `submission_deadline`, solo `current_date`. Ver DB-10. |
| DB-03 | **CONFIRMADO_CERRADO** | Hash `7922171`, `0021_fix_db03_rate_reapproval.sql`. Test oficial 3/3 verde. Variante pedida (superadmin edita precio aprobado): `UPDATE approved_rates SET unit_price=99999` como `platform_admins` → el trigger revierte a `draft` **sin excepción de rol** — comportamiento correcto, agnóstico de quién edita. |
| DB-04 | **CONFIRMADO_CERRADO** (documentación) | Hash `8a17818`, solo `packages/db/README.md`. Variante pedida (`n_a`/`skipped` en vez de solo rojo/faltante): el `CHECK` **acepta igual** — exactamente lo que el README ya declara como alcance parcial explícito (líneas 203-218 de `packages/db/README.md`). Documentación honesta confirmada; el hueco de negocio real permanece delegado a `packages/expediente` por diseño. |
| DB-05 | **CONFIRMADO_CERRADO** | Hash `0698544`, `0022_fix_db05_change_event_invalidation.sql`. Test oficial 4/4 verde. Variante pedida (evento sobre versión anterior, no la más reciente): el trigger invalida por `tender_id` sin mirar `tender_version_id` — diseño *fail-closed* consistente (nunca deja de invalidar), aunque tampoco distingue recencia de versión. Guard contra doble invalidación (`invalidated_at is null`) confirmado funcionando. |
| DB-06 | **CONFIRMADO_CERRADO** | Hash `5c0080c`, `0023_fix_db06_audit_log_hash_chain.sql`. Test oficial 3/3 verde, incluida detección de manipulación directa de fila (`verify_audit_log_chain()` detecta la fila rota). Nota de portabilidad: el comentario de la migración dice "sha256() disponible desde PG11"; en realidad es función núcleo desde **PG14** — sin efecto en PGlite 18.3 usado en tests, pero a verificar contra la versión real de Postgres de producción. |
| DB-07 | **PARCIAL (confirmado, sin cambios)** | No se migraron los 8 sitios de `apps/api/src/**` a `withTenantContext`; sí existe el test estático `apps/api/test/audit-db07-tenant-context-pattern.test.ts` como guarda. Estado declarado ("decisión de alcance documentada") preciso. |

### 1.2 apps/api

| ID | Veredicto ronda 2 | Evidencia clave |
|---|---|---|
| API-01 | **PARCIAL** | Reuso secuencial y reuso post-logout: bloqueados (401) en 10/10 trials cada uno. Ataque de carrera en paralelo (2-10 `/auth/refresh` simultáneos con el mismo token): en PGlite (conexión física única) siempre exactamente 1 éxito — artefacto del motor de test, no garantía de código. Revisión estática de `apps/api/src/modules/auth/routes.ts:126-159`: SELECT y UPDATE (`revoke_refresh_token`) ocurren en transacciones separadas sin verificar `rowCount` del UPDATE antes de emitir tokens nuevos; contra `pg.Pool({max:10})` de producción esto es una ventana TOCTOU real, no reproducible en este sandbox por falta de Postgres real. Ver API-09. |
| API-02 | **REABIERTO** | El `PATCH /organizations/memberships/:userId` sigue bloqueado correctamente (autopromoción→403, degradar al único owner→409). Pero `POST /organizations/invitations` **no tiene la misma protección**: un `admin` invitó con `role:'owner'`, 201; el invitado aceptó, 200; rol final `owner`. Confirmado empíricamente con `fastify.inject`. Ver API-08. |
| API-03 | **PARCIAL** | `/auth/register`: 30 muestras c/lado, ratio de medianas 1.006 (indistinguible) — cerrado. `/auth/login`: 15 muestras aisladas (app fresca por muestra, para evitar contaminación del rate-limiter): email existente+password mala = mediana 27.18ms; email inexistente = mediana 1.10ms. **Ratio 24×, 0% overlap en 15/15.** La medición original (ratio 0.6×, calificada "OK") estaba contaminada por el mismo rate-limiter que el reverificador tuvo que evitar con app aislada por muestra. |
| API-04 | **CONFIRMADO_CERRADO** | `auth.plugin.ts:37-39`, `UUID_PATTERN` valida antes de tocar la DB → 400. Test oficial pasa. |
| API-05 | **CONFIRMADO_CERRADO** | `@fastify/helmet` registrado en `app.ts:60`. Test oficial pasa. |
| API-06 | **CONFIRMADO_CERRADO** | `/docs/json` con `preHandler:[app.authenticate]` (`app.ts:83`). Test oficial pasa. |
| API-07 | **CONFIRMADO_CERRADO** | Token en claro devuelto una única vez al crear la invitación, nunca persistido en claro. |

---

## 2. RLS adversarial dinámico ampliado

Cobertura extendida a las tablas nuevas de 0011-0028 (perfil de empresa,
documentos, tarifas, `tender_versions`/`tender_change_events`,
`source_runs`, `refresh_tokens`, `agent_runs`/incidentes, `jobs`) y al rol
nuevo `worker_role` (0028), sobre los 3 worktrees combinados:

| Fuente | Ataques | Bloqueados | Fuga |
|---|---|---|---|
| `rls-isolation.test.ts` (35 tablas de dominio × SELECT/UPDATE/DELETE cross-org + sin contexto) | 140 | 140 | 0 |
| `rls-roles.test.ts` (viewer-no-escribe, writer-no-decide, sin-contexto, superadmin, self-superadmin) | 12 | 12 | 0 |
| `worker-role-and-job-proposals.test.ts` (lectura/UPDATE cross-tabla sin filtro `org_id` para `worker_role`) | 6 | 6 | 0 |
| `backoffice-extension.test.ts` (tarifa no aprobada, checklist sin snapshot, dedupe de versión, `source_runs` solo-superadmin) | 5 | 5 | 0 |
| `idempotency-and-audit.test.ts` (unicidad por org, aislamiento cross-org, `audit_log` sin UPDATE/DELETE) | 4 | 4 | 0 |
| Script propio ampliado (`create_refresh_token`, `revoke_all_refresh_tokens`, `agent_run_context`, `membership_role`/`find_user_by_email` sin contexto, conexión sin `SET ROLE app_role`, `worker_role` vs. tablas de negocio cross-org) | 9 | 6 | **3** (DB-08 ×2, DB-09 ×1) |

**Total de esta ronda: 176 ataques ejecutados, 173 bloqueados, 3 fugas** —
las 3 corresponden íntegramente a DB-08/DB-09 (funciones `SECURITY DEFINER`
sin control de llamador). **El mecanismo de RLS por tabla propiamente dicho
sigue en 167/167 (0 fugas)**, incluidas las tablas nuevas de la ampliación
back-office y el rol `worker_role`.

**`worker_role` (0028)**: confirmado `NOLOGIN`, `NOSUPERUSER`,
`NOBYPASSRLS`; sujeto a RLS real (0 filas devueltas sin contexto en
`approved_rates`/`company_profiles`/`tenders`/`refresh_tokens`); grants
directos exactamente `{jobs, source_runs, agent_runs}` según
`information_schema.role_table_grants`. **Nota** (DB-11 abajo): hereda
grants más amplios de `app_role` vía `ALTER DEFAULT PRIVILEGES`, pero RLS
neutraliza el acceso real — ya probado explícitamente en
`worker-role-and-job-proposals.test.ts`.

---

## 3. Hallazgos nuevos

### DB-08 — CRÍTICA — funciones SECURITY DEFINER de `refresh_tokens` permiten acuñar/revocar sesiones ajenas

**Evidencia**: `packages/db/migrations/0017_ronda2_extensions.sql:44-77`.
`app.create_refresh_token(p_id, p_user_id, p_token_hash, p_expires_at)` y
`app.revoke_all_refresh_tokens(p_user_id)` son `SECURITY DEFINER` sin
ninguna validación de llamador — el mismo patrón exacto que DB-01, pero
introducido en 0017 y **nunca revisado** cuando 0019 corrigió DB-01 (0019
solo tocó las dos funciones de 0010). Reataque confirmado: un `viewer` de
orgA invoca directamente `select app.create_refresh_token(gen_random_uuid(),
$victimUserId, $hashElegidoPorElAtacante, now()+'30 days')` y **crea con
éxito** un refresh token válido para otro `user_id` (cross-org incluido,
nada en la función limita a la misma organización); como el atacante elige
el `token_hash`, puede presentar el secreto correspondiente en
`POST /auth/refresh` y obtener acceso completo como la víctima — **toma de
sesión (account takeover) completa**. `app.revoke_all_refresh_tokens`
permite además revocar todas las sesiones de cualquier usuario conociendo
solo su `user_id` (dato no secreto). Confirmado por grep que
`revoke_all_refresh_tokens` **no se usa en ningún lugar de `apps/api`** —
superficie sin caso de uso legítimo.

**Severidad**: CRÍTICA.

**Reparación sugerida** (separada del hallazgo): aplicar el mismo patrón que
0019 usó para `find_user_by_email`/`membership_role`: exigir que la
transacción llamante fije `app.current_user_id()=p_user_id` antes del
INSERT (o resolver `p_user_id` implícitamente del contexto ya validado por
la capa de login, no como argumento arbitrario), y eliminar
`app.revoke_all_refresh_tokens` si no tiene caso de uso real, o exigir
`p_user_id=app.current_user_id()` salvo llamada de `is_superadmin()`.

### DB-09 — BAJA — `app.agent_run_context` (0025) es oráculo de existencia/organización sin control de llamador

**Evidencia**: `packages/db/migrations/0025_agent_run_lookup_helpers.sql:14-20`,
`SECURITY DEFINER` sin chequeo de llamador. Reataque confirmado: un actor de
orgB, o incluso sin contexto de sesión, resuelve `org_id`/`actor_id` de un
`agent_run` de orgA solo con su UUID. Impacto limitado por ser
`agent_runs.id` un UUID no adivinable (a diferencia de DB-01, que exponía
por email) y por el alcance deliberadamente mínimo declarado en el
comentario de la migración, pero rompe la misma invariante que DB-01
corrigió.

**Severidad**: BAJA.

**Reparación sugerida**: exigir `app.current_user_id()` fijado y coincidente
con el `actor_id` de la corrida, o `is_superadmin()`, o ausencia total de
contexto (mismo patrón de `find_user_by_email`) — hoy no aplica ninguna.

### DB-10 — MEDIA — vigencia de tarifa validada contra `current_date`, no contra la fecha del acto (REQ-023)

Ver DB-02 arriba. `tenders.submission_deadline` existe desde `0005_tenders_core.sql:41`
y es alcanzable desde `proposal_pricing_lines.proposal_id → proposals.tender_id →
tenders.submission_deadline`, pero `app.enforce_approved_rate` (0020) nunca lo consulta.

**Severidad**: MEDIA.

**Reparación sugerida**: en `app.enforce_approved_rate`, resolver
`submission_deadline` vía `new.proposal_id` y comparar
`coalesce(v_submission_deadline::date, current_date)` contra
`valid_from`/`valid_until`, con fallback a `current_date` si el tender aún
no tiene plazo fijado.

### DB-11 — BAJA — comentario impreciso sobre grants de `worker_role`, sin impacto real

`0028_worker_role.sql` afirma "sin grants sobre ninguna otra tabla del
esquema", pero `worker_role` hereda (`GRANT app_role TO worker_role`) los
privilegios amplios de `app_role` vía `ALTER DEFAULT PRIVILEGES` de 0001.
**No es un hallazgo de seguridad** — RLS neutraliza el acceso real y esto
ya está probado explícitamente en `worker-role-and-job-proposals.test.ts` —
solo una imprecisión de redacción que podría inducir a un futuro
mantenedor a confiar en un límite de GRANT inexistente.

**Severidad**: BAJA (documentación).

**Reparación sugerida**: corregir el comentario para decir explícitamente
que `worker_role` hereda los grants amplios de `app_role` y que el único
control real es RLS.

### API-08 — ALTA — mismo mecanismo de API-02, ruta distinta (`POST /organizations/invitations`)

**Evidencia**: `apps/api/src/modules/organizations/routes.ts:111-183`. El
endpoint de creación de invitaciones solo exige
`MEMBERSHIP_ADMIN_ROLES` (owner **o** admin), sin el chequeo
`role==='owner' && request.orgRole!=='owner'` que sí existe en el PATCH
(`routes.ts:206-208`). Reataque confirmado con `fastify.inject`: un `admin`
(no-owner) invita a un tercero con `role:'owner'` → 201; el invitado acepta
→ 200; rol resultante `owner`. Esto rodea por completo el cierre de API-02:
cualquier admin fabrica un owner nuevo por la puerta de invitación.

**Severidad**: ALTA.

**Reparación sugerida**: replicar en `routes.ts:121-123` (antes del chequeo
de `MEMBERSHIP_ADMIN_ROLES`) la misma regla ya usada en el PATCH:
`if (role==='owner' && request.orgRole!=='owner') throw new ForbiddenError(...)`.

### API-09 — MEDIA — patrón TOCTOU (check-then-act no atómico) en refresh y en aprobación de tool_calls

**Evidencia**: (a) `/auth/refresh` (`routes.ts:126-159`) — SELECT y UPDATE
(`revoke_refresh_token`) en transacciones separadas, sin verificar
`rowCount` del UPDATE antes de emitir tokens nuevos; (b)
`POST /agents/tool-calls/:id/approve|deny` (`apps/api/src/modules/agents/routes.ts:97-109,140-153`)
— el `UPDATE ... WHERE id=$2 AND org_id=$3` no incluye
`AND authorization_status='pending'`, el único guard es el SELECT previo
dentro de la misma transacción. No reproducible bajo PGlite (conexión
física única: 100% consistente en 2/2 y 5/5 aprobaciones/denegaciones
paralelas en las pruebas realizadas), pero real por lectura de
`packages/db/src/driver.ts:70-112` contra `pg.Pool({max:10})` de
producción con aislamiento READ COMMITTED por defecto.

**Severidad**: MEDIA (no confirmado en ejecución real por falta de Postgres
en el sandbox; confirmado por análisis estático de código y de la
arquitectura de conexión).

**Reparación sugerida**: hacer el check-y-mutación atómico en una sola
sentencia con `WHERE` que incluya el estado esperado y verificar
`rowCount` antes de continuar — `UPDATE refresh_tokens SET revoked_at=now()
WHERE token_hash=$1 AND revoked_at IS NULL RETURNING *` para refresh;
`AND authorization_status='pending'` en el UPDATE de tool_calls.

### API-10 — MEDIA — `POST /admin/jobs/:id/retry` omite `audit_log` para jobs sin `org_id`

**Evidencia**: `apps/api/src/modules/admin/routes.ts:150-161`, el registro
en `audit_log` solo ocurre `if (before.rows[0].org_id)`. `jobs.org_id` es
NULLABLE (jobs de plataforma/discovery sin organización). Reataque
confirmado: job con `org_id=null` reintentado por un superadmin (200,
`status` cambia de `failed`→`queued`) y `audit_log` queda en 0 filas antes y
después — contradice el propio comentario del código, que menciona una
"organización de sistema" que no existe en la implementación real.

**Severidad**: MEDIA.

**Reparación sugerida**: crear una organización de sistema reservada (o
relajar el NOT NULL de `audit_log.org_id`) y quitar el `if` que omite el
audit para jobs sin organización.

### API-11 — MEDIA — subida de documentos sin validación de tipo/magic bytes (REQ-024, lado API)

**Evidencia**: `apps/api/src/lib/storage.ts` y
`documentCreateSchema` (`schemas.ts:197-202`) no validan tipo MIME ni magic
bytes del contenido — cualquier binario puede subirse bajo cualquier
`documentType`. Incumple REQ-024 ("`.key`/`.cer` rechazados por magic
bytes") del lado de `apps/api` (el REQ-024 de `docs/ACEPTACION.md` solo
tiene evidencia a nivel RLS/DB, no de la capa de subida HTTP). **Verificado
correcto**: no hay path traversal (el path en disco se deriva 100%
server-side de `orgId` UUID + sha256 del contenido, nunca de un nombre
suministrado por el cliente) y el hash sha256 no puede desincronizarse
(siempre se calcula del buffer real, nunca se acepta un hash del cliente).

**Severidad**: MEDIA.

**Reparación sugerida**: detección de magic bytes (p.ej. librería
`file-type` o firma manual) antes de `storeFile`, rechazando firmas de
`.key`/`.cer`/PKCS#8/ejecutables según el `documentType` esperado.

### API-12 — BAJA — comparación no constante en `requirePlatformApiKey`

**Evidencia**: `apps/api/src/plugins/auth.plugin.ts:67-70`, comparación con
`!==` en vez de `timingSafeEqual`, canal de timing teórico contra el
secreto de plataforma (bajo riesgo real: requiere red de muy baja latencia y
muchísimas muestras).

**Severidad**: BAJA.

**Reparación sugerida**: usar `timingSafeEqual` (con longitud igualada
primero) igual que ya se hace correctamente en `passwords.ts`.

---

## 4. Migraciones

- **Idempotencia real**: confirmada con 3ª aplicación consecutiva además de
  las 2 de `migrate.test.ts` (`applied.length===0` en la 2ª y 3ª).
- **0026b con duplicados preexistentes reales**: `migration-0026b-duplicate-jobs-safety-net.test.ts`
  sí reproduce el escenario real (no trivial): aplica solo hasta 0026,
  inserta 3 jobs activos duplicados a mano (posible porque el índice único
  de 0027 aún no existe), aplica 0026b→0028 desde el pipeline real y
  confirma que 0026b resuelve 2/3 duplicados (conserva el más reciente)
  **antes** de que 0027 cree el índice.
- **0027 índice único**: confirmado — tras la migración completa, un INSERT
  duplicado por `(kind, jobKey)` activo lanza (23505), tanto en el test
  oficial como en `worker-role-and-job-proposals.test.ts`.
- **`schema_migrations` checksum**: modificar el checksum almacenado de
  `0001_bootstrap.sql` y reejecutar `applyMigrations()` lanza
  `Error: La migración 0001_bootstrap.sql ya fue aplicada con un contenido
  distinto...` — no silencioso, no reaplica.
- **Revisión estática de sintaxis Postgres real (0017-0028)**: sin `CREATE
  EXTENSION`, sin `citext`, `ALTER TYPE ... ADD VALUE` correctamente aislado
  en su propia migración (evita el error real de Postgres "unsafe use of
  new value of enum type"). Único punto de atención no bloqueante: el
  comentario de 0023 sobre disponibilidad de `sha256()` desde PG11 es
  impreciso (es PG14+) — verificar contra la versión real de despliegue.

**Veredicto: CUMPLE**, con la nota de portabilidad de `sha256()` a validar
contra la versión real de Postgres de producción.

---

## 5. Regresión

| Paquete | Comando | Archivos | Tests | Resultado |
|---|---|---|---|---|
| packages/db | `npm run -w packages/db test` | 15 | 130 | 130/130 verde |
| packages/db | `typecheck` / `lint` | — | — | OK, 0 errores |
| apps/api | `npm run -w apps/api test` (3 corridas, 1 bajo estrés de CPU artificial) | 15 | 51 | 51/51 verde en las 3 corridas |
| apps/api | `typecheck` / `lint` | — | — | OK, 0 errores |
| apps/worker | `npm run -w apps/worker typecheck` | — | — | OK, 0 errores |
| apps/worker | `npm run -w apps/worker test` | 11 (8 activos + 3 `.pending.test.ts` con `describe.skip`) | 60 (55 pass + 5 skip) | 55/55 verde |
| apps/web | `npm run -w apps/web typecheck` | — | — | OK, 0 errores |

**`not_configured` realmente ejercitado** (no solo tipo declarado):
`apps/worker/test/discover-tenders-handler.test.ts:119` y `:152` — 2 tests
que verifican explícitamente el estado fino `not_configured` para los 5
conectores reales de `packages/sources` (ninguno con
`liveVerification.verified=true` hoy) y para fuentes sin conector
registrado.

**Gap de integración real (no bug de test, trabajo pendiente honesto)**: las
migraciones 0026/0026b/0027/0028 tienen cobertura completa y en verde en
`packages/db`, pero `apps/worker` **no fue adaptado** para consumirlas —
`source-run-status.ts:44-52` sigue proyectando `rate_limited`/
`not_configured`/`ingest_failed` a `'failed'`, y `job-queue.ts:265-266`
(`cancel()`) sigue usando `status='dead'` con un comentario ("no hay estado
`cancelled` en el enum") que es falso desde que se aplicó 0027. Los 3
archivos `.pending.test.ts` en `apps/worker/db-proposals/` documentan
correctamente este gap y siguen con `describe.skip` — no es una regresión
oculta, pero es trabajo pendiente real sin marcar como hecho en ningún
lado (confirmado, no hay falsa declaración).

### Timeouts de ci-local

Documentados en `docs/PROGRESO.md:84` y en `docs/logs/ci-local.log`
(`2026-09-06T02:15:27Z`): `matching-and-go-no-go.test.ts` ("A5: dos
organizaciones con perfiles distintos...") y
`audit-api02-role-escalation.test.ts` ("un owner SÍ puede promover a otro
miembro a owner"), ambos "Test timed out in 5000ms" bajo carga concurrente
de otros agentes trabajando en el repo al mismo tiempo.

**Reproducción en aislamiento** (3 corridas cada uno, solo ese archivo):
ambos pasan en <1s en las 3 corridas (671-717ms y 663-706ms). Bajo estrés
de CPU artificial adicional (8 procesos `yes` en paralelo), la suite
completa de `apps/api` sigue 51/51 verde.

**Veredicto: NO REPRODUCE / YA MITIGADO.** `apps/api/vitest.config.ts` ya
sube `testTimeout`/`hookTimeout` a 20s y fija `pool:'forks', maxForks:4`,
con un comentario que cita explícitamente este mismo problema histórico.

---

## 6. Trazabilidad

### A1-A15 (`docs/ACEPTACION.md`)

| Criterio | Estado verificado | Nota |
|---|---|---|
| A1 | PARCIAL | Sin E2E único fuente→worker→api→BD, piezas reales por separado |
| A2 | PARCIAL | Replay real vía HTTP+BD (`tenders-and-ingest.test.ts`) y en worker |
| A3 | **PARCIAL — doc original lo subestima** | `tenders-and-ingest.test.ts:109-172` prueba invalidación real de `proposals.invalidated_at` vía API+BD, no solo piezas unitarias como dice `ACEPTACION.md:199` |
| A5 | CON_EVIDENCIA (backend) | RLS + matching aislado; vector store (REQ-061) sigue sin implementación |
| A6 | PARCIAL | Solo a nivel `packages/expediente`, documentado explícitamente como fuera de esa librería |
| A7 | **PARCIAL — doc original lo subestima** | Evidencia real en `company-profile.test.ts` y `matching-and-go-no-go.test.ts` no citada en `ACEPTACION.md:203`; además API-11 muestra un hueco relacionado (sin validar tipo de archivo) |
| A8 | **PARCIAL — doc original lo subestima** | `company-profile.test.ts:135` prueba real API (writer propone, owner/admin aprueba), no solo unitario como dice `ACEPTACION.md:204` |
| A9 | PARCIAL | CHECK de DB + expediente, sin conexión E2E |
| A10 | PARCIAL | Banda legal de precio (REQ-030) sin implementación — coincide con doc |
| A11 | PARCIAL | Sin UI real (`AprobacionesPage` es `EmptyState` genérico) — coincide con doc |
| A12 | **PARCIALMENTE REABIERTO por API-08** | PATCH bloqueado, pero la ruta de invitación no — el mismo tipo de bypass que A12 busca cubrir |
| A13 | PARCIAL | Sin endpoint de descarga autenticada en apps/api/apps/web |
| A14 | CON_EVIDENCIA | Invariante de 3 condiciones + E2E real (`apps/web/e2e/recorrido.spec.ts:74`) |
| A15 | PARCIAL | Superficie sin envío/firma; AG-05 (handler que miente en 3 campos) sigue sin resolver |

### E2/E3/E4/E5/E10 (`docs/BACKLOG.md`)

`docs/BACKLOG.md` mantiene **"Estado: PENDIENTE"** literal en los
encabezados de las 5 épicas — desactualizado frente al progreso real:

| Épica | REQ con evidencia real | REQ sin evidencia |
|---|---|---|
| E2 | REQ-141/142/143 (CON_EVIDENCIA: 8 tablas de perfil + `field_provenance`) | REQ-145 (firmantes): tabla+CRUD genérico existen, pero **ningún test ejercita la regla de negocio** ("firma de no-firmante rechazada") |
| E3 | REQ-146/148/149/150 (scheduler, estados honestos) | REQ-132/133 en `apps/web` (panel de frescura es demo estática hardcodeada, no conectada) |
| E4 | REQ-151-155 (versiones + invalidación real vía API) | Cascada hacia matriz/expediente y notificación al rol responsable |
| E5 | REQ-059-061/167 (aislamiento probado) | REQ-061 (vector store efímero): sin implementación |
| E10 | REQ-169 (métricas honestas, estimados marcados) | REQ-170 (apps/web no conectado a los endpoints reales de `apps/api`); REQ-171 (`correlation_id` extremo a extremo): sin implementación |

**Progreso falsamente declarado como hecho**: no se encontró ningún caso
(grep de `[x]`/✅/HECHO/COMPLETADO sin evidencia real). El problema
encontrado es el inverso — **subdeclaración**: `BACKLOG.md` marca las 5
épicas como 100% pendientes pese a rondas completas ya implementadas y
probadas, y `ACEPTACION.md` cita solo la evidencia más débil disponible en
A3/A7/A8 cuando existe evidencia de integración real más fuerte. Se
recomienda actualizar ambos documentos para reflejar el estado real sin
sobreestimarlo ni subestimarlo.

Adicionalmente, dos comentarios de código quedaron desactualizados de forma
que podrían inducir error de mantenimiento: `apps/worker/src/queue/job-queue.ts:75`
referencia un archivo de migración con un nombre/número que nunca existió
así, y la línea 265 del mismo archivo afirma que no existe un estado
`cancelled` en el enum, falso desde 0027.

---

## Comprobado correcto (verificado activamente, no solo leído)

- RLS por tabla (`app.apply_org_rls`) sigue en 167/167 (0 fugas) incluidas
  las tablas nuevas de 0011-0028 y el rol `worker_role`.
- `worker_role`: `NOLOGIN`/`NOSUPERUSER`/`NOBYPASSRLS`, RLS real aplicado, 0
  filas visibles de tablas de negocio sin contexto pese a heredar grants
  amplios de `app_role` (DB-11 es solo un matiz de documentación).
- DB-03 (revocación de aprobación de tarifa) es agnóstica de rol — ni
  siquiera un superadmin puede editar el precio de una tarifa aprobada sin
  que se revierta a `draft`.
- Idempotencia y checksum de migraciones (`schema_migrations`) funcionan
  como se documentó: 3ª aplicación sin duplicar, edición silenciosa
  detectada y bloqueada con error explícito.
- 0026b resuelve duplicados preexistentes reales (no solo el caso trivial)
  antes de que 0027 imponga el índice único.
- `/auth/register` genuinamente cerrado contra enumeración por timing (30
  muestras, ratio 1.006).
- API-04/05/06/07 confirmados cerrados sin matices.
- No hay path traversal ni desincronización de hash sha256 en la subida de
  documentos (API-11 es solo la falta de validación de tipo, no estos dos
  vectores).
- Cursor de paginación de `GET /tenders`: sin fuga cross-org con cursor
  ajeno o corrupto (filtro `org_id` siempre aplicado, cursor corrupto se
  ignora).
- `matching`/go-no-go sobre tender de otra organización: 404; `writer`
  decidiendo: 403 — ambos confirmados.
- `/metrics` sin datos de tenant; `request_id` presente en el 100% de
  respuestas de error `problem+json`.
- Los 2 timeouts de ci-local documentados NO reproducen en aislamiento ni
  bajo estrés de CPU artificial — ya mitigados por `vitest.config.ts`.
- `not_configured` de `apps/worker` realmente ejercitado por 2 tests reales,
  no solo declarado como tipo.
- Ningún caso de progreso pendiente marcado falsamente como "hecho" en
  `BACKLOG.md`/`PROGRESO.md`/READMEs (grep dirigido, 0 coincidencias).

---

## Tabla de hallazgos (esta ronda)

| ID | Severidad | Rubro | Estado del hallazgo original | Reparación sugerida | Estado reparación |
|---|---|---|---|---|---|
| DB-01 | ALTA (original) | RLS / SECURITY DEFINER | CONFIRMADO_CERRADO | — | Cerrado, sin cambios pendientes |
| DB-02 | ALTA (original) | Integridad de negocio (precio) | **REABIERTO** (parcial — ver DB-10) | Ver DB-10 | Pendiente |
| DB-03 | ALTA (original) | Integridad de negocio (precio) | CONFIRMADO_CERRADO | — | Cerrado |
| DB-04 | MEDIA (original) | Integridad de negocio (checklist) | CONFIRMADO_CERRADO (documentación) | — | Cerrado (alcance documentado) |
| DB-05 | ALTA (original) | Invalidación automática | CONFIRMADO_CERRADO | — | Cerrado |
| DB-06 | MEDIA (original) | Auditoría (hash chain) | CONFIRMADO_CERRADO | Verificar `sha256()` contra versión real de Postgres | Cerrado, nota de portabilidad abierta |
| DB-07 | BAJA (original) | Arquitectura RLS | PARCIAL (sin cambios) | — | Sin cambios, decisión de alcance vigente |
| DB-08 | **CRÍTICA (nuevo)** | RLS / SECURITY DEFINER (`refresh_tokens`) | — | Validar llamador en `create_refresh_token`/eliminar o restringir `revoke_all_refresh_tokens` | **PENDIENTE** |
| DB-09 | BAJA (nuevo) | RLS / SECURITY DEFINER (`agent_run_context`) | — | Exigir `current_user_id()` = `actor_id` o `is_superadmin()` | **PENDIENTE** |
| DB-10 | MEDIA (nuevo) | Integridad de negocio (precio, REQ-023) | — | Validar vigencia contra `submission_deadline`, no `current_date` | **PENDIENTE** |
| DB-11 | BAJA (nuevo) | Documentación | — | Corregir comentario de grants de `worker_role` en 0028 | **PENDIENTE** |
| API-01 | ALTA (original) | Autenticación (refresh) | PARCIAL | Ver API-09 | Pendiente (TOCTOU) |
| API-02 | ALTA (original) | Autorización (escalada de rol) | **REABIERTO** | Ver API-08 | Pendiente |
| API-03 | MEDIA (original) | Enumeración de usuarios | PARCIAL | Mitigar timing de `/auth/login` (delay constante o ejecutar scrypt siempre) | **PENDIENTE** |
| API-04 | BAJA (original) | Validación de entrada | CONFIRMADO_CERRADO | — | Cerrado |
| API-05 | MEDIA (original) | Cabeceras de seguridad | CONFIRMADO_CERRADO | — | Cerrado |
| API-06 | BAJA (original) | Exposición de superficie | CONFIRMADO_CERRADO | — | Cerrado |
| API-07 | BAJA (original) | Invitaciones (diseño) | CONFIRMADO_CERRADO | — | Cerrado |
| API-08 | **ALTA (nuevo)** | Autorización (invitación como owner) | — | Replicar el chequeo del PATCH en `POST /organizations/invitations` | **PENDIENTE** |
| API-09 | MEDIA (nuevo) | TOCTOU (refresh, tool_calls) | — | Atomizar check-y-mutación con `WHERE` de estado esperado + `rowCount` | **PENDIENTE** |
| API-10 | MEDIA (nuevo) | Auditoría (jobs sin org) | — | Org de sistema reservada o NOT NULL relajado en `audit_log.org_id` | **PENDIENTE** |
| API-11 | MEDIA (nuevo) | Subida de documentos (REQ-024) | — | Validar magic bytes antes de `storeFile` | **PENDIENTE** |
| API-12 | BAJA (nuevo) | Comparación no constante | — | `timingSafeEqual` en `requirePlatformApiKey` | **PENDIENTE** |

---

## Anexo: metodología

3 sub-agentes Sonnet, cada uno en su propio git worktree (`reverify-db`,
`reverify-api`, `reverify-regr`), todos desde HEAD `9cb38be`, con
`npm install` real. Ningún worktree tocó el árbol principal ni usó
operaciones destructivas de git. Los scripts adversariales temporales (uno
por worktree, con nombres tipo `zz-adversarial-reverify.test.ts`) fueron
borrados al cerrar cada worktree; `git status`/`git diff --stat` quedaron
limpios en los 3 al finalizar. Detalle completo de comandos en
`docs/logs/reverify-dbapi.log`.
