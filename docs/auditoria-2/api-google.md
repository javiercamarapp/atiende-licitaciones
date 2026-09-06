# Auditoría adversarial — Login con Google (OIDC), REQ-172..180

Fecha: 2026-09-06. Agente: auditor adversarial independiente, contexto
separado del proyecto ("Atiende Licitaciones"). Rol: **SOLO encuentra** —
ningún código de `apps/api`, `packages/db`, `apps/web` ni `apps/worker` fue
modificado por este agente.

**Metodología**: `git worktree add <scratchpad>/audit-google HEAD` (HEAD
real al iniciar: `1969ff9`) + `npm install` real; el repo principal nunca
se tocó con comandos destructivos (no se usó `git reset`/`checkout
<commit>`/`stash`/`rebase`/`add -A`). Se reprodujo de forma independiente
la suite completa de `apps/api` y `packages/db` en el worktree, y además
se escribieron y ejecutaron pruebas adversariales temporales
(`zzz-audit-google-*.test.ts`) contra el proveedor OIDC falso real
(`apps/api/test/helpers/fake-oidc.ts`, servidor HTTP local con JWKS/
discovery/token endpoint reales, firma RS256) para ejercer ataques
concretos, no solo lectura de código — **borradas** todas al terminar
(nunca se commitearon). Evidencia de comandos/salidas reales en
`docs/logs/audit-api-google.log`.

Documentos base leídos: `apps/api/src/modules/auth/google/**` (8 archivos),
`apps/api/test/helpers/fake-oidc.ts`, `apps/api/test/google-oidc-login.test.ts`,
`packages/db/migrations/0071_req172_google_oidc.sql` y
`0072_req177_google_auth_audit.sql`, `packages/db/test/req172-google-oidc.test.ts`,
`packages/db/test/security-definer-audit.test.ts`, `apps/api/README.md`
(sección `auth/google`), `docs/REQUISITOS.md` §34.1 (REQ-172..180),
`docs/AMPLIACION-2-SALIDA.md` §1, `docs/ACEPTACION.md` (S1-S3, REQ-172..180),
`docs/investigacion/salida-promocion-referencias.md` §1 (Google), `apps/web/src`
(búsqueda del botón "Continuar con Google").

---

## Resumen ejecutivo

El backend (`apps/api`) del login con Google está **sólidamente
construido y probado**: PKCE S256 real, `state` firmado con clave
derivada del `JWT_SECRET`, `nonce` verificado, consumo atómico de un solo
uso de `oauth_states` (anti-CSRF/anti-replay), verificación del `id_token`
contra el JWKS real del proveedor vía `jose` (`aud`/`iss`/`exp` reales,
nunca `alg=none`), rechazo explícito de `email_verified=false`, conflicto
de vinculación (REQ-180) bloqueado, 2FA respetado con un `pendingToken` de
vida corta que nunca autoriza nada por sí mismo, y las 4 funciones
`SECURITY DEFINER` nuevas están en la lista blanca con el mismo candado
anti-forjado (`app.current_user_id() = p_user_id`) que ya usa el resto del
código base — **se intentó romper ese candado activamente y resistió**
(GO-06, "comprobado correcto"). Se ejecutaron 8 ataques concretos contra
el proveedor OIDC falso real (PKCE con `code_challenge` ajeno, `state`
firmado con otra clave, `id_token` expirado, firmado por una clave RSA no
publicada en el JWKS, `alg=none`, `iss` de otro proveedor, `aud` ajeno,
normalización de email) y los 8 fueron rechazados correctamente.
`packages/db` reproduce **185/185 exacto** contra el número citado en el
despacho.

Se encontraron dos hallazgos que merecen atención real, ninguno crítico:

- **GO-01 (MODERADA, gobernanza/documentación)**: REQ-174 y
  `docs/AMPLIACION-2-SALIDA.md` exigen literalmente que un login de Google
  con email nuevo cree "usuario **y su primera organización**
  automáticamente". La implementación real, deliberada y transparente
  (documentada en el propio código y en `apps/api/README.md`), hace
  exactamente lo contrario: nunca crea una organización automática (patrón
  `SIN_ROL`/`sin_acceso`, citando explícitamente la lección de Likida en
  `docs/investigacion/salida-promocion-referencias.md`). Es la decisión de
  seguridad correcta, pero **nadie actualizó el texto de REQ-174 ni
  `docs/ACEPTACION.md`, ni existe una entrada en `docs/DECISIONES.md`** que
  formalice la desviación consciente del requisito tal como está escrito.
- **GO-07 (MODERADA, robustez/concurrencia, hallazgo por revisión de
  código, no disparado en vivo)**: a diferencia del registro por
  email+contraseña (que captura explícitamente `23505`/`unique_violation`
  para no exponer un 500), el flujo de Google **no captura** esa misma
  condición al crear un usuario nuevo o al insertar `user_identities` —
  dos logins de Google concurrentes para el mismo email/subject nuevo
  terminarían en un 500 sin manejar en vez de una respuesta limpia.

El resto de la superficie auditada (rubros 2-5 completos) se comprobó
**correcta**, con evidencia en vivo contra el proveedor OIDC falso real en
la mayoría de los casos. `docs/logs/audit-api-google.log` tiene el detalle
de comandos y salidas.

---

## Rubro 1 — Reproducibilidad

**`packages/db`**: typecheck y lint limpios. `npx vitest run` →
**26 archivos / 185 tests, 185 verdes** — coincide EXACTO con el número
citado en el despacho. Incluye la idempotencia de 0071/0072 (`migrate.test.ts`:
"aplican todas sin error" + "se pueden aplicar dos veces sin error
(idempotente)"), y ambos archivos SQL en revisión manual usan solo DDL
idempotente (`create table if not exists`, `create or replace function`,
`drop policy if exists`).

**`apps/api`**: typecheck y lint limpios. `npx vitest run` → **66 archivos
/ 274 tests, 1 fallo** (no 278/278 como cita el despacho). El único fallo
real es `test/expediente-documents-and-matrix.test.ts` ("sube un PDF real
con texto... pdf-parse"), **reproducible de forma determinista** en este
worktree (no un flake aislado como lo describió el log previo,
`docs/logs/api-google.log` de la ronda anterior) — **fuera de alcance**
de esta auditoría (no toca `modules/auth/google/**`; coincide con trabajo
en curso, sin commitear, sobre extracción de PDF visible en el repo
principal al momento de esta auditoría). El suite de Google en aislamiento
(`google-oidc-login.test.ts`) es **11/11 verde y reproducible**. La
diferencia entre 274 y 278 (4 tests) no quedó explicada con certeza dentro
del presupuesto de esta ronda — `git diff`/`git log` de `apps/api/test`
entre el commit que originó el número 278 y HEAD no muestra cambios, así
que no es por archivos de prueba distintos; se deja como nota de contexto,
no como hallazgo de Google (ver GO-08).

**Veredicto**: reproducible en todo lo relacionado con Google OIDC.

---

## Rubro 1b — Funciones `SECURITY DEFINER` nuevas (0071) — intento de ruptura

Las 4 funciones nuevas (`app.create_oauth_state`, `app.consume_oauth_state`,
`app.find_identity_by_subject`, `app.accept_pending_invitations_for_user`)
están en la lista blanca de `packages/db/test/security-definer-audit.test.ts`
con justificación específica. La única que acepta un `user_id` externo es
`app.accept_pending_invitations_for_user` — superficie obvia para "aceptar
las invitaciones de otro usuario".

**Intento de ruptura activo** (no solo lectura):
1. El candado (`app.current_user_id() = p_user_id`, si no lanza
   `accept_pending_invitations_actor_mismatch`) ya tiene un test directo en
   `packages/db/test/req172-google-oidc.test.ts` (atacante ≠ víctima → lanza;
   sin sesión fijada → también lanza). Ejecutado y confirmado.
2. Único punto de invocación real en todo `apps/api`
   (`modules/auth/google/routes.ts`, rama "usuario nuevo"): se llama DENTRO
   de la misma transacción que ya fijó `app.current_user_id` al `userId`
   recién generado por `randomUUID()` e insertado dos líneas antes — nunca
   a un id de entrada del cliente. No existe ninguna otra ruta (grep
   exhaustivo) que la invoque con otro `p_user_id`.
3. Intento de condición de carrera (dos "usuarios nuevos" concurrentes para
   el mismo email invitado): no rompe el candado de esta función en sí
   (cada transacción opera con su propio `userId` legítimo, correctamente
   fijado) — pero expone un problema DISTINTO de integridad (ver GO-07).

**Veredicto: el candado RESISTE.** Comprobado correcto.

---

## Rubro 2 — Ataques OIDC contra el proveedor falso (8/8 rechazados)

Se escribió y ejecutó un archivo de pruebas adversariales temporal contra
`apps/api/test/helpers/fake-oidc.ts` (servidor HTTP real, JWKS/discovery/
token endpoint reales, RS256), borrado al terminar. Resultado de cada
ataque:

| # | Ataque | Resultado observado |
|---|---|---|
| 1 | PKCE: `code` de autorización asociado a un `code_challenge` que NO corresponde al `code_verifier` real guardado server-side en `oauth_states` | `401`, 0 cuentas creadas |
| 2 | `state` firmado con una clave derivada de un `JWT_SECRET` distinto (mismo formato, firma ajena) | `400` |
| 3 | `id_token` ya expirado (`exp` en el pasado, vía `expiresInSeconds: -60` del proveedor falso) | `401`, 0 cuentas creadas |
| 4 | `id_token` firmado con una clave RSA propia del atacante, NUNCA publicada en el JWKS del proveedor | `verifyGoogleIdToken` rechaza (excepción) |
| 5 | `id_token` con `alg: none` y sin firma | `verifyGoogleIdToken` rechaza (excepción) |
| 6 | `id_token` con `iss` de OTRO proveedor OIDC (otro servidor falso completo, propio JWKS) verificado contra el `issuer`/JWKS del proveedor configurado | `verifyGoogleIdToken` rechaza (excepción) |
| 7 | `state`/`nonce` reutilizado (doble callback) — ya cubierto por la suite oficial | `400` en el segundo intento (test oficial, reconfirmado) |
| 8 | Email con normalización de mayúsculas (`Normaliza@Example.com` contra cuenta existente `normaliza@example.com`) | Vincula correctamente, **1 sola cuenta**, sin duplicar |

Además, ya cubierto por la suite oficial (`google-oidc-login.test.ts`) y
reconfirmado en esta ronda sin cambios: `aud` ajeno → 401; `sub` de otro
usuario ya vinculado a una cuenta existente por email (REQ-180) → 403,
sin duplicar identidad; email no verificado → 403, 0 cuentas.

**Puntos sin poder ejercer en vivo (limitación declarada, no oculta)**:
- `iat` futuro: `jose`/`jwtVerify` no lo usa para rechazar por sí solo
  (solo lo usa si se pasa `maxTokenAge`, que `id-token.ts` no configura) —
  esto es estándar de la librería, no un bug de este código; no se
  encontró forma de forjar, sin la clave privada real del proveedor falso,
  un token con `iat` futuro firmado válidamente para confirmar el
  comportamiento exacto extremo a extremo. No se eleva a hallazgo porque
  `exp` (que sí se valida siempre) sigue acotando la ventana de uso del
  token igualmente.
- Open redirect en `returnTo`: **no aplica** — se confirmó por grep
  exhaustivo que este flujo NO tiene ningún parámetro `returnTo`/similar en
  ningún punto (`/start` no lo acepta, `/callback` solo usa `code`/`state`/
  `error`); el `redirect_uri` real nunca viaja como entrada del cliente en
  el callback, se lee de la fila de `oauth_states` fijada en `/start` con el
  valor de configuración del servidor. Sin superficie de ataque de open
  redirect en absoluto.
- Discovery que apunta a un issuer no-`https`: `env.ts` no valida el
  esquema de `OIDC_ISSUER_URL` (solo el valor por defecto,
  `https://accounts.google.com`, es forzosamente https). No es explotable
  por un atacante remoto vía request — requiere que un operador fije mal la
  variable de entorno del proceso — pero es una validación de forma
  barata de añadir. Ver **GO-03** (severidad baja).

**Veredicto rubro 2: comprobado correcto en 8/8 ataques activos + toda la
cobertura ya existente en la suite oficial.**

---

## Rubro 3 — Flujos

- **Usuario nuevo sin invitación → `sin_acceso` sin org**: confirmado (test
  oficial + lectura de código). Ninguna organización se crea jamás de forma
  automática. Ver **GO-01** sobre la desalineación con el texto de REQ-174.
- **Usuario nuevo con invitación pendiente → acepta solo la suya**: confirmado.
  `app.accept_pending_invitations_for_user` deriva el email SIEMPRE de
  `users.email` del propio `p_user_id` ya verificado (nunca de un email de
  entrada), y solo opera sobre invitaciones `pending`/no expiradas de ESE
  email exacto (`lower(email) = v_email`). Test oficial con dos
  organizaciones + una invitación expirada confirma que solo se aceptan las
  vigentes.
- **Usuario existente con contraseña → vincula y no borra `password_hash`**:
  confirmado por lectura exhaustiva de `resolveGoogleIdentity` — ningún
  `UPDATE` toca `users.password_hash` en la rama de vinculación (solo
  `INSERT INTO user_identities`); el test oficial S2 no lo verifica
  explícitamente pero el propio código no tiene ninguna sentencia SQL que
  pudiera tocar esa columna en esa ruta.
- **Usuario existente sin cuenta previa (email nuevo) pero con invitación
  pendiente de un email DISTINTO al vinculado más tarde por contraseña**:
  N/A, no aplica a este flujo.
- **Invitación pendiente de un usuario que YA tiene cuenta por
  contraseña**: la rama de vinculación (branch 2, `byEmail`) **NO** llama a
  `accept_pending_invitations_for_user` — solo la rama "usuario nuevo" lo
  hace. Esto está **documentado con total transparencia** en
  `apps/api/README.md` ("las invitaciones pendientes de ese email para
  vincular a una cuenta YA existente se aceptan por el flujo normal de
  `POST /organizations/invitations/accept`, no por este"). No es un
  hallazgo oculto — comprobado correcto / decisión documentada.
- **Usuario con 2FA → `pendingToken`**: confirmado — JWT de 5 minutos
  (`PENDING_2FA_TTL_SECONDS = 5 * 60`), firmado con clave derivada propia
  (dominio separado de access/refresh tokens y del `state`), `typ:
  'google_pending_2fa'` verificado explícitamente, **nunca autoriza ningún
  endpoint autenticado** (no es un access token real). ¿Reutilizable? Sí,
  puede presentarse más de una vez dentro de su TTL — pero cada intento
  sigue exigiendo un código TOTP fresco no repetido (`last_used_time_step`)
  o un código de respaldo no usado (`used_at is null`); el `pendingToken`
  por sí solo NUNCA es suficiente para completar la sesión. No es un bypass
  — mismo criterio que "conocer tu propio usuario no es autenticarte".
  Ligado exclusivamente al `userId` verificado por Google (vía `sub` del
  JWT), nunca a un valor de entrada del cliente en `verify-2fa`.
- **`verify-2fa` con TOTP replay**: confirmado bloqueado —
  `last_used_time_step` compara `verification.timeStep <= lastUsed` (mismo
  guardia que el resto del código de 2FA); reutilizar el mismo código en la
  misma ventana de 30s es rechazado explícitamente ("Código TOTP inválido,
  o ya fue utilizado (replay rechazado)").
- **Rate limit del tier `auth`**: confirmado en vivo — con perfil `default`
  (5/min), la 6ª petición a `GET /auth/google/start` en menos de un minuto
  responde `429` (`statuses: [200,200,200,200,200,429]`), igual que el
  resto de endpoints del tier `auth`.
- **`audit_log` de cada evento con ip/ua sin tokens**: confirmado por
  lectura de `recordAuthAudit`/`issueTokenPair`/`resolveGoogleIdentity` —
  el campo `after` de cada evento (`auth.google_login`, `auth.google_linked`,
  `auth.google_rejected`) contiene únicamente `{ ip, userAgent, ...datos de
  negocio no sensibles (provider/isNewUser/linked/acceptedInvitations/reason) }`;
  ningún camino de código inserta `accessToken`/`refreshToken`/`idToken`/
  `code`/`code_verifier` en `audit_log`.

**Veredicto rubro 3: comprobado correcto**, salvo el hallazgo de
gobernanza ya señalado (GO-01, no es un defecto de comportamiento sino de
consistencia documental) y la condición de carrera de robustez (GO-07).

---

## Rubro 4 — Sesión

- **Refresh/rotación idéntica a login normal (REQ-175)**: confirmado por
  lectura de código — `modules/auth/google/routes.ts` reutiliza
  literalmente `issueTokenPair` de `modules/auth/routes.ts` (mismo `access`/
  `refresh` con el mismo esquema, mismo `create_refresh_token`/rotación,
  mismo `REFRESH_TTL_DAYS`) tanto para el login exitoso directo (línea 401)
  como para el login exitoso tras 2FA (línea 487).
- **Logout invalida**: confirmado — `POST /auth/logout` es un endpoint
  único y no específico de proveedor (`modules/auth/routes.ts`), revoca el
  refresh token por `jti` vía `app.revoke_refresh_token` sin importar si la
  sesión se originó por email+contraseña o por Google.
- **Cuenta Google desvinculada por el usuario**: **NO EXISTE tal endpoint**
  — confirmado por grep exhaustivo (`unlink`/`disconnect`/`desvincul`) en
  `apps/api/src/modules` y `apps/web/src`, cero resultados relacionados con
  Google. No es necesariamente un defecto: `docs/REQUISITOS.md` §34.1
  (REQ-172..180) no exige explícitamente tal endpoint. Se deja constancia
  porque el rubro de auditoría lo pide explícitamente (**GO-09**,
  informativa). Nota de diseño para si se construye en el futuro: una
  cuenta creada EXCLUSIVAMENTE por Google tiene `password_hash = null` —
  desvincular esa identidad sin antes exigir establecer una contraseña (o
  sin bloquear la desvinculación mientras sea el único método de acceso)
  dejaría la cuenta sin ninguna forma de iniciar sesión.

**Veredicto rubro 4: comprobado correcto** lo que existe; ausencia de
funcionalidad de desvinculación anotada como GO-09 (informativa).

---

## Rubro 5 — Configuración

- **Sin `GOOGLE_CLIENT_ID` → 503/404 honesto, no 500**: confirmado en vivo
  con dos pruebas ad-hoc:
  - `GET /auth/google/start` sin ninguna credencial configurada → `503`
    exacto, cuerpo `{"type":".../google-oidc-not-configured", "title":
    "Login con Google no configurado: faltan
    GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI...", "status":503}`
    — sin fugar ningún secreto (el mensaje solo nombra las variables
    faltantes, nunca un valor).
  - Caso más exigente: `GET /auth/google/start` CON credenciales (obtiene
    un `state` válido) y luego se retira `GOOGLE_CLIENT_ID` del proceso
    justo antes de golpear `GET /auth/google/callback` con ese `state` —
    confirma que el 503 se dispara de verdad en el propio handler del
    callback (después de validar `state`, antes de tocar la red), no solo
    en `/start`: **`503` exacto**, mismo cuerpo honesto.
- **Secretos nunca en logs ni respuestas**: confirmado — `env.ts` es el
  único punto que lee `GOOGLE_CLIENT_SECRET`; nunca se interpola en
  mensajes de error, nunca se pasa a `recordAuthAudit`. El error handler
  global (`plugins/error-handler.ts`) sanitiza cualquier error no
  controlado en producción (`"Error interno del servidor"`, sin el mensaje
  real) — relevante también para GO-07.
- **README y BLOQUEADO_EXTERNO coherentes**: confirmado — la sección
  `auth/google` de `apps/api/README.md` describe con precisión el
  comportamiento real, incluyendo explícitamente "nunca se crea una
  organización automáticamente" (coincide con el código, ver GO-01 sobre
  el propio REQ-174) y la lista de "pendientes honestos" (2FA no exigido en
  `/auth/login` normal, invitaciones de cuentas ya existentes por el flujo
  normal, sin passkey/WebAuthn). `docs/ACEPTACION.md` mantiene REQ-172
  como `PENDIENTE`/"Sin código" — **coherente y honesto**: el botón
  "Continuar con Google" **no existe en `apps/web`** (grep exhaustivo de
  `apps/web/src/pages/LoginPage.tsx` y de cualquier página de registro: sin
  referencia a `/auth/google` ni texto "Continuar con Google"). Se anota
  como **GO-02 (informativa/contexto)**: el backend de Google está
  completo y bien probado, pero la función no es utilizable end-to-end por
  un usuario real hasta que `apps/web` incorpore el botón — relevante para
  quien cierre REQ-210 sobre el bloque 172-180.
- **`OIDC_ISSUER_URL` sin validar esquema https**: ver GO-03 (severidad
  baja, no explotable por request, solo por configuración de operador).

**Veredicto rubro 5: comprobado correcto**, con GO-02 y GO-03 como
hallazgos informativos/bajos, no de comportamiento erróneo.

---

## Rubro 6 — Regresión

- `apps/web`: `npm run typecheck` (`tsc -b --noEmit`) → limpio, sin salida.
- `apps/worker`: `npm run typecheck` (`tsc --noEmit`) → limpio, sin salida.

**Veredicto: sin regresión.**

---

## Hallazgos (GO-nn)

### GO-01 — MODERADA (gobernanza/documentación) — REQ-174 no coincide con el texto de REQUISITOS.md/ACEPTACION.md

**Rubro**: 3 (flujos) / gobernanza transversal (REQ-210).

**Evidencia**:
- `docs/REQUISITOS.md:361` (REQ-174): *"Login con Google de un email nunca
  antes registrado crea usuario y su primera organización
  automáticamente, igual que el registro por email+contraseña"* — criterio
  de aceptación citado: *"usuario nuevo + login con Google → usuario y
  organización creados en una sola operación"*.
- `docs/AMPLIACION-2-SALIDA.md:6`: *"creación de usuario + primera
  organización"*.
- `docs/ACEPTACION.md:235,279` (REQ-174, S1): mismo texto, ambos aún
  `PENDIENTE`.
- Implementación real (`apps/api/src/modules/auth/google/routes.ts:191-217`,
  comentario explícito líneas 210-217): un usuario nuevo **nunca** crea una
  organización automática; si no hay invitación pendiente, la respuesta es
  `status: "sin_acceso"` (test oficial: *"usuario nuevo sin invitación
  pendiente: compuerta sin_acceso (sin organización automática)"*).
- Justificación citada en el propio código y en `apps/api/README.md`:
  `docs/investigacion/salida-promocion-referencias.md` (líneas 85-101),
  que documenta el patrón `SIN_ROL`/`/sin-acceso` de un producto de
  referencia (Likida) precisamente para EVITAR que "cualquiera con cuenta
  de Google" obtenga acceso de negocio sin una fila de organización/rol
  real — un riesgo de seguridad legítimo si se implementara literalmente
  REQ-174 sin guardarraíles.

**Por qué es un hallazgo real**: la decisión de NO autocrear una
organización es, con alta probabilidad, la opción más segura y está
documentada con total transparencia en el código y en el README — **no se
oculta**. El problema es de **gobernanza**: nadie actualizó el texto de
REQ-174 en `docs/REQUISITOS.md`, ni el criterio de aceptación en
`docs/ACEPTACION.md` (REQ-174/S1), ni existe una entrada en
`docs/DECISIONES.md` que registre esta desviación consciente del
requisito tal como fue escrito. REQ-210 exige que este bloque pase por el
ciclo de auditoría/reverificación "antes de marcarse CUMPLIDO" — tal como
está hoy, quien intente verificar REQ-174 contra su texto literal
encontrará que **ningún test del proyecto prueba lo que REQ-174 dice
literalmente** (crear una organización automática); los tests reales
prueban justo el comportamiento contrario.

**Reparación** (NO aplicada por este agente — solo hallazgo): registrar
una decisión explícita en `docs/DECISIONES.md` que reconcilie REQ-174 y
`docs/ACEPTACION.md` (REQ-174/S1) con el patrón `SIN_ROL`/`sin_acceso`
realmente implementado — ya sea reescribiendo el texto de REQ-174 para
reflejar la compuerta, o documentando por qué se decidió divergir
deliberadamente del requisito original de Ampliación 2.

---

### GO-02 — INFORMATIVA (alcance/contexto) — REQ-172 (botón en `apps/web`) no implementado

**Rubro**: 5 (configuración) / contexto transversal.

El backend de Google (`apps/api`) está completo y bien probado, pero
**no existe ningún botón "Continuar con Google" en `apps/web`**
(`apps/web/src/pages/LoginPage.tsx` no referencia `/auth/google` ni el
texto del botón; no hay página de registro dedicada). Esto **coincide**
con `docs/ACEPTACION.md` (REQ-172 sigue `PENDIENTE`, "Sin código") — no es
un hallazgo de ocultamiento, solo una nota de alcance: la función de login
con Google **no es utilizable end-to-end por un usuario real** todavía.
Relevante para quien cierre REQ-210 sobre el bloque 172-180: el bloque
completo no puede marcarse `CUMPLIDO` con REQ-172 pendiente.

**Reparación**: ninguna — pendiente honesta ya reconocida por el propio
proyecto, no requiere una decisión nueva, solo no perder de vista que
sigue faltando.

---

### GO-03 — BAJA (hardening) — `OIDC_ISSUER_URL` no valida esquema `https`

**Rubro**: 2 (ataques OIDC) / 5 (configuración).

**Evidencia**: `apps/api/src/modules/auth/google/env.ts:47-48` —
`issuerUrlRaw = env.OIDC_ISSUER_URL?.trim() || 'https://accounts.google.com'`
sin ninguna validación de esquema sobre un valor explícito. Solo el
default es forzosamente `https`.

**Impacto**: bajo — no es explotable por un atacante remoto vía ningún
parámetro de request (esta variable la fija exclusivamente el operador del
proceso, nunca el cliente). Si se fijara mal en un entorno real (`http://`),
discovery/JWKS/token endpoint viajarían en claro.

**Reparación** (no aplicada): validar en `loadGoogleOidcEnv` que
`issuerUrl` use esquema `https://`, salvo quizás una excepción explícita
para hosts de loopback (`127.0.0.1`/`localhost`) usados por el propio
`fake-oidc.ts` en pruebas.

---

### GO-07 — MODERADA (robustez/concurrencia, hallazgo por revisión de código) — `23505`/unique_violation sin capturar en la creación de identidad/usuario de Google

**Rubro**: 1b / 3 (flujos).

**Evidencia**:
- `apps/api/src/modules/auth/routes.ts:130` (registro por
  email+contraseña) captura EXPLÍCITAMENTE `pgErr.code === UNIQUE_VIOLATION`
  ('23505') para responder el mismo 201 genérico sin crear una fila
  duplicada (API-03, anti-enumeración) — patrón ya establecido y probado en
  el propio código base para esta EXACTA clase de condición de carrera.
- `apps/api/src/modules/auth/google/routes.ts:194-198` (`insert into
  users...`, cuenta nueva) y líneas 177-182 (`insert into
  user_identities...`, vinculación) **no tienen ningún `try/catch`
  alrededor**, a pesar de que AMBAS tablas tienen restricciones únicas que
  una carrera real puede violar: `ux_users_email_lower` (0002) y
  `user_identities (provider, subject)` / `(provider, user_id)` (0071).
- Escenario concreto: dos peticiones casi simultáneas de login con Google
  para el MISMO email nunca antes registrado (doble clic, dos pestañas, o
  un intento deliberado de forzar la carrera) — ambas transacciones
  ejecutan `app.find_user_by_email`/`app.find_identity_by_subject` y ven
  "no existe" ANTES de que ninguna de las dos haga commit; la segunda en
  llegar al `INSERT` recibe una violación de restricción única de
  Postgres, no capturada, que se propaga como una excepción genérica fuera
  de `resolveGoogleIdentity` — el `catch` de `handleCallback` solo
  distingue `GoogleRejectionError` de "cualquier otra cosa" (`throw err`),
  así que termina en el manejador de errores genérico → `500`.

**Impacto real**: no es una vulnerabilidad de autorización — nadie obtiene
acceso indebido, ninguna sesión ajena se emite. Es un defecto de robustez:
una experiencia degradada (500 en vez de una respuesta limpia con sesión)
ante una carrera que es plausible en el mundo real (doble clic del botón,
que además ni siquiera existe aún en `apps/web` — ver GO-02 — pero
`apps/api` debe sostenerse igual sin depender de que el frontend lo
prevenga). El error handler global sanitiza el mensaje en producción (no
hay fuga de secretos), pero en desarrollo/staging el mensaje crudo de
Postgres sí se refleja en la respuesta.

**No se pudo disparar la carrera de forma determinística en el entorno de
pruebas** (una sola conexión lógica de PGlite por test) — el hallazgo se
sostiene por inspección de código y por el contraste directo con el mismo
tipo de condición ya resuelto explícitamente en el flujo hermano
(email+contraseña).

**Reparación** (no aplicada): envolver ambos `INSERT` en un `try/catch`
que detecte `23505` y, en ese caso, releer la fila ganadora
(`find_user_by_email`/`find_identity_by_subject`) y continuar el flujo
normal de vinculación/login en vez de propagar el error crudo — mismo
patrón que ya usa `modules/auth/routes.ts`.

---

### GO-08 — INFORMATIVA (contexto, no es un hallazgo de Google) — discrepancia de conteo total de tests de `apps/api` (274 vs 278)

Ver Rubro 1. El único fallo real (`expediente-documents-and-matrix.test.ts`)
está fuera del alcance de Google OIDC; la diferencia de 4 tests entre el
274 observado y el 278 citado en el despacho no se explica por cambios en
`apps/api/test` (confirmado con `git diff`/`git log` vacíos para ese path
entre el commit origen del número y HEAD) y no se investigó más a fondo
por no ser código de `modules/auth/google/**`.

---

### GO-09 — INFORMATIVA — no existe endpoint de desvinculación de la cuenta de Google

Ver Rubro 4. No es un defecto (no lo exige ningún REQ-172..180 vigente),
se deja constancia porque el rubro de auditoría lo solicitó explícitamente,
con una nota de diseño para cuando se construya: una cuenta creada
EXCLUSIVAMENTE por Google (`password_hash = null`) no debería poder
desvincularse sin antes garantizar otro método de acceso.

---

## Comprobado correcto (sin hallazgo)

- PKCE S256 real (verificado con `code_challenge` ajeno → 401).
- `state` firmado con clave derivada del `JWT_SECRET`, separación de
  dominio real respecto a access/refresh tokens (verificado: firma con
  otra clave → 400).
- `nonce` verificado a mano contra `oauth_states`, un solo uso atómico
  (consumo vía `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now()
  RETURNING`) — replay de `state`/`nonce` → 400 en el segundo intento.
- `id_token` expirado → 401 (verificado con el proveedor falso).
- `id_token` firmado con clave ajena no publicada en el JWKS → rechazado.
- `alg=none` → rechazado.
- `iss` de otro proveedor completo → rechazado.
- `aud` ajeno → 401, 0 cuentas creadas.
- `email_verified=false` → 403, 0 cuentas creadas, 0 vinculaciones.
- Normalización de email por mayúsculas → vincula correctamente sin
  duplicar (Google ya normaliza puntos de Gmail antes de emitir el claim,
  no es responsabilidad de esta app replicarlo).
- Conflicto de `sub` distinto para un email ya vinculado (REQ-180) → 403,
  sin sobrescribir el vínculo existente, auditado.
- Candado anti-forjado de `app.accept_pending_invitations_for_user`
  (intento activo de ruptura, resistió).
- `pendingToken` de 2FA: 5 minutos, dominio separado, nunca autoriza nada
  por sí mismo, requiere TOTP/backup fresco en cada uso.
- Replay de TOTP en `verify-2fa` → rechazado (`last_used_time_step`).
- Rate limit del tier `auth` (5/min) aplicado a `/start`/`/callback`/
  `/verify-2fa` → confirmado en vivo (6ª petición → 429).
- `audit_log` de cada evento (`google_login`/`google_linked`/`google_rejected`)
  con ip/user-agent/motivo, nunca tokens ni secretos.
- Sesión/refresh emitidos por Google usan literalmente `issueTokenPair`,
  el mismo camino que el login por contraseña (REQ-175).
- Logout invalida sesiones de Google igual que las de contraseña (mismo
  endpoint, no distingue proveedor).
- Sin `GOOGLE_CLIENT_ID`/`SECRET`/`REDIRECT_URI` → 503 explícito y honesto
  en `/start` Y en `/callback` (probado retirando las credenciales DESPUÉS
  de obtener un `state` válido), nunca 500, nunca fuga de secretos.
- README (`apps/api/README.md`) coherente con el código real, incluyendo
  sus propias limitaciones documentadas ("pendientes honestos").
- Vinculación de cuenta existente por contraseña nunca toca
  `password_hash` (revisión exhaustiva: ningún `UPDATE` sobre esa columna
  en la ruta de vinculación).
- Invitaciones pendientes: solo se aceptan las del email exacto (case-
  insensitive vía `lower()`), pendientes y no expiradas; ninguna invitación
  ajena se toca.
- Open redirect en `returnTo`: no aplica, el parámetro no existe en este
  flujo.
- `apps/web`/`apps/worker` typecheck limpios (sin regresión).
- `packages/db` reproduce 185/185 exacto; migraciones 0071/0072 idempotentes.

---

## Nota final

Este informe **no modifica ningún código**. Los hallazgos GO-01, GO-03 y
GO-07 requieren decisión y reparación separadas por el equipo/agente de
implementación correspondiente; GO-02, GO-08 y GO-09 son notas de contexto
sin acción obligatoria inmediata. Comandos y salidas completas en
`docs/logs/audit-api-google.log`.
