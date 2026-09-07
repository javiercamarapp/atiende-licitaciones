// `SendResult` está REPLICADO aquí, a propósito, en vez de importado de
// `@atiende/mail` — mismo contrato exacto (éxito con id del proveedor,
// `not_configured` como estado declarado, `retryable`/`permanent` para
// decidir si reintentar), pero NO reexportado desde allá. Se intentó
// primero `import type { SendResult } from "@atiende/mail"`: aunque el tipo
// en sí no depende de React, el ÚNICO punto de entrada público de
// `@atiende/mail` es `src/index.ts`, que también reexporta las 16
// plantillas JSX (`templates/catalog/*.tsx`) — `@atiende/mail` no expone
// `provider/types` como subruta aislada en su `package.json#exports`. El
// resultado real, verificado con `tsc --noEmit` en este paquete: el
// compilador de `@atiende/whatsapp` (que correctamente NO tiene `jsx`
// configurado — este paquete no usa React) sigue el grafo de imports hasta
// esos `.tsx` y falla con `TS6142 (--jsx is not set)` en 30+ archivos ajenos
// al tipo que en realidad se necesitaba. Configurar `jsx`/`react-jsx` +
// `react`/`react-dom` aquí solo para aislar un tipo sería acoplar el build
// de un paquete sin UI al toolchain de plantillas de correo. Se decidió
// replicar el contrato en vez de forzar esa dependencia — si alguna vez
// `@atiende/mail` agrega una subruta `"./provider"` a sus `exports` que NO
// arrastre los `.tsx`, este archivo puede volver a importar desde allá sin
// romper nada del lado que consume `WhatsAppProvider`.
export type SendResult =
  | { ok: true; providerMessageId: string }
  /** No hay credenciales configuradas: un estado declarado, no un fallo
   *  silencioso — igual que en `@atiende/mail`. */
  | { ok: false; kind: "not_configured" }
  /** 429/5xx/timeout de red: vale la pena reintentar. */
  | { ok: false; kind: "retryable"; statusCode?: number; detail: string }
  /** 4xx (plantilla no aprobada, número inválido, payload rechazado):
   *  reintentar no cambia el resultado. */
  | { ok: false; kind: "permanent"; statusCode?: number; detail: string };

/** Clasifica un código HTTP en `retryable`/`permanent` — mismo criterio que
 *  `classifyHttpStatus` de `@atiende/mail` (replicado por la misma razón
 *  documentada arriba para `SendResult`): 429 y 5xx son transitorios, el
 *  resto de los 4xx son un rechazo definitivo del payload o la
 *  configuración. */
export function classifyHttpStatus(status: number): "retryable" | "permanent" {
  if (status === 429) return "retryable";
  if (status >= 500) return "retryable";
  return "permanent";
}

/**
 * Un mensaje saliente de WhatsApp vía Meta Business Cloud API.
 *
 * RESTRICCIÓN REAL DE LA PLATAFORMA (no un límite de este código): la Cloud
 * API de Meta para WhatsApp Business SOLO permite iniciar una conversación
 * con un número que no te ha escrito en las últimas 24 horas mandando un
 * "message template" PRE-APROBADO por Meta (revisión editorial de la
 * plantilla completa, no solo del texto libre) — nunca texto arbitrario.
 * Dentro de esa ventana de 24h de "servicio al cliente" sí se puede mandar
 * texto libre, pero ese caso NO es el que resuelve este adaptador: los dos
 * disparadores que lo usan (`tender_matches`, `submission`) son avisos
 * proactivos del sistema, no respuestas dentro de una conversación abierta
 * por el usuario, así que siempre caen en el camino de plantilla. Por eso
 * `OutboundWhatsAppMessage` modela `templateName` + `templateParams` y no
 * un campo de texto libre: ofrecer un campo de texto libre aquí sería
 * fingir una capacidad que Meta no da para este caso de uso.
 */
export interface OutboundWhatsAppMessage {
  /** Número en formato E.164, con el signo `+` (p. ej. `"+525512345678"`).
   *  `MetaCloudProvider` es quien decide cómo transformarlo al formato que
   *  espera el endpoint de Meta (sin `+`) — este tipo es el contrato con el
   *  llamador, no el formato de la petición HTTP. */
  to: string;
  /** Nombre exacto de la plantilla tal como está dada de alta y aprobada en
   *  el WhatsApp Manager de Meta (p. ej. `"nuevo_match_licitacion"`). Un
   *  nombre que no exista o no esté aprobado responde con un 4xx de Meta —
   *  `MetaCloudProvider` lo clasifica como `permanent` (reintentar no lo
   *  arregla; hace falta corregir el nombre o esperar la aprobación). */
  templateName: string;
  /** Valores para las variables posicionales del cuerpo de la plantilla.
   *  Las llaves son el número de posición como string ("1", "2", "3", ...),
   *  igual que Meta nombra sus placeholders `{{1}}`, `{{2}}`, `{{3}}` en el
   *  cuerpo aprobado de la plantilla — nunca el nombre semántico de la
   *  variable, porque Meta no lo conoce. Usamos `Record<string, string>` en
   *  vez de un arreglo para que el llamador arme el mensaje sin tener que
   *  llevar la cuenta manual del orden; `MetaCloudProvider` ordena por la
   *  llave numérica antes de mandarlo (el orden de iteración de un objeto
   *  no está garantizado para llaves no numéricas, y Meta exige el orden
   *  posicional exacto). Ejemplo: `{ "1": "Suministro de uniformes", "2":
   *  "18 sep 2026" }` para una plantilla `"Nuevo match: {{1}}, cierra el
   *  {{2}}"`. */
  templateParams: Record<string, string>;
  /** Código de idioma de la plantilla aprobada (p. ej. `"es_MX"`), tal como
   *  Meta lo exige en `template.language.code` — cada plantilla se aprueba
   *  en uno o más idiomas específicos y hay que declarar cuál se está
   *  usando. Opcional aquí porque casi todas las plantillas de Atiende se
   *  aprueban solo en español de México: si se omite, `MetaCloudProvider`
   *  usa `defaultLanguageCode` (default `"es_MX"`). */
  languageCode?: string;
}

export interface WhatsAppProvider {
  readonly name: string;
  send(message: OutboundWhatsAppMessage): Promise<SendResult>;
}
