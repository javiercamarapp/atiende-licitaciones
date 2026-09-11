# Agente de voz — ElevenLabs Conversational AI (licitaciones)

REQ-092/REQ-093 (`docs/REQUISITOS.md` §21 "Móvil / Canales"). Rama: `closure/voz-realtime`.
Mismo patrón que los repos hermanos `atiende-hoteles`/`atiende-restaurantes`: ElevenLabs
maneja telefonía + modelo de voz de punta a punta vía su propia plataforma de agentes
conversacionales — nosotros somos el RECEPTOR de sus llamadas de herramienta (tool
webhook), nunca el llamador de su API. No hace falta Twilio ni STT/TTS por separado.

## 0. Principio de esta tarea ("esqueleto honesto")

Todo lo implementado en `apps/api/src/modules/voice/routes.ts` es la llamada HTTP REAL
que ElevenLabs necesita para invocar una tool durante una llamada — no un stub. Se probó
de extremo a extremo (`apps/api/test/voice-webhook.test.ts`, 16 casos, contra Postgres
real vía PGlite) porque en esta dirección **nosotros somos el servidor**: no hace falta
ninguna credencial de ElevenLabs para que esos 16 tests pasen, exactamente igual que
`apps/api/test/mail-webhook.test.ts` no necesita una cuenta real de Resend.

Lo que **NO** se pudo probar, porque no existe cuenta real de ElevenLabs conectada en
este entorno, es el lado de ElevenLabs: la forma exacta del payload de tool-call (se
aceptan las DOS formas documentadas, ver `extractToolParams` en `routes.ts`, pero
ninguna se confirmó contra una llamada real), y sobre todo — el punto más importante que
hay que leer antes de dar por cerrado REQ-093 — **el disclosure de primer turno y la
respuesta fija a "¿eres humano?" no pueden aplicarse con la misma garantía que en
WhatsApp**, porque ElevenLabs es dueño del loop completo de conversación (STT + diálogo +
TTS): este webhook solo se invoca cuando su modelo decide llamar una de las 5 tools, no
en cada turno de voz. Ver §4 para el detalle y el pendiente honesto.

## 1. Qué se auditó antes de escribir código

- `docs/REQUISITOS.md` (REQ-092/REQ-093) y `docs/ACEPTACION.md` (criterio verificable
  literal: *"la palabra 'confirmo' nunca ejecuta la herramienta de fijar precio"*) —
  confirmado que "la herramienta de fijar precio" es `set_final_price`
  (`packages/agents/src/authorization.ts`, `DEFAULT_PROHIBITED_ACTIONS`).
- `docs/BLOQUEOS.md`: confirmado que este ítem NO es B-02 (fuente de datos bloqueada por
  reCAPTCHA) ni B-04 (modelo comercial sin decidir) disfrazado — ninguno de los dos
  bloqueos menciona voz/Realtime; este REQ es una construcción real, no un bloqueo
  externo.
- El patrón YA FUNCIONANDO de `~/Desktop/supabase/hoteles` (`apps/api/src/routes/
  vozElevenlabs.ts`, `packages/agent-core/src/disclosure.ts`,
  `packages/domain-hotel/src/voiceGuardrails.ts`) y su propio `docs/agente-voz/README.md`
  — mismo secreto por tenant, mismo catálogo cerrado, misma comparación en tiempo
  constante del secreto.
- El catálogo real de tools de negocio ya existentes de este repo
  (`apps/worker/src/agents/business-tools.ts`) y el marco de autorización
  (`packages/agents/src/authorization.ts`, `tool-registry.ts`) para asegurar que el
  catálogo expuesto a voz es un subconjunto CERRADO de tools que ya existen y ya están
  probadas, no una reimplementación paralela de la lógica de negocio.

## 2. Qué se construyó

- `packages/agents/src/guardrails/voice.ts` (+ `packages/agents/test/voice-guardrail.test.ts`,
  23 casos): módulo de dominio PURO, reutilizable por cualquier canal futuro (voz hoy,
  WhatsApp si se conecta después) — `classifyVoiceInteraction` detecta (a) "¿eres
  humano?" → respuesta fija, (b) un intento de acción fuera de alcance (fijar precio,
  firmar, actuar en un portal, contactar a un tercero) con o sin la palabra "confirmo",
  y (c) "confirmo" sin ninguna acción sensible adjunta → se registra como intención,
  nunca como ejecución.
- `packages/db/migrations/0111_req092_voice_agent_config.sql`: tabla `voice_agent_config`
  por organización (secreto de webhook + `elevenlabs_agent_id` + `enabled`, apagado por
  default), RLS restringida a `owner`/`admin`.
- `apps/api/src/modules/voice/routes.ts` (+ `schemas.ts`): el webhook público
  (`POST /webhooks/voz/:orgId/:toolName`) para el catálogo cerrado de 5 tools, y 3
  endpoints de configuración (`GET/PATCH /voice/config`, `POST
  /voice/config/rotar-secreto`, staff `owner`/`admin`).
- `apps/api/test/voice-webhook.test.ts`: 16 casos de integración contra Postgres real
  (PGlite), incluidos los adversariales de REQ-092 y el aislamiento cruzado entre
  organizaciones.

## 3. El catálogo de tools (REQ-092: "solo consultas y recordatorios")

| Tool (nombre en la URL)         | Lee/escribe                     | Tabla(s) reales                                    |
|---------------------------------|----------------------------------|-----------------------------------------------------|
| `listar-convocatorias`          | lectura                          | `tenders`                                            |
| `leer-bases`                    | lectura                          | `requirement_items`                                  |
| `leer-perfil-empresa`           | lectura                          | `company_profiles`, `capabilities`                   |
| `resumir-cambios-convocatoria`  | lectura                          | `tender_change_events`                               |
| `programar-recordatorio`        | escritura interna (recordatorio) | `jobs` (`kind: 'send_agent_alert'`, mismo handler que ya consume `apps/worker/src/handlers/send-agent-alert.ts`) |

Deliberadamente **NO** se reimportan las tools de `apps/worker/src/agents/business-tools.ts`
(apps independientes, sin dependencia cruzada — mismo criterio que
`apps/api/src/lib/agent-triggers.ts` documenta para `jobs`): las consultas SQL de arriba
son la MISMA lectura, ejecutada directamente contra las mismas tablas, filtrada
explícitamente por `org_id`.

Ninguna tool de fijar precio (`set_final_price`), firma, actuación en un portal oficial
o contacto con un tercero (`DEFAULT_HARD_PROHIBITED_ACTIONS`/`DEFAULT_PROHIBITED_ACTIONS`
de `authorization.ts`) existe siquiera en este catálogo: es defensa en profundidad — ni
un modelo de voz totalmente comprometido podría invocarlas, sin importar qué diga el
guardrail de `voice.ts`.

## 4. REQ-093 (parcial): lo que SÍ se garantiza en código y lo que queda manual

El disclosure de IA de primer turno y la respuesta fija a "¿eres humano?"
(`DISCLOSURE_MESSAGE_VOZ`/`RESPUESTA_FIJA_ES_HUMANO`, exportados de `@atiende/agents`) ya
tienen una única fuente de verdad versionada en código, y se exponen en
`GET /voice/config` (`disclosureMessage`/`respuestaFijaEsHumano`) para que quien
configure el agente en el dashboard de ElevenLabs los pegue **tal cual** como
"first message"/instrucción del "system prompt". Eso es lo que el código puede
garantizar hoy.

Lo que el código **no** puede garantizar (a diferencia de WhatsApp, donde
`mensajeria.ts` intercepta cada mensaje entrante antes de llamar al LLM): que el modelo
de ElevenLabs efectivamente diga ese texto exacto en cada llamada real. Ese es un paso de
CONFIGURACIÓN del agente en el dashboard de ElevenLabs (manual, ver §5), y solo se puede
verificar de verdad con una llamada real contra una cuenta real — pendiente honesto, no
fingido como "cerrado".

## 5. Runbook manual pendiente (fuera del alcance de código de esta tarea)

1. Crear una cuenta/agente en el dashboard de ElevenLabs Conversational AI.
2. Pegar `disclosureMessage` (de `GET /voice/config`) como "first message" del agente.
3. Incluir `respuestaFijaEsHumano` en las instrucciones de sistema como la respuesta
   obligatoria ante cualquier variante de "¿eres humano?".
4. Registrar las 5 tools del agente, cada una apuntando a
   `POST https://<dominio-real>/webhooks/voz/<orgId>/<tool>` con el header
   `x-atiende-voz-tool-secret: <toolWebhookSecret de esa organización>`.
5. Comprar/portar el número de teléfono real.
6. Activar el canal (`PATCH /voice/config { "habilitado": true }`) solo cuando 1-5 estén
   confirmados — permanece `false` por default (migración 0099).
7. Hacer una llamada real de prueba y verificar manualmente que el disclosure/la
   respuesta fija a "¿eres humano?" en verdad se reproducen — este paso es el único que
   puede cerrar REQ-093 por completo; hasta entonces, la garantía de código cubre el
   guardrail de "confirmo"/acción fuera de alcance (REQ-092) y el catálogo cerrado, no el
   contenido exacto que dirá el modelo de voz en cada turno.

## 6. Suite de pruebas relevante corrida antes de comitear

```bash
cd packages/agents && npx vitest run test/voice-guardrail.test.ts && npx tsc --noEmit
cd apps/api && npx vitest run test/voice-webhook.test.ts && npx tsc --noEmit
cd packages/db && npx vitest run test/migrate.test.ts
npm run typecheck --workspaces --if-present
npm run lint --workspaces --if-present
```
