# Auditoría adversarial — integración de `packages/mail` en `apps/api` (REQ-181..210)

Fecha: 2026-09-06. Agente: Sonnet, auditor adversarial independiente,
contexto separado del proyecto. Rol: **SOLO encuentra** — ningún código de
`apps/api`, `packages/db`, `packages/mail` ni `apps/worker` fue modificado
por este agente en el repo principal.

**Metodología**: `git worktree add <scratchpad>/api-mail-audit a492c87`
(HEAD real del repo principal al iniciar) + `npm install` real, fuera del
repo principal; el árbol principal nunca se tocó con comandos destructivos.
Se reprodujo de forma independiente la suite completa de `apps/api` (dos
veces), `packages/db` (dos veces) y `packages/mail` (dos veces, más
cobertura) en el worktree. Para verificar comportamiento real (no solo
lectura de código) se escribieron 6 scripts de prueba adversariales
temporales (`zz-audit-mail-*.test.ts`), ejecutados y **borrados** al
terminar — evidencia de comandos/salidas reales en
`docs/logs/audit-api-mail.log`.

**Objeto de esta ronda**: integración de `packages/mail` en `apps/api`
(commits `96a4248 fb0e0ca 76c988b c5705d1 c84f736 069a952 a0330b5 a492c87`):
`apps/api/src/lib/mail/**`, `modules/auth/routes.ts`, `modules/auth/mail.
routes.ts`, restablecimiento de contraseña, invitación a organización,
contacto público, baja/preferencias, webhook; migración
`packages/db/migrations/0086` (`app.enqueue_mail_retry`, SECURITY DEFINER).
Documentos base leídos: `apps/api/README.md` §"Correos transaccionales",
`docs/AMPLIACION-2-SALIDA.md`, `docs/REQUISITOS.md` REQ-181..210,
`docs/ACEPTACION.md` (no editado), rondas previas de auditoría
(`docs/auditoria-2/{mail,mail-reverificacion,api-google,api-ronda6}.md`).

**Nota de honestidad**: entre el inicio de esta auditoría y el cierre de
este informe, el árbol principal avanzó por trabajo **concurrente de otros
agentes** ajeno a esta ronda (p. ej. un handler nuevo de
`apps/worker/src/handlers/mail-retry.ts`, sin commitear al momento de
escribir esto). Esta auditoría se mantuvo deliberadamente fija en `a492c87`
— el último commit de la lista pedida — y no audita ese trabajo en curso.

---

## Resumen ejecutivo

Reproducibilidad excelente: 3 paquetes, 2 corridas cada uno, 100% idéntico
(apps/api 74/74·350/350, packages/db 27/27·205/205, packages/mail
26/26·252/252; cobertura de `packages/mail` 96.26%/85.17%/97.89%/96.26%).
Tokens, hash en base, un-solo-uso, comparación constante y anti-abuso de
contacto son sólidos y ya están probados en vivo. Se confirmaron **en vivo,
con scripts adversariales propios**, seis hallazgos nuevos no cubiertos por
la suite existente: (AM-01, ALTA) vincular una cuenta de Google a un correo
email+contraseña **no verificado** nunca marca la cuenta como verificada ni
toca la contraseña preexistente, dejando una vía de toma de cuenta si la
verificación nativa se completa después por cualquier motivo; (AM-02, ALTA)
`/auth/password/forgot` y `/auth/email/resend-verification` reabren el
oráculo de temporización que API-03 ya había cerrado para `/auth/login`
(8.34x y 5.83x de mediana, muy por encima del umbral de 1.5x del propio
proyecto); (AM-03, ALTA) el webhook suprime **cualquier** dirección de un
payload con firma válida sin verificar que el `email_id` corresponda a un
envío real nuestro, incluyendo el correo de seguridad de una cuenta real;
(AM-04, MEDIA) `app.enqueue_mail_retry` no valida `org_id` contra la sesión
que la invoca; (AM-05, MEDIA) `correlation_id` nunca se propaga en la
familia `auth.*`/correo; (AM-06, BAJA) `docs/ACEPTACION.md` sigue marcando
S4-S12 como "Sin código/PENDIENTE" pese a tener código y pruebas en verde.

---

## 1. Reproducibilidad

**Comprobado correcto.** Ver `docs/logs/audit-api-mail.log` §1 para
comandos/salidas completos: `apps/api` (typecheck/lint limpios,
74/74·350/350 idéntico en 2 corridas), `packages/db` (27/27·205/205 x2),
`packages/mail` (26/26·252/252 x2, cobertura 96.26% líneas/96.26%
sentencias/85.17% ramas/97.89% funciones — los módulos de seguridad
(`signed-link.ts`, `verify-signature.ts`, `apply-event.ts`,
`replay-guard.ts`) están todos por encima de 92%, la mayoría en 100%).
`apps/api` no tiene script `test:coverage` propio pero soporta `--coverage`
por CLI; ejecutado sobre los 8 archivos de prueba de correo/Google:
`lib/mail` 83.33% sentencias / 87.65% ramas, `modules/mail` 98.58%.

Sin hallazgos en este rubro.

---

## 2. Tokens (verificación, reset, invitación, unsubscribe)

**Comprobado correcto** (evidencia en vivo, suite existente, ver log §2):

- **Un solo uso**: `app.consume_email_verification_token` y
  `app.reset_password_with_token` (migración 0084) hacen
  `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now() RETURNING`
  — atómico bajo concurrencia. Confirmado por tests: "el mismo enlace NO se
  puede usar dos veces", "es de UN SOLO USO" (reset), y por
  `app.accept_invitation` (0017) con `SELECT ... FOR UPDATE` + `status =
  'pending'` como condición.
- **Expiración**: `expires_at > now()` en la condición del `UPDATE`, y la
  firma HMAC del enlace lleva su propio `exp` (independiente, capa de
  defensa adicional) — confirmado por "enlace VENCIDO (firmado
  correctamente) -> 400 y la cuenta sigue sin verificar".
- **Hash en BD, nunca texto plano**: `token_hash = sha256(token)` en las
  tres tablas de token (`email_verification_tokens`, `password_reset_
  tokens`, `invitations.token_hash`); confirmado por "el token vive
  HASHEADO en la base" y "el token en claro NO se persiste".
- **Imposible reutilizar tras cambio de contraseña**: el mismo
  `reset_password_with_token` que cambia la contraseña también revoca
  TODAS las sesiones (`app.revoke_all_refresh_tokens`) en una sola
  transacción — confirmado por "la contraseña vieja deja de servir y TODA
  sesión previa queda revocada".
- **Token de otra cuenta**: "el token de una cuenta NO verifica la otra" y
  "el enlace de una cuenta no cambia la contraseña de OTRA" — ambos verdes.
- **Token manipulado byte a byte**: "enlace con la firma o el payload
  manipulados -> 400" altera los 2 últimos caracteres base64url de la
  firma y, por separado, reescribe el payload conservando la firma
  original — ambos casos rechazados con el mismo mensaje genérico.
- **Timing de comparación constante**: `packages/mail/src/security/
  signed-link.ts` compara con `timingSafeEqual` (longitud igual verificada
  antes, como exige la API de Node) tanto el enlace firmado como cada
  candidato de `svix-signature` del webhook (varias firmas separadas por
  espacio, para rotación de secreto).

Sin hallazgos nuevos en este rubro (los hallazgos de temporización
relevantes están en el rubro 3, no en la comparación de firma en sí).

---

## 3. Enumeración

**Comprobado correcto** (cuerpo/estructura/cabeceras): `/auth/email/
resend-verification` y `/auth/password/forgot` responden el **mismo**
`{ok:true}` (202) exista o no la cuenta — sin campo variable, por lo que
`Content-Length` también es idéntico; `/auth/register` ya cerraba esto
desde la auditoría original (API-03) devolviendo `{id, email}` con
longitudes deterministas en ambos casos. Confirmado por "ANTI-ENUMERACIÓN:
la respuesta es idéntica byte a byte exista o no la cuenta" y "reenvío:
responde 202 IDÉNTICO exista o no la cuenta".

### AM-02 (ALTA) — `/auth/password/forgot` y `/auth/email/resend-verification` son un oráculo de TIEMPO de existencia de cuenta

**Hallazgo**: aunque el cuerpo de la respuesta es idéntico, ambos
endpoints ejecutan trabajo síncrono real (generar `randomBytes(32)`,
`randomUUID()`, `sha256`, abrir una transacción para insertar el token, y
disparar en segundo plano el render de la plantilla + el `INSERT` del
outbox) **solo cuando la cuenta existe** — la misma clase de oráculo que
API-03 ya había cerrado para `/auth/login` (que antes medía 24x y hoy mide
1.00x, ver `security-api03-login-timing.test.ts`), pero que **nunca se
aplicó a estas dos rutas**.

Medido en vivo, con la misma metodología que el propio test de API-03
(app aislada por lote de 5 peticiones — el límite real de la ruta —,
medianas de 25/15 muestras por lado):

```
$ npx vitest run test/zz-audit-mail-forgot-timing.test.ts
AUDIT forgot-password timing: mediana existente=6.093ms, mediana inexistente=0.731ms, ratio=8.34x

$ npx vitest run test/zz-audit-mail-resend-timing.test.ts
AUDIT resend-verification timing: mediana existente=7.846ms, mediana inexistente=1.345ms, ratio=5.83x
```

Ambos ratios superan largamente el umbral de 1.5x que el propio proyecto
usa como criterio de aceptación para declarar cerrado este tipo de oráculo.
Un atacante remoto, sin necesitar ninguna contraseña, puede enumerar
cuentas registradas midiendo la latencia de `POST /auth/password/forgot`
(o `/auth/email/resend-verification`) — exactamente el ataque que API-03
ya reconoció como real y grave para `/auth/login`.

**Severidad**: ALTA — mismo patrón de vulnerabilidad que el propio proyecto
ya clasificó como digno de arreglo dedicado (API-03), en dos rutas
adicionales, con una magnitud (5.8x-8.3x) claramente por encima de ruido de
CI.

**Reparación (no aplicada por este agente)**: aplicar el mismo criterio de
API-03 — ejecutar SIEMPRE el mismo trabajo síncrono/asíncrono (generar el
token ficticio, intentar el mismo render+outbox con un destino descartado,
o mover TODO el trabajo, incluida la consulta `findUserForMail`, a una
tarea de fondo con una latencia de respuesta fija) independientemente de si
la cuenta existe.

---

## 4. Rate limit del tier `auth` y anti-abuso de contacto

**Comprobado correcto**, confirmado en vivo dentro de la suite verde:

- Las 4 rutas anónimas de correo (`/auth/email/verify`,
  `/auth/email/resend-verification`, `/auth/password/forgot`,
  `/auth/password/reset`) y `POST /public/contact` usan el tier `auth`
  (5/min, el más estricto). Confirmado por "el reenvío está acotado por el
  tier `auth` (5/min): el 6º intento del minuto es 429" (verificación de
  correo y password reset) y "ANTI-ABUSO límite de tasa: el 6º envío del
  minuto desde la misma IP es 429" (contacto).
- `RATE_LIMIT_PROFILE=e2e` relaja el tier `auth` a 300/min, pero **solo
  con esa variable explícita**; el default de `config.ts` es `'default'`
  (confirmado: `rateLimitProfile: env.RATE_LIMIT_PROFILE === 'e2e' ?
  'e2e' : 'default'`) — no hay forma de que un despliegue normal quede en
  modo relajado por accidente.
- Honeypot (`website`): campo opcional que un formulario legítimo nunca
  llena; si llega con contenido, la petición se descarta EN SILENCIO (mismo
  202, sin registro ni correo) — confirmado por "un campo `website` lleno
  se descarta EN SILENCIO".
- Longitudes acotadas: nombre (2-120), email (≤254), mensaje (10-4000),
  honeypot (≤200) — confirmado por "mensaje demasiado corto, demasiado
  largo o nombre vacío -> 422 sin registro".
- El honeypot se evalúa DESPUÉS del rate limit (el plugin de Fastify
  intercepta antes del handler), así que un flood que dispara el honeypot
  igual consume el presupuesto de 5/min — no es una forma de esquivar el
  límite de tasa.

Sin hallazgos nuevos en este rubro.

---

## 5. Compuerta de login sin verificar; Google/refresh/step-up; revocación de sesiones tras reset

**Comprobado correcto** (por revisión de código + tests existentes):

- `requireEmailVerification` es `true` por defecto (`env.
  REQUIRE_EMAIL_VERIFICATION !== 'false'`) — opt-out explícito, nunca al
  revés.
- La compuerta se evalúa DESPUÉS de `verifyPassword` — no es oráculo de
  existencia de cuenta.
- Por construcción del código, **no hay ruta de bypass vía refresh o
  step-up**: `POST /auth/register` nunca llama `issueTokenPair` (una
  cuenta recién creada, sin verificar, jamás recibe un refresh/access
  token), y tanto `/auth/refresh` como `/auth/2fa/step-up` operan sobre un
  token ya emitido — inalcanzables para una cuenta que nunca tuvo uno.
- Una cuenta creada exclusivamente vía Google (`password_hash IS NULL`)
  nunca pasa por `/auth/login` (`isUsable` siempre `false`) — no hay
  "salto" porque nunca usa esa puerta.
- Opt-out confirmado en vivo: "la compuerta es CONFIGURABLE: con
  requireEmailVerification=false el login sin verificar entra".
- Revocación de sesiones tras reset confirmada en vivo: "la contraseña
  vieja deja de servir y TODA sesión previa queda revocada" —
  `app.reset_password_with_token` llama `app.revoke_all_refresh_tokens`
  dentro de la MISMA función SECURITY DEFINER (0084).

### AM-01 (ALTA, límite con CRÍTICA) — vincular Google a una cuenta email+contraseña no verificada no revisa ni corrige el estado de esa cuenta, habilitando una toma de cuenta por "squatting" de correo

**Hallazgo**: `docs/REQUISITOS.md` describe REQ-173 como "vinculación
automática... con el email **verificado** de un usuario ya registrado", y
REQ-180 exige explícitamente una "prueba adversarial: intento de
vinculación con email de una cuenta ajena **en estado inconsistente** es
rechazado y auditado". La implementación real
(`apps/api/src/modules/auth/google/routes.ts`, rama `byEmail`) vincula la
identidad de Google a CUALQUIER cuenta existente con ese email cuyo
`is_active` sea verdadero, sin mirar en ningún momento
`users.email_verified_at` ni el hecho de que esa cuenta ya tenga un
`password_hash` puesto por quien la haya registrado. La única verificación
de "conflicto" que existe (REQ-180) es sobre un `subject` de Google
DISTINTO ya vinculado — nunca sobre el estado de verificación nativo de la
cuenta.

Esto abre la variante clásica de "squatting" de cuenta por correo:

1. Un atacante que conoce el correo de la víctima ejecuta
   `POST /auth/register` con ese email y una contraseña de su elección. La
   cuenta queda creada, `email_verified_at = NULL`; el login con esa
   contraseña está bloqueado por la compuerta (correcto, verificado).
2. La víctima real, dueña del correo, usa "Continuar con Google" (REQ-172,
   colocado junto al login normal) — Google prueba que controla ese
   correo. El sistema encuentra la cuenta squatteada por email y la
   **vincula automáticamente** (REQ-173), auditando `auth.google_linked`.
   Ni `email_verified_at` ni `password_hash` se tocan.
3. En cualquier momento posterior — el correo de verificación del registro
   original sigue vivo 30 minutos en la bandeja REAL de la víctima, o
   basta con que alguien llame `POST /auth/email/resend-verification` con
   ese email (ruta totalmente anónima) y la víctima, ya confiando en la
   cuenta por usar Google, haga clic — se consume un token real de
   verificación de correo y `email_verified_at` deja de ser `NULL`.
4. A partir de ese instante, `POST /auth/login` con la contraseña
   **original del atacante** (nunca invalidada ni rotada) autentica con
   éxito — toma de cuenta completa, incluyendo cualquier organización a la
   que la víctima ya se haya unido vía Google.

Confirmado en vivo con un script adversarial temporal reproduciendo los 4
pasos exactos con el proveedor OIDC falso del proyecto — ver
`docs/logs/audit-api-mail.log` §5 para el comando y la salida real
(`login del ATACANTE tras la verificación nativa disparada por la víctima
= 200`).

**Severidad**: ALTA (rozando CRÍTICA) — resulta en toma de cuenta completa
y contradice el texto explícito de REQ-173/REQ-180, que la propia auditoría
de Google (`docs/auditoria-2/api-google.md`) nunca ejerció con este
escenario exacto (su test S2 usa `registerAndLogin`, que marca
`email_verified_at = now()` DIRECTAMENTE en la base antes de vincular,
enmascarando el caso). No se marca CRÍTICA pura porque requiere que la
verificación nativa se complete después (no está 100% bajo control del
atacante, aunque sí es plausible: el correo de verificación original ya
sale disparado en el registro y sigue vivo 30 minutos, y el reenvío es
anónimo y no requiere ninguna prueba adicional).

**Reparación (no aplicada por este agente)**: al vincular por email
(REQ-173), si la cuenta existente tiene `password_hash IS NOT NULL` y
`email_verified_at IS NULL`, tratarla como el "estado inconsistente" que
REQ-180 pide detectar — como mínimo, invalidar/rotar el `password_hash`
preexistente (o forzar un flujo de "establece tu contraseña" post-
vinculación) y marcar `email_verified_at = now()` en el mismo acto que la
vinculación (Google ya probó la propiedad del correo, con más fuerza que
el flujo nativo); idealmente, auditar este caso específico de forma
distinguible de una vinculación "limpia".

---

## 6. Outbox/retry (0086 SECURITY DEFINER) y deduplicación

**Comprobado correcto**: RLS real de `jobs` rechaza un INSERT directo sin
organización ni sesión (el problema real que 0086 resuelve); `app.
enqueue_mail_retry` siempre inserta con `kind = 'mail_retry'` (no es
parámetro, no se puede inyectar otro valor); deduplicación confirmada bajo
concurrencia real (`Promise.all` de 10 llamadas a `mail_outbox_reserve`
con la misma `dedupe_key` → exactamente 1 gana); un fallo permanente (4xx)
no reintenta ni encola job.

### AM-04 (MEDIA) — `app.enqueue_mail_retry` no valida que `org_id` pertenezca a la sesión que la invoca, y el payload solo exige la clave `messageKey`

**Hallazgo**: la función (migración 0086) es SECURITY DEFINER — su razón
de ser es bordear la RLS normal de `jobs` (`ins_jobs`, 0028) para poder
insertar un job sin organización activa. Confirmado en vivo, invocándola
directamente con un contexto de sesión fijado a la organización A pero
pidiendo encolar el job para la organización B (ajena): la función lo
permite sin queja, insertando la fila con `org_id = B`. La única
validación de forma sobre el payload es "¿tiene la clave `messageKey`?" —
cualquier otro contenido (incluido un destinatario `to.email` arbitrario)
se acepta e inserta tal cual.

**No es explotable hoy**: el único invocador real
(`apps/api/src/lib/mail/send-transactional.ts`) siempre pasa un `orgId`
que la capa de aplicación ya validó (el de la invitación creada, obtenido
de `request.orgId` vía `app.requireOrg`) o `null` (correos sin
organización). Pero es un hueco de defensa en profundidad: la función
existe PARA bordear la RLS, así que es exactamente el punto donde debería
haber una comprobación explícita — cualquier futuro caller (o un bug en
`send-transactional.ts`) podría escribir jobs en la cola de otra
organización sin que la base de datos lo impida.

**Severidad**: MEDIA (hallazgo de código, confirmado en vivo, pero sin
ruta de explotación real hoy).

**Reparación (no aplicada)**: en `app.enqueue_mail_retry`, exigir
`p_org_id IS NULL OR p_org_id = app.current_org_id()` (fallando con una
excepción explícita si no coincide) cuando haya un contexto de organización
fijado; y validar la forma mínima esperada del payload (`templateId`,
`to`, `variables` presentes) en vez de solo `messageKey`.

---

## 7. Webhook Svix — firma, timestamp, replay, evento de otro entorno/proveedor, supresión de terceros

**Comprobado correcto**, confirmado en vivo dentro de la suite verde
(`mail-webhook.test.ts`): firma forjada con otro secreto → 401 sin efecto;
cuerpo alterado después de firmar → 401 sin efecto; cabeceras Svix
ausentes o timestamp fuera de la ventana de 300s → 401; reenvío exacto de
una petición ya procesada (mismo `svix-id`) → 409 sin reaplicar el efecto,
mientras que un `svix-id` NUEVO con el mismo cuerpo sí se procesa (el
guardia deduplica por id, no censura la dirección para siempre); sin
secreto configurado → 503, nunca procesa (falla cerrado); un `provider` no
reconocido en la ruta → 422 por esquema (lista cerrada, cierra el vector de
"proveedor/entorno" ajeno a nivel de ruta).

### AM-03 (ALTA) — el webhook suprime cualquier dirección de un payload con firma válida, sin verificar que corresponda a un envío real nuestro; puede silenciar correo de SEGURIDAD de un usuario real

**Hallazgo**: `packages/mail/src/webhooks/apply-event.ts`
(`applyMailWebhookEvent`) suprime la dirección de CUALQUIER evento
`email.bounced`/`email.complained` con firma válida, sin cruzar el
`email_id` (`providerMessageId`, ya extraído por `parse-resend-payload.ts`
pero nunca usado) contra ningún envío real en `mail_outbox`. Esto ya lo
demuestra el propio test existente y verde del proyecto
(`mail-webhook.test.ts`, caso "una queja de spam suprime con motivo
`complaint`"): la dirección `queja@example.com` nunca recibió ningún correo
en ese test, y aun así queda suprimida con éxito.

Se confirmó en vivo, con un script adversarial temporal, el impacto real
contra una cuenta EXISTENTE: se registra un usuario real; se fabrica un
`email_id` que nunca existió en `mail_outbox`; se manda un webhook
`email.bounced` con firma VÁLIDA (el secreto real de la app — el ataque no
depende de falsificar la firma, solo de que el payload no corresponda a un
envío nuestro) referenciando ese `email_id` inventado y el correo de la
víctima → se suprime (202, fila en `mail_suppressions`). Acto seguido, se
solicita un restablecimiento de contraseña real para esa cuenta → la
respuesta HTTP sigue siendo 202 (anti-enumeración intacta, correctamente),
pero **ninguna fila aparece en `mail_outbox`**: el correo de seguridad se
descartó en silencio. Ver `docs/logs/audit-api-mail.log` §7 para el comando
y la salida real.

Vector de explotación plausible: cualquiera con acceso al panel de Resend
(que permite reenviar/probar eventos de webhook con payload arbitrario) o
con el secreto de webhook filtrado puede suprimir permanentemente el
correo de **cualquier** dirección — incluida la de un usuario real de la
plataforma — sin haber tenido que enviarle nunca nada. Esto contradice
directamente el criterio de esta ronda ("un rebote de un correo que no
enviamos nunca debe suprimir a un tercero") y compromete la garantía de
REQ-187 ("las transaccionales críticas de seguridad se envían siempre")
por una vía distinta a las preferencias del propio usuario.

**Severidad**: ALTA — silencia correo de seguridad (restablecimiento de
contraseña, verificación, invitaciones) de una cuenta real, de forma
invisible para el usuario y el operador, sin requerir haber comprometido
nada del lado de la aplicación.

**Reparación (no aplicada)**: antes de suprimir, verificar que
`event.providerMessageId` corresponda a una fila real en `mail_outbox`
(`provider_message_id = event.providerMessageId`) — o, como mínimo, que
`event.email` coincida con el `to_email` de esa fila — y descartar/loguear
(sin efecto de negocio) cualquier evento que no pase esa comprobación.

---

## 8. Red — sin proveedor configurado, cero bytes salen; secretos fuera de logs/respuestas

**Comprobado correcto**, confirmado en vivo con sabotaje REAL de `fetch`
global (exactamente lo que pedía esta ronda), dentro de la suite verde
(`mail-provider-and-retry.test.ts`):

- "S12: sin MAIL_PROVIDER el proveedor activo es la BANDEJA DE CAPTURA —
  0 llamadas de red": `globalThis.fetch` se reemplaza por una función que
  lanza si se invoca; el envío completa `status: 'sent'` vía
  `CaptureProvider` y `llamadasDeRed === 0`.
- "S12: con MAIL_PROVIDER=resend pero SIN credenciales -> not_configured,
  0 red...": mismo sabotaje, con el proveedor real seleccionado pero sin
  `RESEND_API_KEY` — confirmado por lectura de `resend-provider.ts` que el
  chequeo `if (!apiKey || !domain)` ocurre ANTES del `try { fetchImpl(...) }`,
  y confirmado en vivo que 0 llamadas de red ocurren.

Revisión dirigida de logs (`app.log.*` en todo `lib/mail/**`,
`modules/mail/**`, `modules/auth/mail.routes.ts`): ninguna línea imprime
el token en claro, la firma del enlace, el secreto del webhook ni la
contraseña — solo `err.message`, motivo de rechazo del webhook (enum
cerrado) y metadatos no sensibles (`userId`, `correo`/nombre del flujo).

Sin hallazgos nuevos en este rubro.

---

## 9. Preferencias — transaccionales de seguridad siempre se envían

**Comprobado correcto**: `packages/mail/src/preferences/filter.ts#
isCategoryEnabled` retorna `true` sin consultar preferencias cuando la
categoría es obligatoria (`isMandatoryCategory`) — confirmado en vivo por
"la preferencia SE APLICA al enviar: un correo opcional apagado no se
manda, uno obligatorio sí".

**Matiz** (cruce con el rubro 7): la supresión por rebote/queja es
DELIBERADAMENTE más fuerte que las preferencias y bloquea incluso
plantillas obligatorias — esto es correcto por diseño (un canal roto es un
canal roto), pero es precisamente el mecanismo que AM-03 permite activar
para una dirección que no rebotó realmente. En la práctica, la garantía
"la seguridad siempre llega" depende hoy también de que AM-03 se corrija.

Sin hallazgos nuevos que no estén ya cubiertos por AM-03.

---

## 10. RLS/cross-org — invitaciones y contactos

**Comprobado correcto**: `invitations` está incluida en `DOMAIN_TABLES`
(`packages/db/test/helpers.ts`), la lista genérica que
`rls-isolation.test.ts` ejercita para SELECT/UPDATE/DELETE cross-org sobre
TODAS las tablas de dominio (70 pruebas, dentro de las 205/205 verdes de
`packages/db`) — un owner de la organización A no ve, no puede modificar ni
puede borrar una invitación de la organización B. `contact_requests`
(0083) no es una tabla por organización (buzón de plataforma) y está
correctamente restringida a superadmin: confirmado en vivo por "cualquiera
(sin sesión) puede insertar; solo superadmin puede listar" — un usuario
normal obtiene 0 filas.

Sin hallazgos en este rubro.

---

## 11. `audit_log` y `correlation_id` por evento

### AM-05 (MEDIA) — `correlation_id` nunca se propaga para la familia `auth.*` (incluye las 4 acciones de correo en alcance de esta ronda)

**Hallazgo**: `apps/api/src/lib/audit.ts#AuthAuditEntry`/`recordAuthAudit`
— usada por TODOS los eventos `auth.*`, incluidos los cuatro directamente
relevantes a esta ronda (`auth.email_verification_sent`, `auth.
email_verified`, `auth.password_reset_requested`, `auth.
password_reset_completed`), además de login/refresh/logout/Google — no
tiene ningún campo `correlationId`. Llama a `app.record_auth_event($1, $2,
$3, $4)` con solo 4 parámetros; la función SQL correspondiente
(`packages/db/migrations/0084`) tampoco acepta `p_correlation_id` ni lo
escribe en el `INSERT`. Por contraste, `SecurityAuditEntry`/
`recordSecurityAudit` (2FA, migración 0057) sí tiene `correlationId` y lo
propaga a `app.record_security_event`, y el `recordAudit` genérico (usado
por `invitation.create`, por ejemplo) también lo propaga a `audit_log.
correlation_id` (columna añadida en 0056, REQ-171).

Confirmado en vivo con un script adversarial temporal: se registra una
cuenta y se solicita un restablecimiento de contraseña, ambos con
`X-Correlation-Id` válido en la cabecera; la fila resultante en
`audit_log` para `auth.password_reset_requested` tiene
`correlation_id = NULL`. Ver `docs/logs/audit-api-mail.log` §11.

Además (por lectura de código, sin script adicional): el envío INICIAL de
verificación en `POST /auth/register` nunca se registra como `auth.
email_verification_sent` — esa acción de auditoría solo la escribe `POST
/auth/email/resend-verification`. El primer intento de verificación de una
cuenta nueva no deja rastro propio en `audit_log`.

**Severidad**: MEDIA — no es un bypass de seguridad, pero rompe
directamente la trazabilidad de REQ-171 exactamente para los flujos que
esta ronda audita, e introduce una inconsistencia con el resto del
proyecto (2FA, invitaciones) que ya sí lo hace.

**Reparación (no aplicada)**: añadir `p_correlation_id` a
`app.record_auth_event` (siguiendo el patrón ya usado en
`app.record_security_event`) y `correlationId` a `AuthAuditEntry`/
`recordAuthAudit`, propagando `request.correlationId` desde cada llamador
en `modules/auth/routes.ts` y `modules/auth/mail.routes.ts`; y auditar
también el envío inicial de verificación en `POST /auth/register`.

---

## 12. Trazabilidad — S5/S6/S7/S10/S12 y REQ-181..210 (`docs/ACEPTACION.md`, no editado)

`docs/ACEPTACION.md` no fue modificado por este agente; esta sección solo
reporta el desfase encontrado entre su contenido y el estado real del
código/las pruebas.

### AM-06 (BAJA, gobierno/documentación) — `docs/ACEPTACION.md` sigue marcando S4-S12 y REQ-181..210 como "Sin código/PENDIENTE"

**Hallazgo**: las filas S4 a S12 (y las correspondientes REQ-181 a REQ-210)
de `docs/ACEPTACION.md` siguen literalmente en el estado "Sin código" /
"PENDIENTE" que tenían antes de que existiera `packages/mail` — a pesar de
que, para S5, S6, S7, S10 y S12 específicamente, el código y las pruebas
existen y pasan en verde (ver mapeo abajo). Dado que REQ-210 exige
explícitamente "un informe de auditoría y reverificación independiente...
antes de cerrar cualquier REQ-172 a REQ-209", y esta es precisamente esa
auditoría, el desfase documental debería resolverse como parte del cierre
de esta ronda (por otro agente — no por este, que no edita
`docs/ACEPTACION.md`).

**Severidad**: BAJA — no es un defecto de código, es un desfase de
gobierno/documentación que podría llevar a una futura auditoría a
sobrestimar cuánto falta, o a un cierre de REQ-210 basado en una tabla que
no refleja el trabajo ya hecho.

### Mapeo real (evidencia citada en las secciones 1-11 de este informe)

| Escenario / REQ | Estado real (esta ronda) | Evidencia |
|---|---|---|
| S5 (REQ-186, invitación con enlace firmado que expira) | **Implementado y probado** | `mail-organization-invite.test.ts` (6 tests, todos verdes); AM-01 es un hallazgo NUEVO sobre un flujo distinto (Google), no invalida S5 |
| S6 (REQ-187, baja de un clic salvo seguridad) | **Implementado y probado**, con matiz | `mail-unsubscribe-preferences.test.ts` (8 tests verdes); el mecanismo de preferencias es correcto, pero AM-03 (webhook) puede anular la garantía de seguridad por una vía distinta |
| S7 (REQ-188, reintento vía job con historial) | **Parcialmente implementado** | Creación del job + estado del outbox confirmados en vivo (`mail-provider-and-retry.test.ts`, `req181-mail.test.ts`); AM-04 es un hallazgo de defensa en profundidad sobre la función que lo crea. El REQ-188 completo ("se reintentan mediante jobs con backoff") requiere que algo CONSUMA `kind='mail_retry'` — al HEAD auditado (`a492c87`), `apps/worker` todavía no lo hace (declarado explícitamente en el README de esa ronda); el ciclo de reintento real nunca se ejerció de punta a punta |
| S10 (REQ-196, contacto público) | **Implementado y probado** | `mail-public-contact.test.ts` (4 tests verdes) |
| S12 (REQ-190, sin proveedor no sale nada a la red) | **Implementado y probado, confirmado con sabotaje de `fetch`** | `mail-provider-and-retry.test.ts` (2 tests verdes, ver rubro 8) |
| REQ-181 (catálogo de 10 plantillas) | Catálogo existe y renderiza (84 tests en `packages/mail/test/templates/catalog.test.ts`), pero de los 10 tipos solo 5 los dispara `apps/api` en este alcance (verificación, invitación, reset, 2FA, contacto); el resto (avisos de convocatoria, matching, plazos, resumen) están listos en `packages/mail` pero los dispararía `apps/worker`, fuera de esta ronda | `apps/api/README.md` §"Pendiente de este bloque" |
| REQ-182 (adaptador único, sin `if provider === X` fuera de él) | Confirmado por lectura: `factory.ts` es el único punto con el `switch` | — |
| REQ-183/REQ-190 (captura/sin red) | **Confirmado en vivo** | rubro 8 |
| REQ-186 (enlaces firmados con expiración) | **Confirmado en vivo** | rubro 2 |
| REQ-187 (preferencias + seguridad siempre) | Confirmado en el mecanismo; en riesgo por AM-03 | rubros 7 y 9 |
| REQ-188 (outbox + reintentos) | Parcial (ver S7 arriba) | rubro 6 |
| REQ-189 (nunca a destinatario no registrado) | **Confirmado en vivo** | `mail-provider-and-retry.test.ts`, "REQ-189: nunca se manda a un destinatario que el llamador no declaró registrado" + `assertRegisteredRecipient` |
| REQ-184/REQ-185 (previsualización, tono/marca) | Fuera del alcance de `apps/api` (viven en `packages/mail/scripts/preview.ts` y en el contenido de las plantillas) — no auditados en esta ronda centrada en la integración de `apps/api` | — |
| REQ-191..209 (onboarding, landing, infra, E2E web) | Fuera del alcance de esta ronda (no son integración de correo en `apps/api`) | — |
| REQ-210 (auditoría/reverificación antes de CUMPLIDO) | Esta ronda es esa auditoría para los REQ de correo; el desfase de `docs/ACEPTACION.md` (AM-06) debería resolverse antes de marcar cualquiera de estos REQ como CUMPLIDO | — |

---

## Índice de hallazgos

| Id | Severidad | Rubro | Resumen |
|---|---|---|---|
| AM-01 | ALTA (límite CRÍTICA) | 5 | Vincular Google a una cuenta email+contraseña no verificada no revisa el estado ni la contraseña preexistente → toma de cuenta si la verificación nativa se completa después |
| AM-02 | ALTA | 3 | `/auth/password/forgot` y `/auth/email/resend-verification` reabren el oráculo de temporización que API-03 cerró para `/auth/login` (8.34x / 5.83x) |
| AM-03 | ALTA | 7/9 | El webhook suprime cualquier dirección de un payload con firma válida sin verificar que corresponda a un envío nuestro real → puede silenciar correo de seguridad de un usuario real |
| AM-04 | MEDIA | 6 | `app.enqueue_mail_retry` no valida `org_id` contra la sesión invocadora; payload sin validación de forma más allá de `messageKey` |
| AM-05 | MEDIA | 11 | `correlation_id` nunca se propaga en la familia `auth.*`/correo; el envío inicial de verificación no se audita como acción propia |
| AM-06 | BAJA | 12 | `docs/ACEPTACION.md` sigue marcando S4-S12/REQ-181..210 como "Sin código/PENDIENTE" pese a tener código y pruebas en verde |

Ningún código de producción fue modificado por este agente. Los 6 scripts
de prueba adversariales temporales usados para confirmar AM-01 a AM-05 en
vivo fueron borrados del worktree antes de cerrar esta auditoría.
