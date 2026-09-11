import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { validateButtonPayloads, validateInteractiveListMessage } from "./content-limits";
import type { OutboundInteractiveListMessage, OutboundWhatsAppMessage, SendResult, WhatsAppProvider } from "./types";

export interface CapturedWhatsAppMessage extends OutboundWhatsAppMessage {
  id: string;
  capturedAt: string;
}

export interface CapturedInteractiveListMessage extends OutboundInteractiveListMessage {
  id: string;
  capturedAt: string;
}

export interface CapturedTextMessage {
  id: string;
  to: string;
  body: string;
  capturedAt: string;
}

export interface CaptureProviderOptions {
  /** Si se da, cada mensaje capturado se agrega como una línea JSONL a este
   *  archivo (además de guardarse en memoria) — mismo patrón que
   *  `CaptureProvider` de `@atiende/mail`, útil para inspeccionar envíos de
   *  un proceso de pruebas E2E fuera del proceso de Node. */
  filePath?: string;
}

/**
 * El adaptador de desarrollo y pruebas: nunca llama a la Cloud API de Meta.
 * Guarda cada mensaje "enviado" en memoria (y opcionalmente en un JSONL en
 * disco) para que un test o una persona desarrollando puedan inspeccionar
 * exactamente qué se habría mandado. Es el default cuando `WHATSAPP_PROVIDER`
 * no apunta a `"meta"` — mismo criterio de seguridad que `CaptureProvider`
 * de `@atiende/mail`: un entorno sin credenciales configuradas nunca intenta
 * salir a Internet por accidente, y nunca hay credenciales reales de Meta
 * disponibles en este repo todavía.
 *
 * Es el `FakeWhatsappAdapter` de este repo (mismo rol que su equivalente en
 * atiende-hoteles): implementa el mismo `WhatsAppProvider` real que
 * `MetaCloudProvider`, nunca simula el resultado de la lógica de negocio que
 * lo usa (esa vive en `apps/api`, fuera de este paquete) — solo reemplaza el
 * borde externo (la llamada de red a Meta).
 */
export class CaptureProvider implements WhatsAppProvider {
  readonly name = "capture";
  private readonly captured: CapturedWhatsAppMessage[] = [];
  private readonly capturedLists: CapturedInteractiveListMessage[] = [];
  private readonly capturedTexts: CapturedTextMessage[] = [];

  constructor(private readonly options: CaptureProviderOptions = {}) {}

  async send(message: OutboundWhatsAppMessage): Promise<SendResult> {
    // REQ-080: el mismo contrato de límites de contenido aplica sin importar
    // el proveedor — un mensaje que `MetaCloudProvider` rechazaría también
    // lo rechaza este adaptador de pruebas, para que un test escrito contra
    // `CaptureProvider` detecte la misma violación que produciría en real.
    const buttonsCheck = validateButtonPayloads(message.buttonPayloads);
    if (!buttonsCheck.ok) return { ok: false, kind: "permanent", detail: buttonsCheck.detail };

    const record: CapturedWhatsAppMessage = { ...message, id: randomUUID(), capturedAt: new Date().toISOString() };
    this.captured.push(record);
    this.appendJsonl(record);
    return { ok: true, providerMessageId: record.id };
  }

  async sendInteractiveList(message: OutboundInteractiveListMessage): Promise<SendResult> {
    const check = validateInteractiveListMessage(message);
    if (!check.ok) return { ok: false, kind: "permanent", detail: check.detail };

    const record: CapturedInteractiveListMessage = { ...message, id: randomUUID(), capturedAt: new Date().toISOString() };
    this.capturedLists.push(record);
    this.appendJsonl(record);
    return { ok: true, providerMessageId: record.id };
  }

  async sendText(to: string, body: string): Promise<SendResult> {
    const record: CapturedTextMessage = { to, body, id: randomUUID(), capturedAt: new Date().toISOString() };
    this.capturedTexts.push(record);
    this.appendJsonl(record);
    return { ok: true, providerMessageId: record.id };
  }

  private appendJsonl(record: unknown): void {
    if (!this.options.filePath) return;
    mkdirSync(dirname(this.options.filePath), { recursive: true });
    appendFileSync(this.options.filePath, `${JSON.stringify(record)}\n`, "utf8");
  }

  /** Copia de lo capturado hasta ahora, en orden de envío (mensajes de plantilla). */
  list(): CapturedWhatsAppMessage[] {
    return [...this.captured];
  }

  /** El último mensaje capturado dirigido a un número, o `undefined` si no
   *  hay ninguno — conveniencia para pruebas. */
  findLastTo(to: string): CapturedWhatsAppMessage | undefined {
    return [...this.captured].reverse().find((c) => c.to === to);
  }

  /** Copia de las listas interactivas capturadas hasta ahora, en orden de envío. */
  listInteractiveLists(): CapturedInteractiveListMessage[] {
    return [...this.capturedLists];
  }

  /** La última lista interactiva capturada dirigida a un número, o `undefined`. */
  findLastInteractiveListTo(to: string): CapturedInteractiveListMessage | undefined {
    return [...this.capturedLists].reverse().find((c) => c.to === to);
  }

  /** Copia de los textos libres capturados hasta ahora, en orden de envío. */
  listTexts(): CapturedTextMessage[] {
    return [...this.capturedTexts];
  }

  /** El último texto libre capturado dirigido a un número, o `undefined`. */
  findLastTextTo(to: string): CapturedTextMessage | undefined {
    return [...this.capturedTexts].reverse().find((c) => c.to === to);
  }

  clear(): void {
    this.captured.length = 0;
    this.capturedLists.length = 0;
    this.capturedTexts.length = 0;
  }
}
