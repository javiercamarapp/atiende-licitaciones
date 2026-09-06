# Auditoría adversarial — `packages/mail` (Ampliación 2, §34.2)

Auditor independiente (Sonnet, contexto separado del que implementó el paquete). Trabajo realizado
en un `git worktree` aislado (`git worktree add <scratchpad>/audit-mail HEAD`, commit `f9dd6bd`),
`npm install` local, sin tocar el repo principal. Rol: SOLO ENCONTRAR — no se corrigió código.

Fuentes leídas: `packages/mail/README.md`, `docs/logs/mail-ronda6.log`, `docs/REQUISITOS.md` §34.2
(REQ-181 a REQ-190), `docs/ACEPTACION.md` (S1-S12, filas REQ-181..REQ-210),
`docs/investigacion/salida-promocion-referencias.md` (§2, §6.3 — plantillas Likida/Restaurantes),
`docs/investigacion/frontend-restaurantes.md` (§2.1-2.2 — tokens de marca), y el código fuente
completo de `packages/mail/src` y `packages/mail/test` (24 archivos de prueba, ~30 archivos fuente).

## Resumen de veredicto por rubro

| # | Rubro | Veredicto |
|---|---|---|
| 1 | Reproducibilidad | CUMPLE — reproducido de punta a punta en worktree limpio |
| 2 | Plantillas | CUMPLE CON HALLAZGOS (ML-03, ML-04) |
| 3 | Enlaces firmados | CUMPLE CON HALLAZGO MENOR (ML-05 relacionado) |
| 4 | Servicio | HALLAZGO ALTO (ML-01 — idempotencia bajo concurrencia) |
| 5 | Adaptadores | CUMPLE CON HALLAZGO (ML-06 — replay de webhook) |
| 6 | Seguridad | HALLAZGO ALTO (ML-02 — List-Unsubscribe ausente) + ML-07 (deps dev) |
| 7 | Trazabilidad | HALLAZGO (ML-08 — ACEPTACION.md desactualizado / alcance real de S4-S7,S12) |

---

## 1. Reproducibilidad

**Comprobado correcto** (ejecutado por el auditor en el worktree aislado, no solo leído del log):

- `npm install` en el worktree instala sin errores (818 paquetes; solo warnings de deprecación de
  sub-paquetes `@react-email/*`, no bloqueantes).
- `npm run -w packages/mail typecheck` → sin errores.
- `npm run -w packages/mail lint` → sin errores.
- `npm run -w packages/mail test` → **24 archivos / 220 pruebas, todas en verde** (reproducido dos
  veces, 1.45-1.90 s).
- `npm run -w packages/mail test:coverage` → mismos 220 tests en verde; cobertura global
  **96.48% stmts / 83.65% ramas / 96.47% funciones / 96.48% líneas** (por encima de los umbrales
  declarados en `vitest.config.ts`: ≥85/80/85/85). Ramas más bajas puntuales pero no bloqueantes:
  `post-award-alert.tsx` 33.33%, `tender-match-digest.tsx` 25%, `retry.ts` 50% (líneas no cubiertas
  son ramas condicionales secundarias del render, no lógica de negocio crítica sin probar).
- `npm run -w packages/mail build` (`tsc -p tsconfig.build.json`) → sin errores.
- `npm run -w packages/mail preview` → genera las 16 plantillas + `index.html` con datos de
  ejemplo, reproducible byte-a-byte en el HTML relevante (timestamps de captura difieren, contenido
  no).
- Capturas de pantalla generadas con Playwright (Chromium) de 5 plantillas
  (`email-verification`, `new-tender-match`, `deadline-reminder`, `weekly-summary`,
  `backup-codes-generated`) en desktop (680px) y móvil (viewport 375px) →
  `docs/auditoria-2/capturas-mail/*.png` (10 archivos). Verificado visualmente: layout limpio, sin
  desbordes visibles, wordmark de marca visible, pie con motivo/preferencias/baja presentes según
  corresponda a cada plantilla.

**Nota de reproducibilidad (no defecto):** las capturas "móvil" (viewport lógico 375px) resultan en
imágenes de 632px de ancho porque la tabla del correo tiene ancho fijo (600px, técnica estándar de
correo documentada en el propio código) y Playwright, a diferencia de un cliente de correo real
(Gmail/Apple Mail, que reescalan el cuerpo HTML de un correo a la pantalla), no reescala. No se
verificó el renderizado en un cliente de correo real (Gmail/Outlook/Apple Mail) — eso queda fuera
del alcance de esta ronda (no hay integración con Litmus/Email on Acid en el repo).

---

## 2. Plantillas (16)

**Comprobado correcto:**

- Las 16 plantillas renderizan sin error con `sampleData` (verificado con `preview` + suite
  `catalog.test.ts`, 84 pruebas: asunto/HTML/texto no vacíos, esquema válido contra su propio
  `sampleData`, wordmark + pie con motivo presentes, CTA con `href` http(s) no vacío, HTML válido
  para correo vía `html-validate` con reglas de correo documentadas y justificadas una por una en
  `test/support/html-validate-config.ts`).
- **0 menciones a "Likida"** en ninguno de los 16 HTML generados (`grep -il likida preview/*.html`
  → vacío) — verificado directamente por el auditor, no solo inferido del código.
- **0 elementos `<svg>`** en ningún HTML generado (`grep -l "<svg" preview/*.html` → vacío),
  consistente con la razón documentada (Gmail descarta `<svg>` de un correo).
- Tamaño de cada HTML generado: 7-12 KB — muy por debajo del límite de recorte de Gmail (~102 KB).
- **Inyección de HTML en variables**: probado adversarialmente por el auditor (no solo leído) — se
  renderizó `organization-invite` con `organizationName: '<script>alert(1)</script> Empresa
  Maliciosa'`; el HTML resultante contiene `&lt;script&gt;alert(1)&lt;/script&gt;` (escapado por
  JSX/React Email), **nunca** `<script>alert(1)</script>` sin escapar. Correcto.
- **Variables faltantes/inválidas**: `template.schema.safeParse()` rechaza antes de renderizar
  (`MailService.send()` → `status: "invalid_variables"` con los `issues` de zod); no hay ruta que
  produzca un render con huecos vacíos. Verificado en código y en `mail-service.test.ts`.
- Texto plano equivalente: `renderEmailParts()` genera `text` con `render(el, {plainText:true})` —
  nunca se redacta a mano, no puede desincronizarse del HTML.
- Alt text presente en el único `<img>` real (`alt="atiende"` cuando hay `logoCid`).
- Contraste WCAG AA verificado para `ink`/`body`/botón blanco-sobre-marca (`test/theme/contrast.test.ts`,
  fórmula de luminancia relativa correcta, re-derivada por el auditor).
- Enlaces absolutos: `BaseVariablesSchema` exige `appUrl`/`tenderUrl`/etc. como `z.string().url()`
  (URL absoluta), y `safeUrl()` cae a un fallback absoluto si no lo es.
- Español de México correcto en el contenido revisado (meses en español sin depender de ICU del
  runtime — `formatFechaEs`, decisión documentada y razonable).

### ML-03 [severidad MEDIA] — `safeUrl` permite hosts que no son `localhost` por un error de anclaje del regex

**Rubro:** 2 (plantillas) / 3 (seguridad de enlaces). **Evidencia:**

`src/security/safe-url.ts` línea 10:
```ts
if (!/^https:\/\/i.test(trimmed) && !/^http:\/\/localhost/i.test(trimmed)) return fallback;
```
El regex `^http:\/\/localhost` no está anclado a un límite de host (`:puerto`, `/` o fin de
cadena), por lo que **acepta cualquier host que empiece con la cadena "localhost"**, no solo
`localhost` real. Verificado con Node directamente por el auditor:

```
$ node -e 'console.log(/^http:\/\/localhost/i.test("http://localhost.evil-attacker.com/phish"))'
true
```

`safeUrl("http://localhost.evil-attacker.com/phish", fallback)` devuelve la URL maliciosa **sin
pasar por el fallback**. El propósito documentado de la función ("solo dejan pasar http(s)... nunca
`javascript:`/`data:`") no se ve comprometido por esto (sigue siendo `http://`, no un esquema
ejecutable), pero sí se rompe la intención más estrecha de que el escape a `http://` no-seguro solo
aplique a `localhost` de desarrollo — cualquier valor que llegue a un campo con este validador
(p. ej. si en el futuro `tenderUrl` u otra URL de origen externo se enrutara por `safeUrl` en vez de
exigir `https` estricto) podría colarse como enlace `http://` sin cifrar bajo apariencia de
"localhost", útil para un ataque de phishing con un dominio como `localhost-mx.ejemplo.com`.

**Reparación (separada, no aplicada):** anclar el regex con límite de host:
`/^http:\/\/localhost(:\d+)?(\/|$)/i`.

### ML-04 [severidad MEDIA] — Contraste de `colors.faint` no cumple AA para texto normal y no está probado

**Rubro:** 2 (accesibilidad). **Evidencia:** `colors.faint = "#8291a3"` se usa en `EmailLayout.tsx`
para el pie completo (motivo de envío, enlace de administrar preferencias, enlace de baja, texto
literal de respaldo bajo el botón CTA) a tamaños de 10-11.5px, **texto normal, no grande ni
negrita**. Calculado por el auditor con la misma fórmula de luminancia relativa que usa el propio
`test/theme/contrast.test.ts`:

```
faint (#8291a3) vs surface (#ffffff): 3.22:1
faint (#8291a3) vs canvas  (#f7f9fc): 3.05:1
```

Ambos **por debajo de 4.5:1**, el umbral WCAG AA para texto normal (el umbral relajado de 3:1 solo
aplica a texto grande ≥18pt o ≥14pt negrita, que no es el caso aquí). `test/theme/contrast.test.ts`
prueba `ink`, `body`, blanco-sobre-marca y `muted` (este último ya con un umbral auto-declarado
relajado a 3:1 sin justificar por qué no aplica el estándar completo) — **`faint` nunca se
prueba**, pese a ser el color de textos funcionales importantes (enlace de baja, motivo de envío).

**Reparación (separada, no aplicada):** oscurecer `faint` hasta ≥4.5:1 contra `surface`/`canvas`, o
restringir su uso a texto grande/negrita únicamente; agregar una prueba de contraste para `faint`.

---

## 3. Enlaces firmados

**Comprobado correcto** (leído y re-derivado por el auditor, no solo confiado en los tests):

- HMAC-SHA256 sobre el payload base64url con expiración (`exp`) embebida y validada en servidor.
- Comparación de firma con `timingSafeEqual` (no `===`), con verificación de longitud igual antes
  de comparar (evita que `timingSafeEqual` lance por longitudes distintas) — correcto contra
  ataques de temporización.
- Manipulación del payload (`d` alterado) invalida la firma; secreto distinto invalida la firma;
  expiración pasada rechaza con `reason: "expirado"` incluso con firma válida — los tres casos
  cubiertos en `signed-link.test.ts` y consistentes con el código.
- Secreto ausente/corto (`<16` caracteres) hace que `createLinkSigner` **lance en construcción**
  (falla cerrado al arrancar, no en cada verificación) — correcto.
- Entropía: la firma es un HMAC-SHA256 completo (256 bits), no un token corto adivinable.

**Nota fuera de alcance (no hallazgo, aclaración de diseño):** el esquema es explícitamente
**sin estado en servidor** (documentado así en el propio código): un enlace firmado sigue siendo
válido hasta su expiración sin importar cuántas veces se use. Para "baja de un clic" esto es
correcto por diseño (acción idempotente). Para verificación de correo/restablecimiento de
contraseña, esto significa que **no hay una sola vez de uso forzada por este paquete** — la
invalidación tras el primer uso (si se desea) es responsabilidad de quien consuma el enlace
(`apps/api`, marcando el `userId`/token como consumido en su propia tabla), algo que
`packages/mail` no puede resolver por sí mismo al no tener persistencia. REQ-186 solo exige
expiración + verificación de firma en servidor (ambos cumplidos); no exige un solo uso. Se señala
para que `apps/api` no asuma que el paquete ya resuelve el caso de reutilización de un enlace de
restablecimiento de contraseña ya usado.

---

## 4. Servicio (`MailService`)

**Comprobado correcto:**

- Orden de verificación correcto: destinatario registrado → preferencias → supresión (fail-closed)
  → idempotencia (`already_sent`) → validación de variables → render → límite de tasa → reintentos.
- `assertRegisteredRecipient` rechaza un `string` colado: probado por el auditor pasando
  `"a@b.mx"` directo (no un objeto) → `UnregisteredRecipientError` (test existente y re-verificado
  leyendo `RegisteredRecipientSchema` — un `string` nunca pasa `z.object(...)`).
- Supresión fail-closed verificada en código y test: si `isSuppressed()` lanza, `MailService` trata
  el envío como suprimido (`catch { return true; }` en `isRecipientSuppressed`).
- Preferencias: categoría obligatoria (`account_security`, `internal`) ignora cualquier preferencia
  del usuario; categoría opcional apagada (`=== false`) bloquea el envío sin llamar al proveedor.
- Reintentos: 429/5xx clasificados `retryable` reintentan con backoff exponencial + jitter
  (`computeBackoffDelay`, capado en `maxDelayMs`); un 4xx se marca `failed_permanent` sin
  reintentar, en un solo intento — verificado en código y tests para los tres adaptadores.
- Outbox: estados `sent`/`failed_permanent`/`dead` correctamente registrados con `attempts`/
  `maxAttempts`/`lastError`.

### ML-01 [severidad ALTA] — La idempotencia por `messageKey` NO se sostiene bajo llamadas concurrentes reales

**Rubro:** 4 (servicio — "idempotencia por messageKey (doble envío → uno)"). Este es exactamente el
escenario adversarial pedido en el encargo, y el resultado es negativo.

**Evidencia (reproducida por el auditor con un script ad-hoc, no un test del repo):**

```ts
// mismo messageKey, dos llamadas EN PARALELO (Promise.all), no secuenciales
const [a, b] = await Promise.all([service.send(input), service.send(input)]);
```

Resultado:
```
calls to provider: 2
outcome A: sent  outcome B: sent
```

**Ambas** llamadas llegan al `MailProvider.send()` real (dos correos habrían salido de verdad) y
**ambas** terminan con `status: "sent"`. La suite existente (`mail-service.test.ts`, prueba "es
idempotente...") solo ejercita el caso **secuencial** (`await first; await second;`), donde el
`await` intermedio ya deja escrito el registro `sent` antes de la segunda llamada — ese caso sí
funciona, pero no es el caso que importa en producción: colas con entrega *at-least-once*,
reintentos del lado del llamador, o un doble clic que dispare dos peticiones casi simultáneas al
mismo endpoint, SÍ generan llamadas concurrentes con el mismo `messageKey`.

**Causa raíz:** `SendRecordStore` (interfaz en `service/send-store.ts`) solo expone `get()` y
`save()` — no existe una operación atómica de "reservar" (`INSERT ... ON CONFLICT DO NOTHING` /
compare-and-swap). `MailService.send()` hace `get()` (verificación) y, mucho después —tras
resolver la plantilla, renderizar, y **llamar de verdad al proveedor**— hace `save()`. Entre esos
dos pasos no hay ninguna sección crítica protegida: es un patrón *check-then-act* de manual de
condiciones de carrera. Esto no es solo un defecto de `InMemorySendRecordStore` (que el README ya
advierte "solo para pruebas"): **la interfaz misma que `apps/api` debe implementar contra Postgres
no tiene forma de resolver esta carrera**, porque `MailService` nunca le pide a la store que
reserve el envío ANTES de tocar al proveedor — sin importar qué tan atómica sea la implementación
real de `save()`, el `get()` inicial ya devolvió "no existe" para ambas llamadas concurrentes.

**Impacto:** duplicidad real de correos enviados a un usuario (doble verificación de cuenta, doble
alerta de convocatoria, doble recordatorio de plazo) bajo el patrón de reintento que el propio
`README.md` dice que `messageKey` existe para prevenir ("un reintento de SU lado — una cola que
reprocesa, un doble clic — nunca duplique el envío"). Esa garantía, tal como está construido el
servicio, **no se cumple** para llamadas concurrentes.

**Reparación (separada, no aplicada):** agregar a `SendRecordStore` una operación atómica de
reserva, p. ej. `tryClaim(messageKey): Promise<boolean>` (que la implementación real en Postgres
resuelva con una restricción `UNIQUE`/`INSERT ... ON CONFLICT DO NOTHING`, y la versión en memoria
con una comprobación-y-escritura síncrona sobre el `Map`), e invocarla en `MailService.send()`
**antes** de llamar al `MailProvider`, devolviendo `already_sent`/`sent` (con el resultado de quien
sí ganó la reserva) a quien pierda la carrera. Añadir una prueba con `Promise.all([...])` sobre el
mismo `messageKey` que verifique `provider.send` llamado exactamente una vez.

---

## 5. Adaptadores (Resend / Postmark / SMTP / Capture / Webhooks)

**Comprobado correcto:**

- Los tres adaptadores HTTP/SMTP se probaron con mocks de red (`fetchImpl`/`transporterFactory`
  inyectados) — ningún test golpea la red real.
- Clasificación 429/5xx → `retryable`, resto de 4xx → `permanent` para HTTP (Resend/Postmark);
  SMTP correctamente **invertido** (4xx SMTP = temporal/retryable, 5xx = permanente) y documentado
  el motivo — revisado y correcto.
- `CaptureProvider` nunca sale a la red, guarda en memoria y opcionalmente en JSONL en disco
  (`appendFileSync` con `mkdirSync(recursive:true)` antes) — verificado en código.
- `createMailProviderFromEnv()` degrada a `CaptureProvider` para `MAIL_PROVIDER` ausente o
  desconocido — nunca falla, nunca sale a Internet por accidente. Consistente con REQ-183/REQ-190.
- API key/tokens **nunca aparecen en logs ni en el `detail` de error**: se revisó cada `catch` de
  los tres adaptadores — el `detail` de un fallo HTTP es el cuerpo de la respuesta del proveedor
  (recortado a 200 caracteres) o `error.message`, nunca `options.apiKey`/`serverToken`/`pass`. No
  se encontró ningún `console.log`/`console.error` en `src/` (grep confirmado).
- Firma Svix: verificación correcta de `svix-id.svix-timestamp.cuerpo_crudo`, soporte de rotación
  de secreto (múltiples firmas separadas por espacio), rechazo de secreto/base64 inválido, cuerpo
  alterado, cabeceras incompletas y timestamp fuera de tolerancia — los 8 casos de
  `verify-signature.test.ts` fueron releídos y su lógica re-derivada manualmente por el auditor.
- Webhook malformado (payload sin la forma esperada) → `parseResendWebhookPayload` devuelve `null`
  sin lanzar — un endpoint que lo use no cae por un webhook mal formado.
- Evento `email.bounced`/`email.complained` → `applyMailWebhookEvent` llama a
  `suppressionStore.suppress()` correctamente; el resto de eventos no tiene efecto de negocio.

### ML-05 [severidad MEDIA] — Sin protección contra reenvío (replay) del mismo webhook dentro de la ventana de tolerancia, y sin prueba que lo cubra

**Rubro:** 5 (adaptadores — "webhooks: firma Svix inválida/ausente/replay → rechazado", pedido
explícito del encargo).

**Evidencia:** `verifyResendWebhookSignature` solo rechaza por **timestamp fuera de rango**
(`toleranceSeconds`, default 300s = 5 min). No existe ningún mecanismo (ni en este paquete ni
documentado como responsabilidad de `apps/api`) que recuerde un `svix-id` ya procesado. Dentro de
la ventana de 5 minutos, **repetir exactamente la misma petición capturada** (mismo `svix-id`,
`svix-timestamp`, cuerpo y firma) se vuelve a verificar como `{ ok: true }` cuantas veces se quiera.
Los 8 casos de `verify-signature.test.ts` cubren firma inválida/ausente/timestamp viejo, pero
**ninguno** ejercita "el mismo `svix-id` ya visto antes".

**Impacto real, acotado:** los dos únicos eventos con efecto de negocio
(`email.bounced`/`email.complained`) son **idempotentes** (`suppress()` sobrescribe la misma
entrada) — un reenvío dentro de la ventana no causa un envío duplicado ni una segunda supresión
distinta. El riesgo es bajo en el estado actual, pero es exactamente el escenario adversarial
pedido y no está ni prevenido ni probado.

**Reparación (separada, no aplicada):** documentar en el README que quien exponga
`POST /api/correo/eventos` (fuera de este paquete, según el propio README) debe deduplicar por
`svix-id` con una tabla/caché de corta duración antes de llamar a `applyMailWebhookEvent`; agregar
una prueba (a nivel de quien consuma el endpoint) que reenvíe el mismo `svix-id` y verifique que no
se reprocesa dos veces si en el futuro se agrega un evento con efecto NO idempotente.

---

## 6. Seguridad

### ML-02 [severidad ALTA] — Cabeceras `List-Unsubscribe` / `List-Unsubscribe-Post` (RFC 8058) ausentes en todo el flujo de envío

**Rubro:** 6 (seguridad — pedido explícito del encargo: "cabeceras List-Unsubscribe (RFC 8058)
presentes").

**Evidencia:** búsqueda exhaustiva (`grep -rn "List-Unsubscribe" src test scripts README.md`) solo
encuentra la cadena en **un comentario** de `provider/types.ts:31` ("Cabeceras adicionales del
mensaje (p. ej. `List-Unsubscribe`)"). Nunca se construye ni se pasa:

- `RenderedEmail` (`templates/types.ts`) solo tiene `{ subject, html, text }` — **no hay campo
  `headers`**, así que ninguna plantilla puede comunicar estas cabeceras aunque quisiera.
- `MailService.send()` construye el mensaje al proveedor así (línea 154-161 de
  `service/mail-service.ts`): `{ to, subject, html, text, fromLocalPart, idempotencyKey }` — **sin
  `headers`**, pese a que `OutboundEmail.headers` existe en el tipo y los tres adaptadores
  (Resend/Postmark/SMTP) ya saben reenviarlas si llegaran.
- El comentario de `EmailLayout.tsx` línea 64 afirma explícitamente: *"Liga de baja de un clic
  (RFC 8058 / art. 16 fr. II LFPDPPP)"* — pero lo que existe es un **enlace dentro del cuerpo del
  correo**, no las cabeceras `List-Unsubscribe`/`List-Unsubscribe-Post` que son, literalmente, lo
  que RFC 8058 define como "one-click unsubscribe" (el botón nativo "Cancelar suscripción" que
  Gmail/Yahoo pintan junto al remitente). Son mecanismos distintos; el comentario cita la norma
  equivocada para lo que realmente se implementó.

**Impacto:** desde febrero de 2024, Gmail y Yahoo **exigen** estas cabeceras para remitentes de
volumen (>5,000 correos/día) so pena de mayor probabilidad de ir a spam/rechazo; incluso por debajo
de ese umbral, es la práctica estándar de entregabilidad que la propia plantilla de referencia
(Likida, según el README de este paquete) dice reproducir. Sin ellas, el "un clic" prometido por
REQ-187 / el comentario del código no existe a nivel de protocolo — solo existe como enlace en el
cuerpo, que requiere que el usuario abra el correo y haga clic dentro de él.

**Reparación (separada, no aplicada):** agregar `headers?: Record<string,string>` (u opción
específica) al retorno de `TemplateDefinition.render()`/`RenderedEmail`, o bien calcular estas
cabeceras dentro de `MailService.send()` a partir de la `unsubscribeUrl` firmada ya presente en las
variables (`List-Unsubscribe: <${unsubscribeUrl}>, <mailto:${supportEmail}?subject=unsubscribe>` +
`List-Unsubscribe-Post: List-Unsubscribe=One-Click`), y pasarlas en el `OutboundEmail.headers` que
ya reciben los tres adaptadores.

### ML-06 [severidad BAJA] — 3 vulnerabilidades críticas + 1 alta en devDependencies (no en runtime de producción)

**Rubro:** 6 (seguridad — "dependencias, `npm audit`").

**Evidencia:**
```
$ npm audit                    → 7 vulnerabilidades (3 críticas, 1 alta, 3 moderadas)
$ npm audit --omit=dev         → 0 vulnerabilidades
```
Las 7 están en la cadena `vitest`(4.1.11) / `@vitest/coverage-v8`(5.0.0) / `vite` / `esbuild` /
`html-validate`(11.14.0) — todas **devDependencies** usadas solo para correr pruebas/cobertura/lint
de este paquete, no en el código que se despliega. La más severa
(GHSA-5xrq-8626-4rwp, CVSS 9.8) es una ejecución arbitraria de archivos cuando el **servidor de UI
de Vitest** está escuchando — ese modo (`vitest --ui`) no se usa en ningún script de este repo.

**Impacto:** ninguno en producción; riesgo solo si un desarrollador corre `vitest --ui` con la red
expuesta en su máquina. **Comprobado correcto** que las dependencias de **runtime** (react-email,
zod, nodemailer) están limpias.

**Reparación (separada, no aplicada):** programar una actualización de major de
`vitest`/`@vitest/coverage-v8`/`html-validate` cuando convenga; no es urgente.

**No se encontraron secretos ni credenciales en el repo** (`grep` de patrones de API key/secreto/
contraseña hardcodeados sobre `src`/`scripts` → 0 resultados; todas las credenciales se leen de
`process.env` y ninguna tiene un valor por default no vacío).

---

## 7. Trazabilidad REQ y pendientes declarados

**Comprobado correcto:**

- `docs/AGENTES.md` #88 registra correctamente la tarea `impl-mail` como `COMPLETADO`, con métricas
  reales (242 usos de herramienta, 220 tests, cobertura 96.4/83.4) — no exagera el alcance.
- `docs/BACKLOG.md` (REQ-181 a REQ-190) declara correctamente el único bloqueo externo real:
  credenciales de un proveedor de correo real + dominio con SPF/DKIM — **nunca** se marca esto como
  resuelto, y el propio `README.md` del paquete repite la misma advertencia ("PENDIENTE del
  usuario") en la tabla de variables de entorno. No se encontró ningún lugar del repo que afirme
  falsamente tener credenciales reales o un envío real ya probado contra un proveedor.
- No hay secretos de ejemplo con apariencia real (los usados en tests son literales evidentes tipo
  `"una-llave-de-32-bytes-para-hmac!"`).

### ML-07 [severidad MEDIA] — `docs/ACEPTACION.md` no refleja que `packages/mail` ya existe; alcance real de S4/S5/S6/S7/S12 es de librería, no de integración con `apps/api`

**Rubro:** 7 (trazabilidad, pedido explícito del encargo).

**Evidencia:** `docs/ACEPTACION.md`, tabla de REQ-206..REQ-210 y tabla "Pruebas mínimas
obligatorias de la Ampliación 2", filas S4/S5/S6/S7/S12, siguen leyendo literalmente (verificado
en el HEAD auditado, commit `f9dd6bd`):

> S4 | ... | Sin código — `packages/mail` aún no existe | PENDIENTE
> S5, S6, S7, S12 | ... | Sin código | PENDIENTE
> REQ-207 | Suite de correos (bandeja de captura): S4+S5+S6+S7 en verde | ... | Sin código | PENDIENTE

Esto es **incorrecto a la fecha de esta auditoría**: `packages/mail` existe, compila, y tiene 220
pruebas en verde que cubren funcionalmente las mismas aserciones que S4 (render con variables
reales + validación HTML/accesibilidad básica), S5 (expiración de enlace firmado), S6 (baja de
notificaciones respetada salvo seguridad) y S12 (0 llamadas de red sin proveedor configurado) a
**nivel de librería**. No es una omisión que oculte trabajo pendiente real (es lo opuesto: es un
documento de gobierno que **subestima** el avance), pero sí es un riesgo de proceso: el propio
REQ-210 de esta ampliación exige que la auditoría/reverificación se apoye en el estado de
`docs/ACEPTACION.md`, y ese documento, tal como está, le diría a cualquiera que audite o planee
trabajo que "packages/mail aún no existe".

**Precisión adicional (no exactamente un defecto, pero relevante para no sobre-declarar S4-S7/S12
como "cerradas" al corregir el documento):** ninguna de las pruebas de `packages/mail` es una
prueba de integración/E2E contra `apps/api` real — son pruebas de la librería en aislamiento
(proveedor falso inyectado, stores en memoria). Se verificó que **`apps/api`/`apps/worker` no
importan `@atiende/mail` en ningún archivo** (`grep -rl "@atiende/mail" apps/` → sin resultados):
no existe todavía el endpoint `POST /api/correo/eventos` que el propio README de `packages/mail`
describe como responsabilidad de `apps/api`, ni ningún flujo real (registro de usuario, invitación,
etc.) que dispare un envío a través de `MailService`. Es decir: S4/S5/S6/S7/S12 están **cubiertas a
nivel de librería**, pero **no** en el sentido de "un usuario real registra su correo y recibe (o
no recibe, según preferencia) el correo verdadero a través de la aplicación" — ese nivel de
integración sigue pendiente y correctamente no reclamado como hecho en ningún documento revisado.

**Reparación (separada, no aplicada):** actualizar las filas S4/S5/S6/S7/S12 y REQ-207 de
`docs/ACEPTACION.md` para reflejar "cubierto a nivel de librería en `packages/mail`
(`test/templates/catalog.test.ts`, `test/security/signed-link.test.ts`,
`test/preferences/filter.test.ts`, `test/service/mail-service.test.ts`, `test/provider/*.test.ts`),
pendiente de integración real en `apps/api`" en vez de "Sin código / PENDIENTE" sin matiz.

---

## Índice de hallazgos

| ID | Severidad | Rubro | Resumen |
|---|---|---|---|
| ML-01 | Alta | 4 — Servicio | Idempotencia por `messageKey` no se sostiene bajo concurrencia real (reproducido: 2 llamadas paralelas → 2 envíos al proveedor) |
| ML-02 | Alta | 6 — Seguridad | Cabeceras `List-Unsubscribe`/`List-Unsubscribe-Post` (RFC 8058) nunca se generan ni se pasan al proveedor |
| ML-03 | Media | 2/3 — Plantillas/Enlaces | `safeUrl` acepta cualquier host que empiece con "localhost" por regex sin anclar |
| ML-04 | Media | 2 — Accesibilidad | `colors.faint` no cumple contraste AA (3.05-3.22:1 vs 4.5:1 requerido) y no está probado |
| ML-05 | Media | 5 — Adaptadores | Sin protección/prueba de reenvío (replay) de webhook dentro de la ventana de tolerancia de 5 min |
| ML-06 | Baja | 6 — Seguridad | 3 vulnerabilidades críticas/1 alta en devDependencies (vitest/vite/esbuild/html-validate); 0 en runtime |
| ML-07 | Media | 7 — Trazabilidad | `docs/ACEPTACION.md` describe S4/S5/S6/S7/S12 y REQ-207 como "Sin código/PENDIENTE" cuando `packages/mail` ya existe; falta matizar alcance librería vs. integración real |

## Evidencia adicional

- Capturas: `docs/auditoria-2/capturas-mail/{email-verification,new-tender-match,deadline-reminder,weekly-summary,backup-codes-generated}-{desktop,movil}.png`
- Log de ejecución: `docs/logs/audit-mail.log`
