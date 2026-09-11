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
  /**
   * REQ-090/REQ-044 (doble confirmación, 1/2 técnica-legal vía WhatsApp con
   * máx. 3 botones): payloads posicionales (índice 0, 1, 2...) para los
   * componentes `QUICK_REPLY` que la plantilla YA tiene aprobados en el
   * WhatsApp Manager de Meta — el TEXTO de cada botón lo fija Meta al
   * aprobar la plantilla (fuera de este repo); esto SOLO manda el `payload`
   * (el identificador que el webhook entrante recibirá de vuelta en
   * `messages[].button.payload` cuando alguien lo toque, ver
   * `./webhook/parse-payload.ts`) de forma dinámica por envío — Meta sí
   * permite parametrizar el `payload` de un botón `quick_reply` por
   * mensaje, a diferencia del texto del botón, que es fijo por plantilla.
   * `undefined`/`[]` manda la plantilla sin botones (compatibilidad con las
   * plantillas existentes que no los tienen). Ver `MAX_QUICK_REPLY_BUTTONS`
   * en `./content-limits.ts` para el límite real de la plataforma (REQ-080).
   */
  buttonPayloads?: string[];
}

/** Una fila seleccionable de una lista interactiva (REQ-090/080). */
export interface InteractiveListRow {
  /** Identificador que el webhook entrante recibirá de vuelta en
   *  `messages[].interactive.list_reply.id` cuando el usuario elija esta
   *  fila — este paquete no le da ningún significado, es responsabilidad de
   *  quien arma la lista codificar aquí lo que necesite (ver
   *  `apps/api/src/lib/whatsapp/decision-payload.ts`). */
  id: string;
  title: string;
  description?: string;
}

export interface InteractiveListSection {
  title?: string;
  rows: InteractiveListRow[];
}

/**
 * Mensaje interactivo de lista, LIBRE (no plantilla) — solo válido dentro de
 * la ventana de 24h de "servicio al cliente" que Meta abre cuando el número
 * de destino nos escribió primero (ver README §La restricción real de la
 * plataforma). A diferencia de `OutboundWhatsAppMessage`, este SÍ es texto
 * arbitrario definido por nosotros, porque Meta lo permite en ese contexto
 * concreto: una respuesta dentro de una conversación que el usuario abrió,
 * nunca un aviso proactivo. Quien arma este mensaje es responsable de haber
 * verificado que está respondiendo dentro de esa ventana (en la práctica:
 * solo se manda desde el webhook entrante, en reacción a un mensaje que
 * ACABA de llegar).
 */
export interface OutboundInteractiveListMessage {
  to: string;
  bodyText: string;
  /** Texto del botón que despliega la lista (p. ej. "Elegir razón"). */
  buttonText: string;
  sections: InteractiveListSection[];
  footerText?: string;
}

export interface WhatsAppProvider {
  readonly name: string;
  send(message: OutboundWhatsAppMessage): Promise<SendResult>;
  /** REQ-090/080: lista interactiva (≤10 filas en total, ver `./content-limits.ts`). */
  sendInteractiveList(message: OutboundInteractiveListMessage): Promise<SendResult>;
  /**
   * Texto libre — SOLO válido dentro de la ventana de 24h abierta por un
   * mensaje entrante (ver docstring de `OutboundInteractiveListMessage`).
   * Usado exclusivamente para confirmar una decisión ya tomada por botón o
   * lista (`apps/api/src/modules/whatsapp/webhook.routes.ts`) — NUNCA por
   * los disparadores proactivos (`tender_matches`/`submission`), que siguen
   * modelados solo con `send()` (plantilla). Fingir esta capacidad fuera de
   * una respuesta real sería mandar texto libre proactivo, algo que Meta no
   * permite para este caso de uso (ver README).
   */
  sendText(to: string, body: string): Promise<SendResult>;
}
