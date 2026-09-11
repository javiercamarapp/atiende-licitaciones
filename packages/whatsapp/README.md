# @atiende/whatsapp

Canal de notificación **y decisión** por WhatsApp de **Atiende
Licitaciones**, vía Meta WhatsApp Business Cloud API. El correo
(`@atiende/mail`) sigue siendo el canal de registro; WhatsApp es **ADICIONAL**
para avisar Y, desde REQ-090, la interfaz de trabajo primaria para DECIDIR
(botones/listas) — nunca para editar la matriz de requisitos ni la
propuesta, que solo se editan en el portal autenticado. Mismo criterio
arquitectónico que `@atiende/mail`: librería TypeScript **pura** (sin base
de datos ni dependencia de `apps/api`/`apps/worker`), solo contratos e
implementaciones en memoria para pruebas.

## REQ-090/074/080: WhatsApp interactivo de doble vía

Estado real (2026-09-10): **puerto + lógica de negocio completos y
probados; `verificado_contra_real=false`** — no hay app de Meta, App
Secret, ni plantilla con botones `QUICK_REPLY` aprobada todavía (bloqueo
externo conocido, ver `docs/BLOQUEOS.md` y REQ-140). Lo que sí es real y
verificable hoy, sin ninguna credencial de Meta:

- **Saliente con decisión** (`OutboundWhatsAppMessage.buttonPayloads`,
  ≤3, REQ-080): una plantilla ya aprobada puede llevar hasta 3 botones
  `QUICK_REPLY` cuyo `payload` se parametriza por envío (el TEXTO del botón
  lo fija Meta al aprobar la plantilla; el `payload` codifica de qué
  decisión concreta se trata, ver `apps/api/src/lib/whatsapp/decision-payload.ts`).
- **Saliente de lista** (`sendInteractiveList`, ≤10 filas EN TOTAL, REQ-080):
  mensaje interactivo LIBRE (no plantilla), solo válido dentro de la
  ventana de 24h que Meta abre cuando el usuario escribió primero — usado
  para elegir un motivo cerrado (nunca texto libre) de una lista corta.
- **Confirmación** (`sendText`): texto libre, también solo dentro de esa
  ventana de 24h, usado exclusivamente para confirmar una decisión ya
  tomada.
- **Webhook entrante** (`src/webhook/`): `parseWhatsAppWebhookPayload`
  (formas reales de Meta: `type:"button"` de una plantilla, o
  `type:"interactive"` con `button_reply`/`list_reply` de un mensaje
  libre), `verifyMetaWebhookSignature` (esquema real `X-Hub-Signature-256`,
  HMAC-SHA256 del cuerpo crudo con el App Secret, hex — DISTINTO del Svix
  de `@atiende/mail`), `WamidReplayGuard` (REQ-074: idempotencia
  PERMANENTE por `wamid`, sin ventana de tiempo — un `wamid` nunca se
  reutiliza) y `resolveWebhookSubscriptionChallenge` (el handshake `GET`
  que Meta exige para activar la URL del webhook).
- **`apps/api`** conecta todo esto a la ÚNICA decisión de negocio real que
  hoy tiene equivalente HTTP (`go_no_go_decisions`, `POST
  /tenders/:id/go-no-go`): tocar "Go" en la plantilla de nuevo match
  decide directo; tocar "No-Go" abre una lista de motivos cerrados; elegir
  una fila decide con ese motivo. Ver
  `apps/api/src/modules/whatsapp/webhook.routes.ts` para el flujo completo,
  incluida la resolución de identidad (`whatsapp_phone_e164` -> usuario ->
  membresía -> rol, NUNCA solo la firma del webhook) y las pruebas
  adversariales en `apps/api/test/whatsapp-webhook.test.ts`.

Lo que falta para pasar a `verificado_contra_real=true` (fuera del alcance
de este paquete, depende de Javier/producto):
1. Dar de alta la app de Meta (WhatsApp Business Platform) y obtener el App
   Secret real -> `WHATSAPP_WEBHOOK_APP_SECRET`.
2. Someter `nuevo_match_licitacion` a revisión de Meta CON dos botones
   `QUICK_REPLY` ("Go" / "No-Go") y esperar su aprobación editorial.
3. Registrar la URL pública de `POST /webhooks/whatsapp` en el panel de la
   app, con un `hub.verify_token` elegido -> `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
4. Una vez con eso: un ciclo E2E real (mandar, tocar el botón de verdad
   desde un teléfono, confirmar que el webhook de Meta llega) para cerrar
   el criterio de aceptación de REQ-090 con evidencia contra el proveedor
   real, no solo contra `CaptureProvider`/`fetchImpl` mockeado.

## Qué NO es este paquete

- No manda WhatsApp por sí solo en producción sin que alguien configure el
  proveedor real (`WHATSAPP_PROVIDER=meta`) por variable de entorno.
- **No hay credenciales reales de Meta disponibles en este entorno.** El
  adaptador de Meta (`createMetaCloudProvider`) está completo y probado con
  `fetchImpl` mockeado, pero nunca se ha llamado a la Cloud API real —
  activarlo queda pendiente de que Javier conecte `WHATSAPP_ACCESS_TOKEN` y
  `WHATSAPP_PHONE_NUMBER_ID` reales.
- No decide CUÁNDO mandar un WhatsApp (qué categorías de notificación lo
  disparan, cómo se combina con las preferencias de correo del usuario, de
  dónde sale el número de teléfono del destinatario) — ese wiring vive en
  `apps/api`, igual que `MailService` vive fuera de `@atiende/mail` para la
  parte de persistencia real.
- No manda texto libre. Ver la sección siguiente.

## La restricción real de la plataforma: solo plantillas pre-aprobadas

La Cloud API de Meta para WhatsApp Business **solo permite iniciar una
conversación** con un número que no le ha escrito a la cuenta de negocio en
las últimas 24 horas mandando un **message template pre-aprobado por Meta**
(revisión editorial de la plantilla completa por Meta, no solo un chequeo
automático). Texto libre arbitrario solo se puede mandar DENTRO de esa
ventana de 24h de "servicio al cliente" — es decir, en respuesta a un
mensaje que el usuario mandó primero.

Los dos disparadores para los que se agregó este canal
(`tender_matches` — nuevo match de convocatoria, `submission` — paquete de
propuesta listo) son avisos **proactivos** del sistema, nunca respuestas
dentro de una conversación que el usuario abrió: por diseño, `@atiende/whatsapp`
solo modela el camino de plantilla (`OutboundWhatsAppMessage.templateName` +
`templateParams`) y **no** ofrece un campo de texto libre — eso fingiría una
capacidad que Meta no da para este caso de uso.

Cada plantilla (nombre, idioma, texto con variables `{{1}}`, `{{2}}`, ...)
se da de alta y se aprueba por separado en el **WhatsApp Manager** de Meta,
fuera de este repo. `templateParams` son los valores para esas variables
posicionales, con las llaves como el número de posición en string (`"1"`,
`"2"`, ...) — ver el comentario de `OutboundWhatsAppMessage` en
`src/provider/types.ts` para el porqué exacto de ese formato.

## Arquitectura

```
src/
  provider/
    types.ts                WhatsAppProvider, OutboundWhatsAppMessage,
                             SendResult (mismo contrato que @atiende/mail,
                             replicado aquí en vez de importado — ver el
                             comentario en el propio archivo para el porqué)
    capture-provider.ts      Guarda en memoria + opcionalmente JSONL en disco
                             (dev/test) — nunca llama a la red
    meta-cloud-provider.ts   fetch directo a graph.facebook.com (sin SDK),
                             timeout 5s, clasificación retryable/permanent
    factory.ts               createWhatsAppProviderFromEnv() —
                             WHATSAPP_PROVIDER decide cuál
```

## Variables de entorno

| Variable | Uso | Estado |
|---|---|---|
| `WHATSAPP_PROVIDER` | `meta` \| `capture` (default sin ella) | — |
| `WHATSAPP_ACCESS_TOKEN` | Token de acceso de la app de Meta (System User o de la cuenta de WhatsApp Business) | **PENDIENTE del usuario** |
| `WHATSAPP_PHONE_NUMBER_ID` | ID del número de teléfono de WhatsApp Business registrado en Meta | **PENDIENTE del usuario** |
| `WHATSAPP_API_VERSION` | Versión de la Graph API (default `v21.0`) | opcional |
| `WHATSAPP_DEFAULT_LANGUAGE` | Código de idioma default para plantillas que no dan el suyo (default `es_MX`) | opcional |
| `WHATSAPP_CAPTURE_FILE` | Ruta JSONL opcional para `CaptureProvider` en desarrollo | opcional |

Sin proveedor real configurado, `createWhatsAppProviderFromEnv()` degrada a
`CaptureProvider` (nunca falla, nunca sale a Internet) — mismo criterio que
`createMailProviderFromEnv()` de `@atiende/mail`: ausencia de configuración
es un estado declarado, nunca un fallo silencioso.

Con `WHATSAPP_PROVIDER=meta` pero sin `WHATSAPP_ACCESS_TOKEN`/
`WHATSAPP_PHONE_NUMBER_ID`, `createMetaCloudProvider` responde
`{ok:false, kind:"not_configured"}` en cada `send()` — nunca lanza al armar
el provider, nunca fabrica un éxito falso.

## Ejemplo de uso

```ts
import { createWhatsAppProviderFromEnv } from "@atiende/whatsapp";

const whatsapp = createWhatsAppProviderFromEnv(process.env);

const result = await whatsapp.send({
  to: "+525512345678", // E.164 — el proveedor de Meta le quita el "+" internamente
  templateName: "nuevo_match_licitacion",
  templateParams: {
    "1": "Suministro de uniformes escolares",
    "2": "18 sep 2026",
  },
});

if (!result.ok && result.kind === "not_configured") {
  // Estado declarado: no hay credenciales de Meta todavía. El canal de
  // correo (@atiende/mail) sigue siendo el canal principal — este resultado
  // nunca debe bloquear el envío por correo.
}
```

## Pruebas

`npm run -w packages/whatsapp test` corre la suite (Vitest): `CaptureProvider`
(memoria + JSONL en disco, nunca llama a la red), `createMetaCloudProvider`
(con `fetchImpl` inyectado: éxito, `not_configured` sin credenciales, 429/5xx
→ `retryable`, 400 → `permanent`, orden posicional de `templateParams`,
`languageCode`/`apiVersion` configurables) y `createWhatsAppProviderFromEnv`
(elige el provider correcto según `WHATSAPP_PROVIDER`, default `capture`).
