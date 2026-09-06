# @atiende/mail

Motor de plantillas y servicio de envío de correo transaccional de **Atiende
Licitaciones** (ronda 6, `docs/AMPLIACION-2-SALIDA.md` §2). Librería
TypeScript **pura** (sin dependencia de ninguna base de datos ni de
`apps/api`/`apps/worker`), con el mismo criterio que `packages/agents`: aquí
solo viven contratos (interfaces) e implementaciones en memoria para pruebas;
la persistencia real (outbox, supresión) la implementa quien consuma este
paquete.

Fuentes de referencia leídas para esta ronda:
`docs/investigacion/frontend-restaurantes.md` (tokens de marca de Atiende) y
`docs/investigacion/salida-promocion-referencias.md` §2 y §6.3 (estructura y
tono de Likida/Atiende Restaurantes, catálogo de 10 plantillas de REQ-181).

## Qué NO es este paquete

- No manda correo por sí solo en producción sin que alguien configure un
  proveedor real (Resend/Postmark/SMTP) por variable de entorno.
- No decide a quién se le puede escribir: `MailService.send()` exige un
  `RegisteredRecipient` (o varios) que el llamador ya validó contra su propia
  base de usuarios — nunca un `string` suelto.
- No persiste nada: `SendRecordStore` (idempotencia/outbox) y
  `SuppressionStore` (rebotes/quejas) son interfaces; las implementaciones de
  este paquete (`InMemorySendRecordStore`, `InMemorySuppressionStore`) son
  solo para pruebas y para un `MailService` sin persistencia configurada.

## Arquitectura

```
src/
  theme.ts                     Tokens de marca de Atiende (colores/fuentes), copiados
                                de docs/investigacion/frontend-restaurantes.md §2.1-2.2
  components/
    AtiendeLogo.tsx             AtiendeLogoMark (SVG, fuera de correo) + AtiendeWordmarkText
                                 (el encabezado REAL dentro de un correo — ver el porqué abajo)
    EmailLayout.tsx              El layout base: encabezado, tarjeta, pie con motivo de envío +
                                 preferencias/baja + placeholder legal marcado
    blocks.tsx                  CtaButton, DataTable, CodeBlock, BackupCodesGrid, Callout, ToneBadge
  security/
    safe-url.ts                  Solo deja pasar http(s) (nunca javascript:/data:); http:// SOLO a un
                                 host de una lista blanca EXACTA (localhost/127.0.0.1/env), nunca por
                                 prefijo de cadena (ML-03)
    signed-link.ts                createLinkSigner(secret) → {signedLink, verifySignedLink} (HMAC-SHA256)
  preferences/
    types.ts / filter.ts          NotificationCategory, NotificationPreferences, isCategoryEnabled()
  recipients/
    types.ts                     RegisteredRecipient (zod) + assertRegisteredRecipient()
  suppression/
    types.ts                     SuppressionStore (deny-all, fail-closed) + InMemorySuppressionStore
  webhooks/
    types.ts / verify-signature.ts / replay-guard.ts / parse-resend-payload.ts / apply-event.ts
                                 Eventos de entrega (bounce/queja), firma Svix de Resend, anti-replay
                                 por svix-id (ML-05), y el efecto de negocio (suprimir automáticamente
                                 ante bounce/queja)
  templates/
    common.ts                    BaseVariablesSchema (zod) + formatFechaEs()
    types.ts                     TemplateDefinition<V> (id, category, mandatory, schema, sampleData, render)
    registry.ts                  templateRegistry + listTemplates()/getTemplate()/requireTemplate()
    catalog/*.tsx                Las 16 plantillas (ver tabla abajo)
  provider/
    types.ts                     MailProvider, OutboundEmail, OutboundAttachment, SendResult
    resend-provider.ts            fetch directo a api.resend.com (sin SDK, timeout 5s)
    postmark-provider.ts          fetch directo a api.postmarkapp.com
    smtp-provider.ts              nodemailer (SMTP genérico)
    capture-provider.ts           Guarda en memoria + opcionalmente JSONL en disco (dev/test)
    factory.ts                    createMailProviderFromEnv() — MAIL_PROVIDER decide cuál
  service/
    mail-service.ts               MailService: preferencias → supresión → idempotencia (reserve) →
                                   render → List-Unsubscribe → límite de tasa → reintentos → registro
    retry.ts / rate-limiter.ts / send-store.ts / list-unsubscribe.ts
scripts/preview.ts               npm run -w packages/mail preview → packages/mail/preview/*.html
```

## El motor de plantillas: por qué React Email, y qué NO usa de él

Se usa `@react-email/components` + `@react-email/render` (no MJML): ninguna
de las dos referencias reales del proyecto (Likida, Atiende Restaurantes)
usa React Email ni MJML — ambas escriben HTML de tabla a mano — pero React
Email genera exactamente el mismo patrón (`<table>` anidadas, todo el CSS
inline) con componentes tipados y `render(el, {plainText:true})` para la
versión de texto automática, sin tener que mantener un generador de HTML a
mano. Donde React Email no alcanza (el encabezado, ver siguiente sección) se
usa HTML/JSX directo, con el mismo criterio de las dos referencias.

**El logo NO es un `<svg>` inline dentro del correo.** `AtiendeLogo.tsx`
documenta el porqué completo: Gmail descarta el elemento `<svg>` de un correo
HTML por completo (no es un problema exclusivo de Outlook), así que
`EmailLayout` usa el **wordmark de texto** ("atiende", Inter Tight, azul de
marca) como encabezado por default — el mismo criterio que Atiende
Restaurantes ya usa en producción ("sin logo-imagen — wordmark de texto").
El plumbing para el logo `cid:` inline al estilo Likida SÍ existe de punta a
punta (`OutboundAttachment` en `provider/types.ts`, cableado en los tres
adaptadores HTTP/SMTP, y `EmailLayout`'s prop `logoCid`) — listo para el día
en que exista un PNG oficial de Atiende (el SVG de la consola web es, por su
propio comentario de origen, una reconstrucción, no un asset oficial
aprobado para usarse como logo de correo).

## Catálogo de plantillas (16)

Cubre el REQ-181 de `docs/investigacion/salida-promocion-referencias.md`
§6.3 (10 plantillas propuestas, asuntos alineados literalmente) más el resto
del catálogo pedido en `docs/AMPLIACION-2-SALIDA.md` §2 (bienvenida/onboarding
y contacto interno, que REQ-181 no cubre pero sí la ampliación).

| id | REQ-181 | Categoría | Obligatoria |
|---|---|---|---|
| `email-verification` | 1 | `account_security` | sí |
| `organization-invite` | 2 | `account_security` | sí |
| `password-reset` | 3 | `account_security` | sí |
| `two-factor-enabled` | 4 (activación) | `account_security` | sí |
| `backup-codes-generated` | 4 (códigos) | `account_security` | sí |
| `new-tender-match` | 5 (nueva) | `tender_matches` | no |
| `tender-change` | 5 (cambio) | `tender_changes` | no |
| `tender-match-digest` | 6 (digesto de varias) | `tender_matches` | no |
| `pending-approval` | 7 | `approvals` | no |
| `submission-package-ready` | 8 | `submission` | no |
| `deadline-reminder` | 9 (plazo de presentación) | `deadlines` | no |
| `document-expiration` | 9 (documento de expediente) | `document_expiration` | no |
| `post-award-alert` | 9 (pago/garantía) | `post_award` | no |
| `weekly-summary` | 10 (diario/semanal) | `weekly_summary` | no |
| `welcome-onboarding` | — (ampliación 2 §2) | `account_security` | sí |
| `contact-received` | — (ampliación 2 §2, interno) | `internal` | sí |

Cada plantilla exporta: su esquema zod de variables, `sampleData` (marcado
"(ejemplo)" en el propio texto), y `render(vars) => Promise<{subject, html,
text}>`. `templateRegistry`/`listTemplates()`/`requireTemplate(id)` en
`templates/registry.ts` es el punto de entrada para `apps/api`/`apps/worker`.

## `MailService`: cómo lo integrará `apps/api`/`apps/worker`

```ts
import {
  MailService, createMailProviderFromEnv, createLinkSigner,
  InMemorySendRecordStore, InMemorySuppressionStore, // reemplazar por implementaciones reales sobre Postgres
} from "@atiende/mail";

const mailService = new MailService({
  provider: createMailProviderFromEnv(process.env),
  store: myOutboxStore,             // implementa SendRecordStore contra una tabla real (ver abajo)
  suppressionStore: mySuppressionStore, // implementa SuppressionStore contra una tabla real
  linkSigner: createLinkSigner(process.env.MAIL_LINK_SECRET!),
});

const outcome = await mailService.send({
  to: registeredRecipient,           // RegisteredRecipient — ya validado por el llamador
  templateId: "email-verification",
  variables: {
    recipientName, appUrl, supportEmail,
    verificationUrl: mailService.signedLink(appUrl, "/verificar-correo", { userId }, 30 * 60),
    expiresInMinutes: 30,
  },
  messageKey: `email-verification:${userId}`, // idempotencia — ver outbox abajo
});
```

`SendOutcome.status` cubre: `sent`, `already_sent` (idempotencia),
`skipped_preferences`, `skipped_suppressed`, `not_configured`,
`invalid_variables`, `unregistered_recipient`, `failed_permanent`, `dead`
(reintentos agotados).

### El outbox (`SendRecordStore`)

`SendRecordStore` es el contrato de idempotencia — el mismo patrón que
`RunStore`/`ToolCallStore` de `packages/agents`: solo una interfaz aquí.
`apps/api`/`apps/worker` la implementan contra una tabla real tipo
`messaging_outbox` (el patrón de Atiende Restaurantes,
`docs/investigacion/salida-promocion-referencias.md` §2.1): `dedupe_key =
messageKey`, estados `pending`/`processing`/`sent`/`failed`/`dead`, con sus
propias columnas de `lease_until`/`fence_token` si varios workers reclaman
envíos sin pisarse. `InMemorySendRecordStore` es solo para pruebas y para un
`MailService` de desarrollo sin persistencia.

**Idempotencia bajo concurrencia real (`reserve()`/`release()`).**
`get()`+`save()` por sí solos son un patrón *check-then-act*: dos llamadas
concurrentes con la misma `messageKey` (reintento de una cola *at-least-once*,
doble clic que dispara dos peticiones casi simultáneas) verían ambas "no
existe" en el `get()` y ambas llegarían a mandar el correo de verdad.
`SendRecordStore.reserve(messageKey): Promise<boolean>` es la operación
atómica de compare-and-set que cierra esa ventana — `MailService.send()` la
invoca justo ANTES de tocar el `MailProvider`, y solo quien recibe `true`
continúa; quien recibe `false` espera (acotado) a que quien ganó termine de
escribir su resultado con `store.get()`, y devuelve ESE resultado (nunca
llama al proveedor por su cuenta). La implementación real sobre Postgres
resuelve `reserve()` con la restricción `UNIQUE` de `dedupe_key`:

```sql
INSERT INTO messaging_outbox (dedupe_key, status, ...)
VALUES ($1, 'pending', ...)
ON CONFLICT (dedupe_key) DO NOTHING;
-- reserve() === true  si rowCount === 1 (esta llamada ganó la reserva)
-- reserve() === false si rowCount === 0 (alguien más ya la tenía)
```

`store.release(messageKey)` (opcional en la interfaz) libera una reserva SIN
escribir un registro final — solo se usa cuando el envío se abortó ANTES de
intentar el proveedor (`not_configured`), para permitir que una llamada
POSTERIOR (no concurrente) con la misma llave reintente. Prueba de
regresión: `test/service/mail-service.test.ts` ("ML-01") dispara 10
`service.send()` con la misma `messageKey` dentro de un solo `Promise.all` y
verifica que el `MailProvider` real se llama exactamente una vez.

### La lista de supresión (`SuppressionStore`)

Deny-all y **fail-closed**: si la consulta a la lista de supresión falla,
`MailService` trata el envío como suprimido — nunca se manda a una dirección
que no se pudo confirmar como segura. Se alimenta automáticamente vía
`applyMailWebhookEvent()` cuando llega un evento `email.bounced`/
`email.complained` de Resend (`parseResendWebhookPayload()` +
`verifyResendWebhookSignature()` para validar la firma Svix del webhook
antes de confiar en el payload — ver `webhooks/`). `apps/api` expone el
endpoint HTTP (`POST /api/correo/eventos`, al estilo Likida) que recibe el
webhook, verifica la firma y llama a estas dos funciones; ese endpoint vive
fuera de este paquete (`packages/mail` no sabe de HTTP).

**Anti-replay de webhooks (ML-05).** `verifyResendWebhookSignature()` por sí
sola solo rechaza por firma inválida o por `svix-timestamp` fuera de la
ventana de tolerancia (300s default) — DENTRO de esa ventana, repetir
exactamente la misma petición capturada (mismo `svix-id`, cuerpo y firma) se
vuelve a verificar como válida cuantas veces se quiera. Para el endpoint HTTP
real, `apps/api` debe usar
`verifyResendWebhookSignatureWithReplayGuard(rawBody, headers, secret,
replayGuard)` en vez de la función base: compone la verificación de firma
con un `WebhookReplayGuard` (interfaz de este paquete, `webhooks/replay-guard.ts`)
que reclama cada `svix-id` una sola vez dentro de la ventana — la segunda
petición con el mismo `svix-id` responde `{ ok: false, reason: "replay" }`,
que el handler HTTP debe traducir a `409 Conflict` (o ignorar en silencio)
**sin** volver a llamar a `applyMailWebhookEvent`. `apps/api` implementa
`WebhookReplayGuard` contra una tabla/caché real de vida corta (p. ej.
`webhook_events_vistos (svix_id PRIMARY KEY, expira_en)` en Postgres, o una
llave de Redis con `EXPIRE <toleranceSeconds>`); `InMemoryWebhookReplayGuard`
es solo para pruebas. Prueba de regresión:
`test/webhooks/verify-signature.test.ts` reenvía la misma petición firmada
dos veces y verifica que la segunda se rechaza como `replay`.

### Cabeceras `List-Unsubscribe` de un clic (RFC 8058, ML-02)

Desde febrero de 2024, Gmail y Yahoo EXIGEN las cabeceras
`List-Unsubscribe`/`List-Unsubscribe-Post` para remitentes de volumen (y son
buena práctica de entregabilidad para cualquier volumen). `MailService.send()`
las calcula automáticamente para toda plantilla de categoría **no
obligatoria** (`template.mandatory === false`) que traiga `unsubscribeUrl`
en sus variables — nunca para seguridad de cuenta/interno — y las pasa como
`OutboundEmail.headers` a los tres adaptadores, que ya sabían reenviar
cabeceras arbitrarias:

```
List-Unsubscribe: <https://app.atiende.mx/preferencias/baja?d=...&s=...>, <mailto:soporte@atiende.mx?subject=unsubscribe>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

Esto es DISTINTO del enlace de baja dentro del cuerpo del correo (el que
pinta `EmailLayout`, art. 16 fr. II LFPDPPP): las cabeceras son el botón
nativo "Cancelar suscripción" que Gmail/Yahoo pintan junto al remitente, sin
que la persona tenga que abrir el correo. `service/list-unsubscribe.ts`
expone `buildListUnsubscribeHeaders()` como función pura, reutilizable si
`apps/api`/`apps/worker` necesitan las mismas cabeceras fuera de
`MailService` (p. ej. un reenvío manual).

**Endpoint de un clic que debe exponer `apps/api`** (RFC 8058 exige que el
`POST` del botón nativo del cliente de correo, sin interacción humana
adicional, deje de recibir esos correos): un handler
`POST /api/correo/baja?d=<payload>&s=<firma>` (la misma URL firmada que ya
lleva `unsubscribeUrl`, verificada con
`mailService.verifySignedLink(url)` — HMAC + expiración, ver "Enlaces
firmados" abajo) que, si la firma es válida y no ha expirado, apaga la(s)
categoría(s) de preferencia correspondientes para ese usuario y responde
`200` sin cuerpo (nunca una redirección ni una página HTML: un cliente de
correo hace el `POST` en segundo plano, no navega ahí). Ese endpoint vive
fuera de este paquete (`packages/mail` no sabe de HTTP), igual que
`POST /api/correo/eventos` para los webhooks de entrega.

### Reintentos y límite de tasa

`RetryPolicy` (backoff exponencial + jitter, `service/retry.ts`): un `429`/
`5xx`/timeout de red reintenta; un `4xx` (remitente inválido, plantilla
rechazada) marca `failed_permanent` sin reintentar — mismo criterio que la
clasificación HTTP de Resend/Postmark. `RateLimiter` (`TokenBucketRateLimiter`
opcional, por destinatario) evita ráfagas hacia una sola dirección.

## Previsualización

```
npm run -w packages/mail preview
```

Renderiza las 16 plantillas con sus datos de ejemplo a
`packages/mail/preview/*.html` (+ `.txt` de la versión texto) y un índice en
`packages/mail/preview/index.html`. Es un GENERADO — no se commitea (ver
`.gitignore` del paquete).

## Variables de entorno

| Variable | Uso | Estado |
|---|---|---|
| `MAIL_PROVIDER` | `resend` \| `postmark` \| `smtp` \| `capture` (default sin ella) | — |
| `RESEND_API_KEY`, `RESEND_EMAIL_DOMAIN` | Adaptador Resend | **PENDIENTE del usuario** |
| `RESEND_WEBHOOK_SECRET` | Verificar firma Svix del webhook de entrega/bounce | **PENDIENTE del usuario** |
| `POSTMARK_SERVER_TOKEN`, `POSTMARK_FROM_ADDRESS` | Adaptador Postmark (alternativa a Resend) | **PENDIENTE del usuario** |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_ADDRESS` | Adaptador SMTP genérico (alternativa) | **PENDIENTE del usuario** |
| `MAIL_CAPTURE_FILE` | Ruta JSONL opcional para `CaptureProvider` en desarrollo | opcional |
| `MAIL_LINK_SECRET` | Llave HMAC de `createLinkSigner` (enlaces de verificación/invitación/baja) | **PENDIENTE del usuario** (≥16 caracteres) |

Sin proveedor real configurado, `createMailProviderFromEnv()` degrada a
`CaptureProvider` (nunca falla, nunca sale a Internet) — mismo criterio que
`correoConfigurado()` en las referencias: ausencia de configuración es un
estado declarado, nunca un fallo silencioso ni un bloqueo del desarrollo.

**Proveedor real de correo: PENDIENTE de que el usuario aporte credenciales**
(dominio verificado con SPF/DKIM en Resend/Postmark, o un SMTP transaccional)
— ver `docs/AMPLIACION-2-SALIDA.md` (bloqueos externos). Los tres adaptadores
están completos y probados con mocks de red; falta únicamente la credencial
real para activarlos.

## Pruebas y cobertura

`npm run -w packages/mail test` corre la suite (Vitest, 24 archivos / 200+
pruebas). `npm run -w packages/mail test:coverage` exige los umbrales de
`vitest.config.ts` (líneas/statements ≥85%, ramas ≥80%, funciones ≥85%).
Cubre: cada plantilla (renderiza, asunto/CTA/pie/baja presentes, HTML válido
para correo — ver `test/support/html-validate-config.ts` para el porqué de
las reglas desactivadas—, esquema válido contra su propio `sampleData`),
contraste básico de la paleta (WCAG AA/AA-mínimo), enlaces firmados
(válido/expirado/manipulado/secreto distinto), los tres proveedores HTTP/SMTP
con mocks de red (429/5xx → retryable, 4xx → permanent), `CaptureProvider`
(memoria + JSONL en disco), preferencias de notificación, lista de supresión
(incluyendo fail-closed), verificación de firma de webhook (Svix) y
`MailService` de punta a punta (idempotencia, reintentos con backoff,
permanente sin reintento, supresión, preferencias, destinatario no
registrado).
