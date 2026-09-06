# Auditoría adversarial — packages/db + apps/api (ronda 1)

**Ámbito auditado**: `packages/db/**` y `apps/api/**` en el commit
`8052ff49359336d184a993fc2df160ac9b3cc08f`
("feat(db,api): esquema multi-tenant con RLS, migraciones idempotentes sobre
PGlite/pg, y API Fastify ronda 1 (auth, organizaciones, salud)").

**Auditor**: agente Sonnet independiente, sin participación en la construcción
de estos paquetes. Trabajo realizado en `git worktree add <scratch>/audit-dbapi
8052ff4` (nunca en el árbol principal, que otros agentes seguían usando).
Worktree eliminado al terminar (`git worktree remove`). Ejecución real de
`npm install`, `test`/`typecheck`/`lint` de ambos paquetes, `npm audit`, tres
scripts adversariales propios (RLS dinámico, integridad de negocio, API) y 5
mutaciones manuales de políticas/constraints revertidas una por una.

**Comandos y salida completa**: `docs/logs/audit-dbapi-ronda1.log`.

---

## Resumen ejecutivo

`packages/db` es, en su núcleo de aislamiento multi-tenant, **sólido**: 622
ataques dinámicos de RLS (34 tablas de dominio × 6 roles ×
SELECT/INSERT-spoof/UPDATE/DELETE, más contexto con org fantasma, reasignación
de `org_id`, JOIN/subconsulta cruzando organizaciones, y llamadas directas a
las funciones `SECURITY DEFINER`) bloquearon **620/622** intentos. Las 5
mutaciones manuales de políticas/constraints clave (debilitar la política RLS
genérica, quitar la unicidad de `idempotency_keys`, permitir `UPDATE` en
`audit_log`, quitar el chequeo de tarifa aprobada, quitar el constraint de
checklist) fueron capturadas **5/5** por la suite oficial — los 90+12 tests no
son solo camino feliz para los mecanismos centrales. La reproducibilidad es
perfecta y coincide byte-a-byte con `docs/logs/api-ronda1.log`.

Sin embargo, la auditoría encontró:

- **Dos funciones `SECURITY DEFINER`** (`app.membership_role`,
  `app.find_user_by_email`) están pensadas para usarse solo antes de que exista
  contexto de sesión (login, resolución de `X-Org-Id`), pero **son invocables
  directamente por cualquier sesión ya autenticada con parámetros ajenos**, sin
  ninguna comprobación adicional de autorización dentro de la función. Esto
  filtra el rol real de un usuario de otra organización y el `password_hash`
  de cualquier usuario a un actor de una organización sin relación (DB-01).
- El trigger que impide "no inventar precios" (`app.enforce_approved_rate`)
  valida `status='approved'` y la organización, pero **nunca valida vigencia**
  (`valid_from`/`valid_until`): una tarifa aprobada pero vencida se puede usar
  igual (DB-02). Tampoco existe ningún mecanismo que **revierta la aprobación**
  o invalide líneas/aprobaciones dependientes si el precio de una tarifa ya
  aprobada se modifica después (DB-03) — contradice el espíritu de REQ-162
  aplicado a precios.
- **No existe ningún trigger de invalidación automática** al insertar
  `tender_change_events`: las columnas `invalidated_at`/`invalidated_reason`
  existen pero solo se llenan si algún código de aplicación las actualiza a
  mano, y ese código **no existe todavía en `apps/api`** (auto-declarado como
  pendiente). REQ-155/REQ-162 ("tolerancia cero") no están cerrados a nivel de
  base de datos ni de API en este commit (DB-05).
- A nivel de API: el **refresh token no rota ni se puede revocar** — el mismo
  token se reutilizó 3 veces seguidas emitiendo tokens válidos cada vez
  (API-01). `PATCH /organizations/memberships/:userId` permite que **un admin
  se autopromueva a owner** y que **degrade al único owner de la
  organización, dejándola huérfana** — verificado empíricamente, sin
  escalación previa de por medio (API-02). `POST /auth/register` confirma por
  `409` explícito si un email ya existe (enumeración de usuarios, API-03). No
  hay cabeceras de seguridad HTTP (helmet-like) ni gate de `/docs/json`
  (API-05/API-06).

Varias limitaciones (jobs con PGlite mono-conexión, sin endpoint de aceptar
invitación, sin revocación de refresh, sin endpoints de la ampliación back
office) están **auto-declaradas explícitamente** en los `README.md` de ambos
paquetes y en `docs/PROGRESO.md` ("Limitaciones honestas") — no se encontró
ningún caso de trabajo pendiente marcado como completado.

**Conteo de hallazgos por severidad**: CRÍTICA: 0 · ALTA: 5 · MEDIA: 5 · BAJA: 4
→ **14 hallazgos** (DB-01 a DB-07, API-01 a API-07).

**Conteo de ataques RLS**: 622 ejecutados, 620 bloqueados, 2 con fuga (ambos en
el mismo mecanismo: funciones `SECURITY DEFINER` invocables directamente).

---

## 1. Reproducibilidad

| Paso | Resultado | Evidencia |
|---|---|---|
| `npm install` (worktree) | OK, 611 paquetes | log §1 |
| `npm run -w packages/db test` | **7 archivos / 90 tests**, todos en verde | log §1, idéntico a `docs/logs/api-ronda1.log` |
| `npm run -w packages/db typecheck` / `lint` | OK, sin errores | log §1 |
| `npm run -w apps/api test` | **3 archivos / 12 tests**, todos en verde | log §1, idéntico al baseline |
| `npm run -w apps/api typecheck` / `lint` | OK, sin errores | log §1 |

**Veredicto: CUMPLE.** Reproducibilidad exacta contra `docs/logs/api-ronda1.log`
(mismos archivos, mismo conteo de tests, mismos tiempos de orden de magnitud).

---

## 2. RLS adversarial dinámico

Script propio (`adversarial-rls.ts`, worktree, no forma parte del repo) que,
para las **34 tablas de dominio** con `org_id` (las mismas que
`test/helpers.ts::DOMAIN_TABLES`), simula una sesión de la organización B con
**cada uno de los 6 roles** (`owner, admin, analyst, writer, reviewer,
viewer`) contra filas de la organización A:

- `SELECT` cross-org → 204 verificaciones, 0 fugas.
- `UPDATE` cross-org (no-op esperado) → 204 verificaciones, 0 fugas.
- `DELETE` cross-org (no-op esperado) → 204 verificaciones, 0 fugas.

Más los ataques adicionales que el suite oficial **no** cubre:

| Ataque | Resultado |
|---|---|
| Contexto con `org_id` **inexistente** (UUID que no está en la tabla `organizations`, no solo "sin contexto") sobre `tenders` | Bloqueado (0 filas) |
| `INSERT` con `org_id` de una organización real mientras el contexto de sesión es una org fantasma | Bloqueado (`RLS WITH CHECK`) |
| `INSERT` con `org_id` **ajeno** mientras el actor está autenticado en orgB (spoofing clásico, con `RETURNING`) | Bloqueado (`RLS WITH CHECK` / 42501) |
| `UPDATE` que intenta **reasignar `org_id`** de una fila propia hacia otra organización (exfiltración por reasignación) | Bloqueado (`new row violates row-level security policy`) |
| `JOIN` explícito `tenders ⋈ proposals` cruzando organizaciones | Bloqueado (0 filas) |
| Subconsulta `EXISTS` como oráculo booleano de existencia de un id ajeno | Bloqueado (`false`) |
| `app.has_role(orgAjena, roles[])` invocada directamente por un actor sin membresía en esa org | Bloqueado (`false`, valida membresía real, no el argumento) |
| `app.is_superadmin()` para un actor normal | Bloqueado (`false`) |
| `app.membership_role(orgAjena, usuarioAjeno)` invocada directamente | **FUGA** — ver DB-01 |
| `app.find_user_by_email(emailAjeno)` invocada directamente por cualquier actor autenticado | **FUGA** — ver DB-01 |
| Bypass de superusuario sin `SET LOCAL ROLE app_role` (simula una ruta que "olvida" fijar el rol) | Confirmado como riesgo arquitectónico documentado (no cuenta como ataque bloqueado/fuga, ver DB-07) |

**Total: 622 ataques ejecutados, 620 bloqueados, 2 fugas.** Salida completa en
`docs/logs/audit-dbapi-ronda1.log` §2.

**Veredicto: PARCIAL.** El mecanismo de RLS por tabla (políticas
`app.apply_org_rls`) es extremadamente robusto — incluye spoofing de `org_id`
en INSERT/UPDATE, JOINs, subconsultas y contexto fantasma, todo bloqueado. La
falla está fuera de ese mecanismo: en dos funciones auxiliares diseñadas para
"pre-contexto" (login, resolución de `X-Org-Id`) que no imponen ninguna
verificación de autorización propia cuando se llaman con parámetros
arbitrarios (DB-01).

---

## 3. Integridad de negocio en DB

Script propio (`adversarial-business.ts`):

| Verificación | Resultado |
|---|---|
| `INSERT` en `proposal_pricing_lines` referenciando una tarifa **de otra organización** | Bloqueado por el trigger (`La tarifa % pertenece a otra organización`) |
| `INSERT` referenciando una tarifa **aprobada pero con `valid_until` vencido** (30 días en el pasado) | **FALLA** — se insertó sin error, ver DB-02 |
| `UPDATE` de `unit_price` en una tarifa **ya aprobada**, sin cambiar su `status` | **FALLA** — el precio cambió y siguió "approved" sin invalidar nada, ver DB-03 |
| `INSERT` de `package_manifests` en `status='ready'` con `checklist_snapshot` **no nulo pero con items en rojo/faltantes** | **FALLA** — el `CHECK` solo exige "no nulo", no completitud real, ver DB-04 |
| `INSERT` de un `tender_change_events` y verificación de si `proposals.invalidated_at` se llena **automáticamente** | **FALLA** — no existe trigger, ver DB-05 |

**Comprobado correcto por lectura de código y prueba dirigida** (no está en el
script, se verificó en las migraciones y en `test/backoffice-extension.test.ts`):
`tender_versions` deduplica de verdad por `unique(org_id, tender_id,
source_version)` (pgTAP-equivalente: reintentar la misma versión falla por
`duplicate key`); `idempotency_keys` es único por `(org_id, key)`; el reclamo
de `jobs` usa un único `UPDATE ... FOR UPDATE SKIP LOCKED` atómico (ver
limitación documentada de PGlite mono-conexión en el propio README, aceptable
dado el entorno sin Postgres/Docker disponible).

**Veredicto: PARCIAL.** El único ataque que sí bloquea correctamente es el
cruce de organización en el FK de tarifas. Los otros cuatro representan
huecos reales de integridad de precio/checklist/invalidación; dos de ellos
(checklist "completo" y auto-invalidación) están auto-declarados como fuera de
alcance en `packages/db/README.md` ("la validación de completitud real es
lógica de aplicación... packages/expediente"), pero los otros dos (vigencia de
tarifa, re-aprobación tras cambio de precio) **no están declarados en ningún
lado** como limitación conocida.

---

## 4. API

Script propio (`adversarial-api.ts` + `adversarial-api-2.ts`), 22
verificaciones sobre `fastify.inject` (misma técnica que los tests oficiales):

| Verificación | Resultado |
|---|---|
| JWT `alg=none` | Bloqueado (401) |
| JWT con firma corrupta | Bloqueado (401) |
| JWT con `sub` falsificado sin re-firmar | Bloqueado (401) |
| Access token usado como refresh (confusión de `typ`) | Bloqueado (401) |
| Refresh token usado como access (confusión de `typ`) | Bloqueado (401) |
| Token expirado | Bloqueado (401) |
| Token firmado con secreto distinto | Bloqueado (401) |
| **Refresh token reutilizado 3 veces seguidas** | **FALLA** — ver API-01 |
| `/auth/register` con email duplicado | **FALLA** (409 explícito) — ver API-03 |
| Timing de `/auth/login` (email inexistente vs. existente+password mala) | OK en esta medición local (ratio 0.6×), pero el código sí ejecuta `scrypt` solo cuando el email existe — ver nota en API-03 |
| `X-Org-Id` con UUID inexistente | Bloqueado (403) |
| `X-Org-Id` con formato inválido (no UUID) | **FALLA** (500 en vez de 400) — ver API-04 |
| Admin se autopromueve a `owner` | **FALLA** (200 OK) — ver API-02 |
| Admin degrada al único `owner` de la organización (sin escalación previa) | **FALLA** — la organización quedó sin ningún owner — ver API-02 |
| Idempotency-Key idéntica en dos organizaciones distintas | OK (aisladas por `org_id`, ambas 201) |
| Rate limit 6º intento de login (mismo IP) | Bloqueado (429) |
| Rate limit con `X-Forwarded-For` falso (bypass) | Bloqueado (429; Fastify no confía en el header sin `trustProxy`) |
| `/docs/json` (OpenAPI) accesible sin autenticación | **FALLA** — ver API-06 |
| Cabeceras de seguridad HTTP (`X-Content-Type-Options`, `X-Frame-Options`, CSP, HSTS) | **FALLA** — ninguna presente, ver API-05 |
| Error 500 real en `NODE_ENV=production` no filtra mensaje interno | OK (verificado forzando un 500 real: en `production` el `title` es genérico; en `test`/`development` el mismo 500 sí expone el mensaje de Postgres, comportamiento esperado y documentado) |

**Veredicto: PARCIAL.** La capa criptográfica de JWT es sólida (7/7). La
gestión de sesión (refresh sin rotación) y la autorización de cambio de rol
(sin distinguir "a qué rol" ni "al último owner") tienen huecos reales y
explotables por cualquier usuario con rol `admin` en su propia organización.

---

## 5. Migraciones

- **Idempotencia real**: verificada dos veces — por la suite oficial
  (`migrate.test.ts`, aplicar dos veces no falla ni duplica) y por esta
  auditoría (`npm run -w packages/db test` ejecutado desde cero varias veces
  durante las mutaciones, siempre 90/90 en verde tras revertir).
- **Checksum contra ediciones silenciosas**: `schema_migrations(filename,
  checksum)` — `applyMigrations` lanza un error explícito si el contenido de
  una migración ya aplicada cambió (`packages/db/src/migrate.ts:68-74`), en
  vez de reaplicarla o ignorarla.
- **Orden/dependencias**: 16 archivos numerados `0001`-`0016`, aplicados en
  orden alfabético; cada migración solo referencia tablas/tipos creados en
  migraciones anteriores (verificado por lectura completa de las 16).
- **Compatibilidad con Postgres real (revisión estática)**: no se encontró
  ninguna sintaxis específica de PGlite. No se usa `CREATE EXTENSION`
  (`gen_random_uuid()` es núcleo desde Postgres 13, documentado
  explícitamente en el README); no se usa `citext` (evitado a propósito,
  también documentado); no se usa ningún tipo/función propietaria de PGlite.

**Veredicto: CUMPLE.**

---

## 6. Calidad de pruebas (mutación manual)

Se mutaron 5 mecanismos clave en el worktree, uno a la vez, revertidos con
`git checkout --` antes de la siguiente:

| # | Mutación | Suite afectada | Resultado |
|---|---|---|---|
| 1 | Comentar el chequeo `status <> 'approved'` en `app.enforce_approved_rate` | `backoffice-extension.test.ts` | 1 failed / 4 passed → **CAPTURADO** |
| 2 | Quitar `constraint package_ready_requires_checklist` | `backoffice-extension.test.ts` | 1 failed / 4 passed → **CAPTURADO** |
| 3 | Cambiar la política `SELECT` genérica de `app.apply_org_rls` a `using (true)` (afecta ~30 tablas) | `rls-isolation.test.ts` | **66 failed / 2 passed (de 68)** → **CAPTURADO masivamente** |
| 4 | Quitar `unique (org_id, key)` de `idempotency_keys` | `idempotency-and-audit.test.ts` | 1 failed / 3 passed → **CAPTURADO** |
| 5 | Agregar una política `UPDATE` permisiva sobre `audit_log` | `idempotency-and-audit.test.ts` | 1 failed / 3 passed → **CAPTURADO** |

**5/5 mutaciones detectadas.** Verificación final: suite completa vuelve a
90/90 en verde tras revertir las 5, `git diff --stat` vacío.

Sobre "¿las pruebas verifican comportamiento adversarial o solo camino
feliz?": la mayoría de los 90 tests de `packages/db` **sí son adversariales**
por diseño (`rls-isolation.test.ts` prueba activamente que un owner de A no
puede leer/editar/borrar filas de B, para las 34 tablas; `rls-roles.test.ts`
prueba viewer-no-escribe, writer-no-decide, outsider-no-se-autoasigna-super).
Los 12 tests de `apps/api` son mayoritariamente camino feliz con algunas
excepciones adversariales puntuales (403 cross-org, 422 por idempotencia en
conflicto, 429 por rate limit) — **no cubren** ninguno de los escenarios de
API-01/API-02/API-03 encontrados en esta auditoría (confirmado por lectura
completa de los 3 archivos de test).

**Veredicto: CUMPLE** (la suite tiene "dientes" reales, no es cosmética) **con
nota**: la cobertura adversarial de `apps/api` es notablemente más delgada que
la de `packages/db`.

---

## 7. Secretos y dependencias

- `apps/api/.env.example`: sin valores reales (`JWT_SECRET=cambia-este-secreto-en-produccion-min-32-caracteres`,
  placeholders explícitos en todas las variables).
- `.gitignore` raíz excluye `.env` y `.env.*` (con excepción explícita de
  `.env.example`).
- Grep de patrones de secretos (`api[_-]?key|secret|password|token` seguidos
  de un valor con pinta de credencial real) sobre `apps/api/src`,
  `packages/db/src` y ambos `test/`: **0 coincidencias** fuera de los
  placeholders de prueba (`test-secret-do-not-use-in-production-...`,
  `cambia-este-secreto...`).
- `npm audit` (worktree, mismo `package-lock.json` que produjo
  `docs/logs/api-ronda1.log`): **0 vulnerabilidades en dependencias de
  producción** (`npm audit --omit=dev`). Las 5 vulnerabilidades reportadas por
  `npm audit` (3 moderadas, 1 alta, 1 crítica) están **enteramente dentro de
  la cadena de devDependencies `vitest → vite-node → vite → esbuild`**
  (servidor de desarrollo/HMR), no se despliegan a producción. Cuenta
  idéntica a `docs/logs/api-ronda1.log`.

**Veredicto: CUMPLE.**

---

## 8. Trazabilidad REQ

Ámbito relevante (secciones 10-18, 22, 29-32 de `docs/REQUISITOS.md`) mapeado
contra evidencia real en este commit:

| REQ | Evidencia | Estado |
|---|---|---|
| REQ-057/058 (RLS + tenant_id obligatorio) | 34 tablas de dominio con `org_id` + RLS habilitada; `rls-isolation.test.ts` (68 tests) + 622 ataques de esta auditoría (620 bloqueados) | **Con evidencia fuerte**, salvo DB-01 |
| REQ-059/061 (muralla china entre tenants) | RLS real en Postgres, no solo filtro de aplicación; sin vector stores en este commit (no aplica aún) | **Con evidencia**, salvo DB-01 |
| REQ-062/063 (roles vía claims, cambio de tenant sin fuga) | Roles resueltos **por request** contra la DB (`app.membership_role`) en vez de ir embebidos en el JWT — diseño distinto al literal de REQ-063 pero con la misma propiedad de seguridad (no hay claim de rol que quede obsoleto); ningún rol "admin" puede saltar 2/2 porque 2/2 no existe todavía en este commit | **Diseño alternativo válido, evidencia parcial** (ver API-02 para el hueco real: SÍ hay escalada admin→owner) |
| REQ-064 (re-autenticación en aprobación económica) | No implementado en este commit (no hay endpoints de aprobación de precio todavía) | **Sin evidencia — fuera de alcance de esta ronda, no reclamado como hecho** |
| REQ-073/074 (idempotencia por clave) | `idempotency_keys` único por `(org_id, key)`; `POST /organizations/invitations` probado con clave repetida/cuerpo distinto/distinta org | **Con evidencia** |
| REQ-083 (audit_log append-only **con hash encadenado**) | Append-only SÍ (RLS sin política UPDATE/DELETE, confirmado por mutación #5); **hash encadenado NO existe** (sin columna de hash previo) | **PARCIAL — mitad del requisito sin evidencia, no declarado como pendiente en ningún README** (DB-06) |
| REQ-141-144 (perfil de empresa, procedencia, roles de edición) | Esquema completo (10 tablas) + RLS con roles diferenciados (owner/admin para firmantes/registros/documentos legales); **sin CRUD vía API** (`apps/api` no expone estas tablas, auto-declarado en su README) | **Esquema con evidencia; criterio de "CRUD probado" de REQ-141 sin evidencia** |
| REQ-145 (firmante autorizado referenciado por firma) | Tabla `authorized_signatories` existe; ningún flujo de firma existe todavía en este commit | **Sin evidencia — fuera de alcance, no reclamado** |
| REQ-151/152 (versionado + dedupe por origen) | `tender_versions` con `unique(org_id, tender_id, source_version)`, probado | **Con evidencia** |
| REQ-155/162 (invalidación automática de dependientes) | Columnas existen; **sin trigger automático**, sin código de aplicación que las use (auto-declarado pendiente para la API, pero el trigger de DB tampoco existe y no está declarado como pendiente) | **Sin evidencia de automatismo** (DB-05) |
| REQ-156-163 (expediente: matriz, bloqueos, ready↔checklist, versionado, paquete) | Solo el esquema (`package_manifests`, constraint parcial); lógica de completitud real vive en `packages/expediente` (otro paquete, fuera de este ámbito de auditoría) | **Esquema con evidencia parcial (DB-04); completitud fuera de este commit** |

**Pendiente explícitamente declarado por el implementador** (verificado que
NO se marcó como hecho en ningún lado — `docs/PROGRESO.md` línea "Ronda 1 —
packages/db + apps/api completado": *"Limitaciones honestas: PGlite una
conexión (concurrencia de jobs solo invariante atómico); sin endpoints de
ampliación aún; sin aceptar invitación ni revocar refresh"*; ambos
`README.md` repiten la misma lista con más detalle):

- Concurrencia real de `jobs` con múltiples conexiones físicas (solo probado
  el invariante atómico de la sentencia, no la concurrencia de SO).
- Endpoints de la ampliación back office (perfil de empresa, versiones de
  convocatoria, precios, aprobaciones, paquete final) en `apps/api`.
- Endpoint de aceptar invitación (la tabla `invitations` existe, el flujo no).
- Revocación/rotación de refresh tokens.
- Idempotencia y rate limit con alcance completo por organización/usuario
  (hoy: rate limit por IP global + override por ruta; idempotencia solo en
  mutaciones con `org_id` ya resuelto).

Ninguno de estos puntos fue encontrado marcado como "hecho" en `PROGRESO.md`,
`BACKLOG.md` ni en los README — la declaración de alcance es honesta y
consistente con el código real.

**Veredicto: CUMPLE** (trazabilidad honesta) **con hallazgos** en los puntos
donde SÍ se reclama una garantía (RLS "tolerancia cero", trigger anti-precio,
audit_log con hash) que el código no cumple del todo (DB-01, DB-02, DB-03,
DB-06).

---

## Comprobado correcto (verificado activamente, no solo leído)

- RLS por tabla (`app.apply_org_rls`) resiste spoofing de `org_id` en INSERT y
  UPDATE, JOINs y subconsultas cruzando organizaciones, y contexto con
  organización inexistente — no solo "sin contexto".
- `app.has_role()` e `is_superadmin()` no confían en el `org_id` recibido
  como argumento: validan membresía real contra `app.current_user_id()`.
- Las 5 mutaciones manuales de políticas/constraints clave fueron capturadas
  5/5 por la suite oficial (no es teatro de cobertura).
- JWT: rechazo correcto de `alg=none`, firma corrupta, `sub` falsificado,
  confusión de tipo access/refresh, token expirado y secreto distinto (7/7).
- `scrypt` con parámetros por defecto de Node y comparación
  `timingSafeEqual` — elección razonable y bien implementada.
- Rate limit por IP resiste bypass con `X-Forwarded-For` falso (Fastify no
  confía en el header sin `trustProxy` explícito, que no está activado).
- Idempotencia aislada correctamente por organización: la misma
  `Idempotency-Key` en dos organizaciones distintas no colisiona.
- `problem+json` en producción (`NODE_ENV=production`) verificado con un 500
  real forzado: el mensaje se enmascara correctamente; el mismo 500 en
  `test`/`development` sí expone el detalle (comportamiento documentado y
  esperado, no una fuga en producción).
- Sin CORS permisivo por omisión (no hay plugin `@fastify/cors`, por lo que
  no se agrega ninguna cabecera `Access-Control-*`; política restrictiva por
  defecto del navegador).
- Migraciones sin sintaxis específica de PGlite (revisión estática de las 16),
  compatibles con Postgres real según lo documentado.
- `.env.example` sin valores reales; `.gitignore` correcto; 0 secretos
  encontrados por grep; 0 vulnerabilidades de `npm audit` en dependencias de
  producción.
- Trazabilidad honesta: ninguna limitación auto-declarada se encontró
  marcada como completada en `PROGRESO.md`/`BACKLOG.md`.

---

## Tabla de hallazgos

| ID | Severidad | Rubro | Evidencia | Reparación sugerida (separada del hallazgo) | Estado reparación |
|---|---|---|---|---|---|
| DB-01 | **ALTA** | RLS / funciones SECURITY DEFINER | `packages/db/migrations/0010_app_support_functions.sql:13-42`. Confirmado con `adversarial-rls.ts` (bloque 5): un actor autenticado de orgB obtiene el rol real de un usuario de orgA vía `select app.membership_role(orgA, usuarioA)`, y el `password_hash` de cualquier usuario vía `select * from app.find_user_by_email(email)`. Escenario: entra `orgB` autenticado + `email` de un usuario de `orgA` → sale el hash de contraseña de ese usuario ajeno. | Restringir estas funciones para que solo puedan invocarse desde el flujo previsto (p. ej. revocar `EXECUTE` de `app_role` sobre ellas y exponerlas solo a través de funciones de más alto nivel que sí validen el llamador, o mover la lógica de login/resolución de header a un esquema separado sin `GRANT` general a `app_role`). | **CERRADO** — commit `c1c0f1c`. `app.membership_role` ahora de 1 argumento (siempre resuelve el propio `current_user_id()`); `app.find_user_by_email` rechaza ejecutarse si ya hay sesión (`current_user_id()` fijado). Migración `0019_fix_db01_security_definer_scope.sql`. Test: `packages/db/test/audit-db01-security-definer-scope.test.ts` (4 casos, rojo→verde verificado). |
| DB-02 | **ALTA** | Integridad de negocio (precio) | `packages/db/migrations/0014_pricing.sql:63-83` (`app.enforce_approved_rate`). Confirmado con `adversarial-business.ts`: `INSERT` en `proposal_pricing_lines` con una tarifa `status='approved'` pero `valid_until` 30 días en el pasado tiene éxito. | Agregar al trigger la validación `now()::date between coalesce(valid_from, '-infinity') and coalesce(valid_until, 'infinity')`, o equivalente contra la fecha del acto si aplica (ver REQ-023). | **CERRADO** — commit `62a77e0`. Migración `0020_fix_db02_rate_validity.sql` añade la validación de vigencia exacta sugerida. Test: `packages/db/test/audit-db02-rate-validity.test.ts` (3 casos: vencida, vigente, aún no vigente). |
| DB-03 | **ALTA** | Integridad de negocio (precio) | `packages/db/migrations/0014_pricing.sql` (tabla `approved_rates`, sin trigger). Confirmado: `UPDATE approved_rates set unit_price = 99999 where status='approved'` tiene éxito y el `status` sigue `'approved'`. | Trigger `BEFORE UPDATE` en `approved_rates` que, si `unit_price` (u otro campo material) cambia mientras `status='approved'`, fuerce `status='draft'` (o `'pending_reapproval'`) y limpie `approved_at`/`approved_by`; considerar invalidar `proposal_approvals` dependientes vía el mismo mecanismo de `tender_change_events`. | **CERRADO** — commit `7922171`. Migración `0021_fix_db03_rate_reapproval.sql`: trigger `app.revoke_rate_approval_on_material_change` implementa exactamente la reparación sugerida (revierte a `draft`, limpia `approved_by`/`approved_at`). Test: `packages/db/test/audit-db03-rate-reapproval.test.ts` (3 casos). |
| DB-04 | MEDIA | Integridad de negocio (checklist) | `packages/db/migrations/0015_approvals_and_packages.sql:59` (`package_ready_requires_checklist`). Confirmado: `checklist_snapshot` con items en rojo/faltantes pero no `NULL` pasa el `CHECK`. Auto-declarado en el README como responsabilidad de `packages/expediente`. | Si la validación de completitud vive en otro paquete, documentar explícitamente en `packages/db/README.md` que el `CHECK` es solo una defensa parcial (evita el caso trivial), no la garantía completa de REQ-159/160, para que quien lea el esquema no asuma más de lo que hay. | **CERRADO (documentación)** — commit `8a17818`. `packages/db/README.md`, sección "Alcance real del constraint package_ready_requires_checklist (DB-04)": documenta explícitamente el alcance parcial, tal como pedía la propia reparación sugerida. Sin cambio de esquema (la validación de completitud real sigue siendo responsabilidad de `packages/expediente`). |
| DB-05 | **ALTA** | Invalidación automática (REQ-155/162) | `packages/db/migrations/0012_tender_versions.sql`. Confirmado: insertar un `tender_change_events` no modifica `proposals.invalidated_at` de ninguna propuesta del mismo `tender_id`. Sin trigger, sin función asociada en ninguna de las 16 migraciones. | Trigger `AFTER INSERT` en `tender_change_events` que marque `invalidated_at`/`invalidated_reason` en `proposals`/`compliance_items`/`requirement_items` (y, cuando exista, `proposal_approvals`) del mismo `tender_id`, o documentar explícitamente que esta invalidación es 100% responsabilidad de la capa de aplicación (y bloquear el cierre de REQ-155/162 hasta que esa capa exista). | **CERRADO** — commit `0698544`. Migración `0022_fix_db05_change_event_invalidation.sql`: trigger `app.invalidate_tender_dependents` implementa exactamente la reparación sugerida, incluida `proposal_approvals`. `apps/api/src/modules/tenders/internal-ingest.routes.ts` se simplificó para depender del trigger en vez de duplicar la lógica. Test: `packages/db/test/audit-db05-change-event-invalidation.test.ts` (4 casos) + `apps/api/test/tenders-and-ingest.test.ts` (caso A3 end-to-end vía HTTP). |
| DB-06 | MEDIA | Auditoría (REQ-083) | `packages/db/migrations/0003_system_tables.sql` (tabla `audit_log`, sin columna de hash). El append-only SÍ está garantizado (RLS sin política UPDATE/DELETE, confirmado por mutación #5), pero no hay "hash encadenado" en absoluto. | Agregar `prev_hash`/`hash` a `audit_log`, calculados en el mismo `INSERT` (trigger `BEFORE INSERT` que calcule `sha256(prev_hash || fila_serializada)`), y una función de verificación de cadena para CI, tal como pide el criterio verificable de REQ-083. | **CERRADO** — commit `5c0080c`. Migración `0023_fix_db06_audit_log_hash_chain.sql`: columnas `prev_hash`/`hash` + `chain_seq` (orden estrictamente monótono, necesario porque `created_at` por sí solo permite empates), trigger `app.audit_log_chain_insert`, función `app.verify_audit_log_chain()` para CI/back office. Test: `packages/db/test/audit-db06-audit-log-hash-chain.test.ts` (3 casos, incluida detección de manipulación directa). |
| DB-07 | BAJA | Arquitectura / mantenibilidad de RLS | `apps/api/src/**` (8 usos de `app.db.transaction`, todos con `set local role app_role` escrito a mano) vs. `packages/db/src/context.ts` (`withTenantContext`/`applyTenantContext`, exportados pero con 0 usos en `apps/api`, confirmado por grep). Hoy no hay ninguna ruta que omita el `SET LOCAL ROLE` (verificado), pero el patrón está duplicado sin ningún lint/test que impida omitirlo en una ruta futura. | Migrar las 8 rutas a usar `withTenantContext`/`applyTenantContext` de `@atiende/db` en vez de repetir el SQL a mano; opcionalmente, un test estático que falle si aparece `app.db.transaction` sin pasar por el helper. | **PARCIAL (decisión de alcance documentada)** — commit `6c87e2e`. No se migraron los sitios existentes a `withTenantContext` (cambio grande de bajo riesgo real frente a los hallazgos ALTA/MEDIA, que tuvieron prioridad), pero SÍ se implementó la reparación "opcional" que la propia sugerencia proponía: `apps/api/test/audit-db07-tenant-context-pattern.test.ts`, prueba estática que falla si `app.db.transaction()` no fija `set local role app_role`. Esta prueba, ejecutada por primera vez, encontró y permitió corregir una instancia REAL de la vulnerabilidad (no solo hipotética) en `GET /company/profile/provenance`, escrita en esta misma ronda. |
| API-01 | **ALTA** | Autenticación (refresh tokens) | `apps/api/src/modules/auth/routes.ts` (handler `/refresh`). Confirmado: el mismo `refreshToken` se usó 3 veces seguidas y las 3 devolvieron 200 con tokens nuevos. Auto-declarado como pendiente en el README ("sin revocación de refresh tokens"). | Rotación de refresh tokens (invalidar el anterior al emitir uno nuevo, vía una tabla de `jti` usados o un `family_id` con detección de reuso) o, como mínimo, una lista de revocación consultada en cada `/refresh`. | **CERRADO** — commit `cdd22a1` (implementación, como parte del cierre de pendientes de ronda 1) + `ff4ec6d` (test que formaliza específicamente el escenario de esta auditoría). Tabla `refresh_tokens` (migración `0017`), rotación real en `/auth/refresh`, `/auth/logout`. Test: `apps/api/test/audit-api01-refresh-rotation.test.ts` (2 casos: reuso rechazado, logout revoca). |
| API-02 | **ALTA** | Autorización (escalada de rol) | `apps/api/src/modules/organizations/routes.ts:160-212` (`PATCH /organizations/memberships/:userId`). Confirmado dos veces: (a) un `admin` se autopromovió a `owner` con 200 OK; (b) un `admin`, sin escalación previa, degradó al único `owner` de la organización a `viewer`, dejándola sin ningún owner (verificado en `memberships` tras el PATCH: 0 filas con `role='owner'`). | Prohibir que un `admin` (no `owner`) asigne el rol `owner`; exigir que quede al menos un `owner` activo tras cualquier cambio de rol (verificable con un `CHECK`/trigger en `memberships` o una comprobación transaccional en la ruta antes del `UPDATE`). | **CERRADO** — commit `0ab4dfd`. La protección del último owner ya existía desde el cierre de pendientes de ronda 1 (verificada en el mismo test); se corrigió específicamente la autopromoción: solo un `owner` puede conceder el rol `owner`. Test: `apps/api/test/audit-api02-role-escalation.test.ts` (3 casos). |
| API-03 | MEDIA | Enumeración de usuarios | `apps/api/src/modules/auth/routes.ts:41-47` (`ConflictError` con mensaje explícito en `/register`). Confirmado: `POST /auth/register` con email ya registrado devuelve 409 y el mensaje "Ya existe una cuenta con ese email". | Devolver 201 (o 202) genérico también cuando el email ya existe, sin crear una cuenta duplicada, y notificar por otro canal (email) si aplica — patrón estándar anti-enumeración. | **CERRADO** — commit `d8e0ddc`. `/auth/register` responde 201 genérico también ante email duplicado, sin crear fila duplicada ni sobrescribir la cuenta real. Test: `apps/api/test/audit-api03-register-enumeration.test.ts` (2 casos) + actualización del test de ronda 1 que afirmaba el 409 anterior. |
| API-04 | BAJA | Validación de entrada | `apps/api/src/plugins/auth.plugin.ts:22-43` (`requireOrg`, sin validar formato de `X-Org-Id`). Confirmado: `X-Org-Id: not-a-uuid` produce 500 con el mensaje crudo de Postgres (`invalid input syntax for type uuid: ...`) fuera de producción; en producción el mensaje se enmascara correctamente (verificado), pero sigue siendo un 500 evitable. | Validar el formato UUID de `X-Org-Id` con zod antes de usarlo en la query, devolviendo 400/403 en vez de dejar que la base de datos lance la excepción. | **CERRADO** — commit `46b7fec`. Validación de formato UUID en `requireOrg` antes de tocar la base; nueva clase `BadRequestError` (400). Test: `apps/api/test/audit-api04-org-id-validation.test.ts`. |
| API-05 | MEDIA | Cabeceras de seguridad | `apps/api/src/app.ts` (sin `@fastify/helmet` ni configuración manual). Confirmado: `/healthz` no devuelve `X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy` ni `Strict-Transport-Security`. | Registrar `@fastify/helmet` con una configuración mínima razonable para una API JSON pura (sin necesidad de CSP compleja). | **CERRADO** — commit `cdd22a1` (registro de `@fastify/helmet`, como parte del cierre de pendientes de ronda 1) + `94ed83c` (test que lo verifica explícitamente). Test: `apps/api/test/audit-api05-security-headers.test.ts`. |
| API-06 | BAJA | Exposición de superficie de API | `apps/api/src/app.ts:50` (`/docs/json` sin `preHandler` ni gate por `NODE_ENV`). Confirmado: accesible sin `Authorization`, devuelve el esquema OpenAPI completo (7 rutas en esta ronda). | Gatear `/docs/json` (y cualquier futura UI de Swagger) detrás de `app.authenticate` + rol superadmin, o desactivarlo cuando `NODE_ENV=production`. | **CERRADO** — commit `94ed83c`. `GET /docs/json` exige `app.authenticate` (cualquier sesión válida; se optó por autenticación simple en vez de superadmin, por ser documentación técnica de la API, no datos de tenant/back office). Al escribir el test se descubrió y corrigió, en el mismo commit, un bug real independiente (falta `transform: jsonSchemaTransform` de `fastify-type-provider-zod`, causaba 500 en cualquier ruta con `params`/`querystring` vía zod). Test: `apps/api/test/audit-api06-docs-json-gate.test.ts`. |
| API-07 | BAJA | Invitaciones (diseño) | `apps/api/src/modules/organizations/routes.ts:110` (`tokenHash = createHash('sha256').update(randomUUID()).digest('hex')`). El token en claro se genera y se descarta en la misma línea; no se devuelve en la respuesta ni se envía por ningún canal. | Cuando se construya el endpoint de aceptar invitación (ya reconocido como pendiente), devolver o enviar el token en claro en el momento de crear la invitación — el valor actual de `token_hash` es, por diseño actual, irrecuperable. | **CERRADO** — commit `cdd22a1`. Implementado exactamente como sugiere la reparación: al construir `POST /organizations/invitations/accept`, `POST /organizations/invitations` ahora devuelve el token en claro una única vez en la respuesta. Test: `apps/api/test/auth-and-orgs-flow.test.ts`/flujo de invitación en `packages/db/test/ronda2-extensions.test.ts` (`app.accept_invitation`). |

---

## Anexo: scripts adversariales

Los tres scripts (`adversarial-rls.ts`, `adversarial-business.ts`,
`adversarial-api.ts` + `adversarial-api-2.ts`) se escribieron y ejecutaron
dentro del worktree de auditoría (`<scratch>/audit-dbapi`), nunca en el árbol
principal del repositorio, y **no se conservan** — el worktree fue eliminado
al cerrar esta auditoría. Su salida completa, íntegra, queda en
`docs/logs/audit-dbapi-ronda1.log`.
