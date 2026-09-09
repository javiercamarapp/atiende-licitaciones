# @atiende/whatsapp

Canal de notificación por WhatsApp de **Atiende Licitaciones**, vía Meta
WhatsApp Business Cloud API. Es un canal **ADICIONAL** al correo
(`@atiende/mail`) — nunca lo reemplaza. Mismo criterio arquitectónico que
`@atiende/mail`: librería TypeScript **pura** (sin base de datos ni
dependencia de `apps/api`/`apps/worker`), solo contratos e implementaciones
en memoria para pruebas.

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
