# Reverificación adversarial de SEGURIDAD — packages/db + apps/api (reparación post-ronda-2)

**Ámbito**: reverificar la columna "Estado reparación" de
`docs/auditoria-1/db-api-reverificacion.md` para los 10 commits de
reparación de seguridad citados (DB-08 `2b6b2f7`, DB-12 `38b157e`,
API-08/API-02 `7eb4ce7`, DB-02/DB-10 `3f25760`, API-01/API-09 `31780e9`,
API-03 `3fd1093`, DB-09 `21b6a8c`, DB-11 `616f15e`, sha256 `13c044f`, docs
`a8d5442`), más los commits posteriores que resolvieron el resto de la
lista "PENDIENTE" (API-09 mitad tool_calls `2019262`, API-10 `038283e`,
API-11 `91b97a1`, API-12 `43c47ba`, y la mitigación adicional de DB-09
`f743989`/commit de `agent-stores.pg.ts` con caché de contexto).

**Auditor**: agente Sonnet independiente ("reverificador adversarial de
SEGURIDAD"), sin participación en la construcción ni en la reparación de
estos paquetes. Solo encuentra y verifica — no repara código.

**HEAD final verificado**: `f1d3bc9` ("docs: cierre api ronda 3; despacho
auditoría 2 de expediente en API"). El repositorio principal tuvo
actividad concurrente intensa durante esta reverificación (otros agentes
trabajando en `apps/web`, `apps/worker`, `packages/sources` y en el resto
de `packages/db`/`apps/api` en paralelo); el worktree se resincronizó
varias veces (`5bcaa41` → `038283e` → `57d0efb` → `f1d3bc9`) verificando en
cada salto que no hubiera commits de seguridad sin revisar. Nunca se usó
`git reset`/`checkout <commit>`/`stash`/`rebase`/`add -A` en el repo
principal; todo el trabajo (incluidos dos worktrees temporales) se hizo en
`<scratch>/reverify-sec` y `<scratch>/reverify-sec-baseline`, ambos
eliminados al cerrar.

**Comandos y salidas completas**: `docs/logs/reverify-dbapi-seguridad.log`.

---

## Resumen ejecutivo

**Los 10 commits citados son reales, verificables y hacen exactamente lo
que declaran.** Ancestría lineal confirmada (`git log --graph`), contenido
confirmado archivo por archivo con `git show --stat`. Además, en el tiempo
transcurrido entre el encargo y esta entrega, el mismo autor cerró **el
resto de la lista "PENDIENTE"** que la ronda anterior había dejado fuera de
alcance: API-09 (mitad `tool_calls`, `2019262`), API-10 (`038283e`),
API-11 (`91b97a1`) y API-12 (`43c47ba`), y mitigó adicionalmente el gap
residual de DB-09 con una caché de contexto en `agent-stores.pg.ts`. **De
los 17 hallazgos con nombre (12 DB + 12 API menos solapes), 15 quedan
CERRADOS, 1 (DB-07) sigue PARCIAL sin cambios por decisión de alcance
documentada, y 1 (DB-09) sigue PARCIAL con mitigación real pero gap
residual acotado y hoy inalcanzable vía HTTP.**

**Un hallazgo de reproducibilidad, ya autocorregido**: recrear el worktree
exactamente en el commit `a8d5442` (el que el informe original cita como
"79/79 verde") dio **6/79 tests rojos de forma determinista** — no un
artefacto de concurrencia. Causa raíz: `packages/db/migrations/
0034_expediente_approval_inputs_snapshot.sql` existía en el disco del
autor original desde antes, pero nunca se había comiteado a git; todas las
corridas "verdes" citadas la tenían en disco, pero un checkout limpio del
historial no. El propio autor lo detectó y corrigió (`5bcaa41`, título
literal "commitea la migración 0034 (faltaba en el historial)") **antes**
de que esta reverificación lo señalara. Se documenta porque es un recordatorio
general: un log de "N/N verde" no garantiza que todo lo necesario esté
comiteado. A partir de `5bcaa41` la suite es estable 79/79, y en HEAD final
95/95 (79 + 16 tests nuevos de API-09/10/11/12).

**Dos hallazgos nuevos, ambos de severidad acotada (no críticos)**:

- **DB-13 (MEDIA, nuevo)**: la vigencia de tarifas (DB-02/DB-10,
  `app.enforce_approved_rate`) compara `submission_deadline::date` contra
  `valid_from`/`valid_until`, pero **ningún lugar de `packages/db` fija
  explícitamente el `TimeZone` de la sesión de Postgres** que hace ese
  cast. Confirmado empíricamente que el resultado (aceptar/rechazar una
  tarifa cerca de medianoche) cambia según el `TimeZone` por defecto del
  servidor — en este entorno coincidió por casualidad con
  `America/Mexico_City` (el TZ del sistema operativo del worktree), pero
  un Postgres de producción con `TimeZone=UTC` (configuración por defecto
  muy común en la nube) evaluaría el mismo dato con un resultado distinto.
- **API-13 (BAJA/MEDIA, nuevo)**: `apps/api/src/modules/auth/routes.ts`
  (`login`, `refresh`, `logout`) **no llama a `recordAudit` en ningún
  punto** — ni el login exitoso, ni la rotación de refresh, ni
  (críticamente) la revocación defensiva de **toda la familia de sesiones
  activas** que dispara la detección de reuso de API-01, quedan en
  `audit_log`. Un evento de seguridad genuino (sospecha de robo de refresh
  token) es invisible para el back office/superadmin hoy.

Un tercer punto, **DB-14 (nota arquitectónica, no un hallazgo nuevo
distinto)**: confirmado que `SET ROLE app_role → worker_role` y `→
postgres` "funcionan" dentro de una sesión ya en `app_role`, pero por la
MISMA razón ya documentada por el proyecto para DB-07 y en
`packages/db/README.md` ("el runtime de la API nunca debe conectarse con
[el] usuario [propietario]"): tanto en PGlite como en la arquitectura de
producción descrita, la conexión física subyacente es el propietario de
las migraciones, y `SET LOCAL ROLE app_role` es una convención de
aplicación, no una restricción de login nativa. No es una fuga de RLS
nueva — es el mismo riesgo de "conexión única y poderosa + disciplina de
`SET LOCAL ROLE`" que el proyecto ya reconoce, sin verificación en
arranque de que el rol de `DATABASE_URL` en producción carezca de
`BYPASSRLS`/superusuario.

**Conteo de ataques**: 176 (ronda anterior, RLS por tabla + funciones) +
**22 nuevos de esta ronda** (11 packages/db + 11 apps/api) = **198
ataques**. De los 22 nuevos: **20 confirmaron defensa correcta**, **2
revelaron los hallazgos nuevos DB-13/API-13** (no fugas de datos
cross-tenant, sino gaps de auditoría/consistencia horaria). Ninguno
resultó en una fuga de datos cross-organización nueva.

---

## 1. Ancestría y contenido de los 10 commits originales

```
* a8d5442 docs: actualiza estado de reparación DB-02/08/09/10/11/12, API-01/02/03/08/09 + log final
* 2632874 fix(api): invalida explícitamente la aprobación al cambiar aplicabilidad de un requisito condicional  [fuera de alcance de seguridad, coordinación con expediente]
* 13c044f docs(db): corrige nota de portabilidad de sha256() (PG14+, no PG11)
* 616f15e docs(db): DB-11 - corrige comentario impreciso de grants de worker_role
* 21b6a8c fix(db): DB-09 (mitigación parcial) - app.agent_run_context bootstrap guard
* 3fd1093 fix(api): API-03 - close login timing oracle (always run scrypt)
* 31780e9 fix(db,api): API-01/API-09 - atomic refresh rotation with reuse-detection family revoke
* 3f25760 fix(db): DB-02 (reabierto)/DB-10 - vigencia de tarifa contra submission_deadline
* 7eb4ce7 fix(api): API-08/API-02 - only an owner can grant the owner role via invitation
* 38b157e fix(db): DB-12 (audit sweep) - app.my_organizations required caller context
* 2b6b2f7 fix(db): DB-08 - refresh token SECURITY DEFINER functions require matching caller context
```

Cadena **lineal**, sin merges, todos ancestros de HEAD (`git merge-base
--is-ancestor <hash> HEAD` → sí, para los 10). `git show --stat` de cada
uno confirma que los archivos tocados coinciden exactamente con lo que el
mensaje de commit declara: migraciones SQL nuevas + tests nuevos + cambios
mínimos y quirúrgicos en `routes.ts` (nunca reescrituras masivas que
podrían esconder algo). Ningún commit toca archivos fuera de su hallazgo
declarado.

Commits adicionales verificados (cerraron el resto de la lista
"PENDIENTE" que quedaba fuera del ámbito original):

| Commit | Hallazgo | Verificado |
|---|---|---|
| `2019262` | API-09 (mitad `tool_calls`) | `UPDATE ... WHERE id=$1 AND authorization_status='pending'` real en el `WHERE`, test `security-api09-tool-calls-atomic.test.ts` |
| `038283e` | API-10 | Migración `0035_fix_api10_audit_log_nullable_org.sql` (relaja `audit_log.org_id`), 3 `if(org_id)` eliminados en `modules/admin/routes.ts`, test `security-api10-audit-log-null-org.test.ts` |
| `91b97a1` | API-11 | `assertSafeFileContent` en `lib/storage.ts` antes de `storeFile`, rechaza ejecutables/llaves por magic bytes, test `security-api11-file-magic-bytes.test.ts` |
| `43c47ba` | API-12 | `timingSafeEqual` en `requirePlatformApiKey`, `plugins/auth.plugin.ts`, test `security-api12-platform-key-constant-time.test.ts` |
| (agent-stores.pg.ts) | DB-09 (mitigación adicional) | Caché `Map` en `PgRunStore`/`PgToolCallStore` poblada con datos reales de `createRun`/`recordToolCall`; el oráculo `agent_run_context` solo se usa como último recurso. Test `security-db09-agent-run-context-cache.test.ts` (revoca `EXECUTE` y confirma que la instancia que creó el recurso sigue funcionando, mientras una instancia nueva falla) |

---

## 2. Suites completas (HEAD `f1d3bc9`)

| Paquete | Comando | Resultado |
|---|---|---|
| `packages/db` | `npm run -w packages/db test` | **144/144 verde** (19 archivos) |
| `packages/db` | `typecheck` / `lint` | OK, 0 errores |
| `apps/api` | `npm run -w apps/api test` | **95/95 verde** (29 archivos) |
| `apps/api` | `typecheck` / `lint` | OK, 0 errores |

Reproducido 2 veces cada uno (una tras cada resincronización relevante de
HEAD), estable en ambas corridas. Ver §0 de `reverify-dbapi-seguridad.log`
para el hallazgo de reproducibilidad de la migración 0034 (encontrado en
`a8d5442`, ya corregido en `5bcaa41`, no presente en HEAD final).

---

## 3. Ataques ejecutados por hallazgo

### DB-08 (refresh tokens SECURITY DEFINER)

- **Acuñar refresh para otro `user_id` falsificando `SET LOCAL
  app.current_user_id`**: confirmado que la app SÍ puede setear ese GUC a
  **cualquier valor** vía `set_config` (no hay validación criptográfica a
  nivel de motor) — pero grep exhaustivo de **todos** los call-sites de
  `set_config('app.current_user_id', ...)` en `apps/api/src` (más de 40)
  confirma que el valor siempre proviene de `request.userId` (derivado de
  un JWT firmado y verificado en `auth.plugin.ts`) o de un `actorId` local
  igual a ese, **nunca** de un campo de body/params/headers sin verificar.
  **apps/api es el ÚNICO guardián** de ese GUC — no hay defensa en
  profundidad a nivel de Postgres para esto específicamente, más allá de
  que DB-01/DB-08/DB-12 rechazan si el valor fijado **no coincide** con el
  parámetro pedido (protege contra un GUC correcto pero un parámetro
  incorrecto, no contra un GUC en sí falso).
- **Revocar sesiones ajenas como superadmin**: confirmado que SÍ es
  posible (by design, `0040` lo permite explícitamente para
  `is_superadmin()`), y que la función SQL **no escribe nada en
  `audit_log`** por sí misma (0 filas). **Hoy es un no-issue en la
  práctica**: grep confirma que `apps/api` no llama a
  `revoke_all_refresh_tokens` en ningún lugar — no existe ningún endpoint
  HTTP que exponga esta capacidad a un superadmin. Si en el futuro se
  agrega uno, deberá auditarse explícitamente en la capa de aplicación.
- **`SET ROLE` a otro rol de BD**: ver DB-14 arriba — "funciona" por la
  identidad de la conexión física, no por un fallo de RLS/grants.
- **Auditoría exhaustiva de funciones `SECURITY DEFINER` (0029-0039
  incluidas)**: ejecutado contra HEAD real. 15 funciones en
  `pg_proc`/`app`, las 15 en la lista blanca justificada de
  `security-definer-audit.test.ts`, 0 sin revisar. Ninguna migración de
  ronda 3 (0029-0039, extensiones de expediente) introdujo una función
  `SECURITY DEFINER` nueva.

**Veredicto: CERRADO.**

### DB-12 (`my_organizations`)

- Sin contexto de sesión (GUC vacío) con datos reales de otra
  organización presentes en la BD → **0 filas, nunca error, nunca datos
  ajenos**.
- La firma pública ya no acepta `p_user_id` — invocarla con un argumento
  falla por firma inexistente (confirmado en runtime, no solo por lectura
  de código).

**Veredicto: CERRADO.**

### API-08 / API-02 (escalada a owner)

- Variante "PATCH de invitación pendiente": **no existe tal ruta** en el
  código real (solo `POST /invitations` y `POST /invitations/accept`) —
  confirmado con un `PATCH /organizations/invitations/:id` real → 404. La
  superficie de ataque hipotética del encargo no existe hoy.
- Variante "aceptar y luego autopromoverse": admin invita hasta `writer` →
  invitado acepta (rol `writer` real) → el propio invitado intenta `PATCH
  .../memberships/:userId` con `role:'owner'` → **403**, mismo guard de
  API-02.
- Control positivo, exactamente 2 owners: un owner SÍ puede degradar al
  otro (200, deja 1 owner); intentar degradar a ese último owner restante
  → **409** (protección del último owner funcionando en el límite exacto,
  no solo en el caso trivial de 1 owner).

**Veredicto: CERRADO.**

### DB-02 / DB-10 (vigencia de tarifa vs. `submission_deadline`)

- **Caso inverso** (tarifa vigente a la fecha del acto pero ya vencida
  hoy): `INSERT` **aceptado** correctamente — REQ-023 funciona en ambas
  direcciones, no solo en el sentido que probaba el test oficial.
- **`submission_deadline` NULL**: cae a `current_date` (comportamiento
  previo preservado), tarifa vencida hoy sigue rechazándose.
- **Zona horaria** (hallazgo nuevo DB-13, ver resumen ejecutivo): resultado
  sensible a un `TimeZone` de sesión nunca fijado explícitamente.

**Veredicto: CERRADO para el defecto original (DB-02/DB-10 tal como
estaban redactados); NO CERRADO el matiz nuevo DB-13 (zona horaria).**
[Nota posterior del corrector: DB-13 ahora **RESUELTO** por
`0050_fix_db13_rate_validity_timezone.sql` — ver "Estado reparación" en
la sección `### DB-13` más abajo.]

### API-01 / API-09 (refresh, TOCTOU)

- Reuso tras rotación: token viejo → 401; el token **hijo** recién
  emitido (nunca usado) también queda revocado por la respuesta de
  familia completa → 401 en un intento posterior.
- 3 refresh concurrentes con el mismo token (`Promise.all`): **exactamente
  1×200 + 2×401**, estable en todas las corridas.
- Token robado tras logout: logout revoca; el intento posterior con el
  mismo token → 401.
- `tool_calls` approve/deny (mitad de API-09 cerrada por `2019262`):
  `UPDATE ... WHERE ... AND authorization_status='pending'` real.
- Gap nuevo encontrado (API-13): la revocación defensiva de familia
  completa no deja rastro en `audit_log`.

**Veredicto: CERRADO para API-01/API-09 tal como estaban redactados; NO
CERRADO el matiz nuevo API-13 (ausencia de auditoría de eventos de
autenticación).**
[Nota posterior del corrector: API-13 ahora **RESUELTO** por
`recordAuthAudit`/`0051_fix_api13_auth_audit_log.sql` — ver "Estado
reparación" en la sección `### API-13` más abajo.]

### API-03 (timing de `/auth/login`)

- **100 muestras por lado** (el doble de las 50 oficiales), misma
  metodología (app Fastify+PGlite aislada por lote de 5 logins, límite
  real del rate-limiter): mediana existente=26.61ms, mediana
  inexistente=28.53ms, **ratio=1.07x** (umbral de aceptación <1.5x).
- Enumeración por `/auth/register`: confirmado independientemente que un
  email duplicado devuelve 201 genérico, sin duplicar fila, sin
  sobrescribir contraseña, sin filtrar el id real de la cuenta existente.
- Enumeración por invitaciones: token inexistente → 409 "Invitación no
  encontrada" (mensaje/status uniforme entre los 3 casos posibles según el
  código; no se detectó un canal de enumeración distinto).

**Veredicto: CERRADO.**

### DB-09 (`agent_run_context`)

- Confirmado el cierre parcial original (0044): con sesión ya autenticada,
  la función rechaza.
- Confirmado el gap residual documentado (sin contexto previo, la función
  sigue resolviendo cualquier `run_id` adivinado).
- **Mitigación nueva** (posterior al encargo, verificada): `agent-
  stores.pg.ts` cachea en memoria de proceso el contexto real conocido
  desde `createRun`/`recordToolCall`; el camino común (misma instancia que
  creó el recurso) ya no toca el oráculo en absoluto. Confirmado con el
  test que revoca `EXECUTE` sobre la función: la instancia que creó el
  recurso sigue funcionando, una instancia nueva falla.
- **Confirmado en runtime** (no solo por lectura de código): ninguna ruta
  HTTP de `apps/api` invoca `RunStore.getRun`/`updateRun` por `:id`
  individual hoy — `app.printRoutes()` solo expone `/agents/runs` (lista
  por org) y `/agents/tool-calls` (lista + approve/deny, todos filtrados
  por `org_id` real, nunca por el oráculo). El gap residual es real a
  nivel de la función SQL, pero **inalcanzable vía HTTP en el estado
  actual de la API** — se activaría el día que se conecte `AgentRunner`
  con un endpoint de consulta por id.

**Veredicto: PARCIAL** (mitigación real y verificada que reduce la
superficie práctica casi a cero; el cierre completo de la función en sí
sigue pendiente y requeriría cambiar la interfaz externa de
`packages/agents`, documentado honestamente como tal).

### DB-11 (comentario de grants de `worker_role`)

Corregido vía `COMMENT ON ROLE` (`0045`), sin editar `0028`. Documentación
ahora precisa.

**Veredicto: CERRADO.**

### DB-06 (nota de portabilidad de `sha256()`)

Corregido vía `COMMENT ON FUNCTION` (`0046`). Sigue pendiente, como ya
señalaba el informe anterior, verificar la versión real de Postgres de
producción antes de desplegar (no es algo que un test pueda cerrar por sí
solo).

**Veredicto: CERRADO** (para el alcance de la corrección de documentación;
la verificación contra Postgres de producción real es un paso operativo
fuera del alcance de código).

### API-10 (`audit_log` con `org_id` NULL)

Migración `0035` relaja `audit_log.org_id` a NULL-able; los 3 `if
(org_id)` que omitían la auditoría en `modules/admin/routes.ts`
eliminados. Confirmado por el test oficial (`security-api10-audit-log-
null-org.test.ts`) que un job/incidente sin organización reintentado por
un superadmin **sí** queda en `audit_log` con `org_id = null`.

**Veredicto: CERRADO.**

### API-11 (magic bytes en subida de documentos)

`assertSafeFileContent` corre antes de `storeFile`, rechaza (422)
ejecutables (PE/ELF/Mach-O/class) y llaves/certificados en bruto (PEM o
prefijo ASN.1 DER), independiente del `documentType` declarado. Lista
negra mínima *fail-closed*, no pretende ser lista blanca completa
(documentado así explícitamente).

**Veredicto: CERRADO** (para el alcance declarado; no es una validación
exhaustiva de tipo de archivo por categoría, pero cierra el vector
concreto que originó el hallazgo).

### API-12 (comparación no constante)

`timingSafeEqual` con igualación de longitud explícita en
`requirePlatformApiKey`.

**Veredicto: CERRADO.**

---

## 4. Hallazgos nuevos de esta ronda

### DB-13 — MEDIA — vigencia de tarifas evaluada en el `TimeZone` por defecto de la sesión de Postgres, nunca fijado explícitamente

**Evidencia**: `app.enforce_approved_rate` (`0042`) hace
`v_submission_deadline::date` sin que ningún archivo de `packages/db` fije
`SET TIME ZONE` en ningún punto de la conexión/migración/trigger.
Confirmado empíricamente: con `submission_deadline='2026-01-15T05:00:00Z'`
y una tarifa `valid_until='2026-01-14'`, el resultado del `INSERT`
(aceptado/rechazado) depende de si la sesión evalúa en UTC-6
(`America/Mexico_City`, donde ese instante cae en 2026-01-14 → aceptado) o
en UTC (donde cae en 2026-01-15 → rechazado). En este entorno de prueba el
`TimeZone` por defecto de PGlite resultó ser `Etc/GMT+6` (heredado del `TZ`
del sistema operativo del worktree, que coincidía por casualidad con
México) — un servidor Postgres de producción con `TimeZone=UTC`
(configuración por defecto extendida en proveedores cloud) evaluaría el
mismo dato con el resultado opuesto. Contraste: `apps/web/src/lib/
datetime.ts` **sí** fija explícitamente `America/Mexico_City` para
mostrarle fechas al usuario — hay una inconsistencia real entre la zona
horaria de VALIDACIÓN (servidor Postgres, no fijada) y la de PRESENTACIÓN
al usuario (fijada).

**Severidad**: MEDIA (afecta la corrección de una decisión de negocio con
dinero real — REQ-023 — en un margen de horas alrededor de la medianoche,
no una fuga de datos).

**Reparación sugerida**: fijar explícitamente `set time_zone =
'America/Mexico_City'` (o el equivalente al inicio de la transacción/
conexión) en el trigger o en `withTenantContext`, o comparar usando
`submission_deadline AT TIME ZONE 'America/Mexico_City'` en vez de un cast
`::date` desnudo que hereda el TZ ambiente de la sesión.

**Estado reparación**: **RESUELTO** — `packages/db/migrations/0050_fix_db13_rate_validity_timezone.sql`
reemplaza el cast `::date` desnudo por `(v_submission_deadline at time
zone 'America/Mexico_City')::date` (y el mismo criterio para el fallback
`now()`), tal como sugería esta fila. Test real
(`packages/db/test/security-db13-rate-validity-timezone.test.ts`)
reproduce el escenario exacto de esta reverificación
(`submission_deadline='2026-01-15T05:00:00Z'`, tarifa vence
`'2026-01-14'`) y confirma el MISMO veredicto (aceptada) bajo `TimeZone`
de sesión `UTC` y `Asia/Tokyo` — confirmado en rojo (2/3 fallan) sin la
migración y en verde con ella.

### API-13 — BAJA/MEDIA — eventos de autenticación no se registran nunca en `audit_log`

**Evidencia**: `apps/api/src/modules/auth/routes.ts` (login, refresh,
logout) no contiene ninguna llamada a `recordAudit` (grep confirma 0
ocurrencias). En particular, la revocación defensiva de **toda la familia
de sesiones activas** de un usuario que dispara la detección de reuso de
un refresh token (API-01, `app.rotate_refresh_token`, `0043`) — un evento
que indica una sospecha real de robo de token — no deja ningún rastro en
`audit_log`. Confirmado con un ataque real: reusar un token ya rotado
provoca la revocación de familia (verificado por el 401 posterior del
token hijo), y `audit_log` permanece en 0 filas relacionadas con
`refresh`/`token`/`reuse` antes y después del evento.

**Severidad**: BAJA/MEDIA (no es una fuga de datos ni una escalada de
privilegios; es un gap de observabilidad de seguridad — un incidente de
posible robo de sesión, exactamente el tipo de evento que un back office
de seguridad querría ver, es invisible hoy).

**Reparación sugerida**: agregar `recordAudit` en `/auth/refresh` cuando
se detecta reuso (acción tipo `auth.refresh_reuse_detected`, con el
`user_id` afectado) y, opcionalmente, en login exitoso/logout para
trazabilidad completa de sesión — siguiendo el mismo patrón ya usado en
`modules/organizations/routes.ts` y `modules/admin/routes.ts`.

**Estado reparación**: **RESUELTO** — `lib/audit.ts` (`recordAuthAudit`) +
`packages/db/migrations/0051_fix_api13_auth_audit_log.sql`
(`app.record_auth_event`, `SECURITY DEFINER`, necesario porque la política
RLS de `audit_log` solo permite `org_id IS NULL` para superadmin, ver
0035). `auth/routes.ts` ahora audita login (éxito/fallo), refresh
(éxito/reutilización con revocación de familia) y logout, con actor,
ip, user-agent y `request_id` -- nunca contraseña ni token. Test real
(`apps/api/test/security-api13-auth-audit-log.test.ts`, 5 casos)
confirmado en rojo (función no existe) sin la migración `0051` y en verde
con el fix; incluye el escenario exacto de esta fila (reutilizar un
refresh token ya rotado registra `auth.refresh_reuse_detected`).

### DB-14 — nota arquitectónica (no un hallazgo nuevo distinto) — `SET ROLE` desde `app_role` a otros roles "funciona" por la identidad de la conexión física, no por RLS

Ver resumen ejecutivo. Mismo riesgo ya documentado por el proyecto para
DB-07 ("el runtime de la API nunca debe conectarse con [el] usuario
[propietario]... si el código se conecta sin `SET LOCAL ROLE app_role`,
sigue siendo el propietario/superusuario y todas las políticas RLS se
ignoran silenciosamente"). No se abre como hallazgo numerado accionable
separado porque no hay una reparación de código distinta a la que DB-07 ya
propone (asegurar que `DATABASE_URL` de runtime en producción use un rol
sin `BYPASSRLS`/superusuario, y que el static-test de DB-07
(`audit-db07-tenant-context-pattern.test.ts`) siga ampliándose). Se
documenta para que quede explícito en el registro de auditoría.

---

## 5. Conteo de ataques

| Fuente | Ejecutados | Confirman defensa correcta | Revelan hallazgo nuevo |
|---|---|---|---|
| Ronda anterior (RLS por tabla + funciones, `docs/logs/reverify-dbapi.log`) | 176 | 173 | 3 (ya cerrados: DB-08 ×2, DB-09 ×1) |
| Esta ronda — `packages/db` (script temporal, 11 casos) | 11 | 9 | 2 (DB-13 timing/TZ; nota DB-14) |
| Esta ronda — `apps/api` (script temporal, 11 casos) | 11 | 10 | 1 (API-13) |
| **Total** | **198** | **192** | **6** |

Ningún ataque de esta ronda resultó en una fuga de datos cross-organización
nueva ni en una escalada de privilegios nueva explotable — los 3
hallazgos nuevos (DB-13, DB-14, API-13) son, respectivamente: una
dependencia de configuración no fijada (integridad de una decisión de
negocio), una nota arquitectónica ya cubierta por un hallazgo existente, y
un gap de observabilidad/auditoría.

---

## 6. Qué sigue abierto en `apps/api` (para el implementador de ronda 3)

Al momento de escribir este informe (HEAD `f1d3bc9`), **todo lo que la
tabla original marcaba como PENDIENTE fuera del ámbito del corrector de
seguridad ya fue cerrado por el mismo autor**, en paralelo a este encargo:

- ~~API-09 (mitad `tool_calls`)~~ → **RESUELTO** (`2019262`).
- ~~API-10~~ → **RESUELTO** (`038283e` + migración `0035`).
- ~~API-11~~ → **RESUELTO** (`91b97a1`).
- ~~API-12~~ → **RESUELTO** (`43c47ba`).
- ~~DB-09 (mitigación adicional)~~ → **PARCIAL, mejorado** (caché de
  contexto en `agent-stores.pg.ts`; el cierre completo de
  `app.agent_run_context` en sí mismo requiere cambiar la interfaz externa
  de `packages/agents` para pasar la identidad del actor — arquitectura
  mayor, no un fix quirúrgico).

**Lo único genuinamente pendiente para un futuro implementador**, en orden
de prioridad:

1. **API-13 (nuevo, esta ronda)** — auditar eventos de autenticación,
   especialmente la revocación de familia por reuso de refresh token.
   `apps/api/src/modules/auth/routes.ts`.
2. **DB-13 (nuevo, esta ronda)** — fijar el `TimeZone` de evaluación de
   vigencia de tarifas a `America/Mexico_City` explícitamente.
   `packages/db/migrations/` (nueva migración) o `packages/db/src/
   context.ts` (`withTenantContext`).
3. **DB-09 completo** — pasar la identidad del actor autenticado a través
   de la interfaz `RunStore`/`ToolCallStore` de `packages/agents` para que
   `apps/api/src/lib/agent-stores.pg.ts` nunca necesite el oráculo. Baja
   urgencia real hoy (inalcanzable vía HTTP), pero se volverá relevante en
   cuanto se conecte `AgentRunner` con un endpoint de consulta por id.
4. **DB-07** (sin cambios, decisión de alcance ya documentada) — migrar
   los sitios de `apps/api/src/**` fuera de `auth`/`organizations` a
   `withTenantContext`.
5. **DB-14 / DB-07** (arquitectura) — verificar/documentar en el proceso
   de despliegue que el rol de `DATABASE_URL` de runtime en producción NO
   tenga `BYPASSRLS` ni sea superusuario, y considerar un chequeo de
   arranque (`SELECT current_setting('is_superuser')` /
   `rolbypassrls`) que falle rápido si se configuró mal.

---

## Anexo: metodología

Un solo worktree principal (`<scratch>/reverify-sec`, `npm install` real),
resincronizado varias veces a medida que HEAD avanzaba, más un worktree
auxiliar temporal (`<scratch>/reverify-sec-baseline`, fijado en `a8d5442`)
usado únicamente para aislar y confirmar el hallazgo de reproducibilidad
de §0 antes de descartarlo. Los 2 scripts adversariales temporales
(`packages/db/test/zz-adversarial-reverify-sec.test.ts` y
`apps/api/test/zz-adversarial-reverify-sec.test.ts`) fueron borrados al
cerrar; `git status`/`git diff --stat` quedaron limpios en ambos
worktrees antes de eliminarlos. Ambos worktrees eliminados con `git
worktree remove --force` al finalizar. Detalle completo de comandos y
salidas en `docs/logs/reverify-dbapi-seguridad.log`.
