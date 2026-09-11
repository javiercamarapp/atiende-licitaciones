# @atiende/webhooks

Verificación de firma **HMAC** y deduplicación por **`event_id`** genéricas
para **cualquier webhook entrante** de Atiende Licitaciones (REQ-096).
Mismo criterio arquitectónico que `@atiende/mail`/`@atiende/whatsapp`:
librería TypeScript **pura** (sin base de datos, sin Fastify, sin
dependencia de `apps/api`/`apps/worker`), solo contratos + una
implementación en memoria para pruebas.

## Por qué existe

Antes de este paquete, la única verificación HMAC de webhooks entrantes del
repo vivía **duplicada dentro de `@atiende/mail`**
(`packages/mail/src/webhooks/verify-signature.ts`), acoplada al esquema
Svix de Resend (`svix-id`/`svix-timestamp`/`svix-signature`, secreto
`whsec_<base64>`, contenido firmado `"${id}.${timestamp}.${body}"`). Un
webhook entrante nuevo (WhatsApp/Meta, Stripe, o el que sea) habría tenido
que reimplementar desde cero la parte realmente delicada: comparar el HMAC
en tiempo constante, decodificar bien la codificación del candidato,
aplicar la ventana de tiempo, y sobre todo el orden correcto de
"solo reclamar el `event_id` del guardia de replay si la firma YA fue
válida" — exactamente el tipo de lógica de seguridad que no se quiere
escribir dos veces ni revisar dos veces.

Este paquete extrae esa parte común. `@atiende/mail` ahora la CONSUME
(`verifyResendWebhookSignature` es un adaptador delgado sobre
`verifyHmacWebhookSignature` que solo aporta lo específico de
Resend/Svix: nombres de cabecera, cómo separar varias firmas por espacio,
cómo decodificar el secreto `whsec_`), y `apps/api/src/lib/webhooks/hmac-webhook-guard.ts`
la expone como middleware de Fastify listo para envolver la ruta de
CUALQUIER webhook nuevo sin repetir el flujo de comprobaciones.

## Qué SÍ generaliza este paquete

- **`matchesAnyHmacSignature`** (`src/hmac.ts`): dado un contenido firmado,
  una lista de candidatos de firma (ya extraídos del header, en hex o
  base64) y un secreto, ¿coincide alguno en tiempo constante? Sirve para
  cualquier esquema HMAC-SHA256, tenga o no rotación de secreto (varias
  firmas a la vez) y use el header que use.
- **`WebhookReplayGuard`** (`src/replay-guard.ts`): el contrato de
  deduplicación por `event_id`, con `InMemoryWebhookReplayGuard` para
  pruebas — el mismo contrato que ya implementaba `PgWebhookReplayGuard` de
  `apps/api` para el webhook de correo, ahora nombrado de forma genérica
  (`eventId`, no `svixId`).
- **`verifyHmacWebhookSignature`** (`src/verify.ts`): compone las tres
  comprobaciones en el orden correcto (ventana de tiempo → firma → replay)
  y devuelve un resultado tipado (`ok` / motivo de rechazo).

## Qué NO generaliza (a propósito) — es responsabilidad de cada adaptador

- **Qué cabeceras existen y cuáles son obligatorias.** Cada proveedor tiene
  las suyas; decidir qué cuenta como "cabeceras incompletas" es específico
  de cada esquema.
- **Cómo se separan los candidatos de firma de un header** (un solo valor,
  varios separados por espacio con prefijo `v1,`, un prefijo `sha256=`,
  etc.) y **cómo se decodifica el secreto** (texto plano, `whsec_<base64>`,
  hex, …). Eso es exactamente lo que hace único a cada webhook.
- **Namespacing de `event_id` entre proveedores distintos.** Dos webhooks
  de proveedores diferentes que por coincidencia usaran el mismo id de
  evento NO deben contar como replay entre sí — quien instancie el
  `WebhookReplayGuard` real (normalmente `apps/api`, contra una tabla
  Postgres) es quien debe namespacear (`"resend:msg_123"`, por ejemplo, o
  una columna `provider` en la tabla).
- **Transporte HTTP** (status codes, logging, parseo del cuerpo crudo). Eso
  vive en `apps/api/src/lib/webhooks/hmac-webhook-guard.ts`, que sí depende
  de Fastify y de los `AppError` de la API.

## Cómo usarlo para un webhook nuevo

```ts
import { verifyHmacWebhookSignature, type WebhookReplayGuard } from "@atiende/webhooks";

const result = await verifyHmacWebhookSignature({
  rawBody,                    // el cuerpo CRUDO, nunca un JSON.parse + re-serializado
  eventId,                    // el id de entrega del proveedor
  signatureCandidates,        // ya extraídos del header de firma de ese proveedor
  secret,                     // Buffer ya decodificado
  buildSignedContent: (body, id) => `${id}.${body}`, // según el esquema del proveedor
  encoding: "hex",            // o "base64", según el proveedor
  timestampSeconds,           // opcional: si el proveedor no manda timestamp, se omite
  replayGuard,                // opcional: un WebhookReplayGuard real (Postgres/Redis) para deduplicar
});
```

En `apps/api`, la forma recomendada es `createHmacWebhookGuard` (ver
`apps/api/src/lib/webhooks/hmac-webhook-guard.ts`), que además aplica el
fallo cerrado si falta el secreto configurado y traduce el resultado a
`401`/`409`/`503` como ya hacía `POST /webhooks/mail/:provider`.
