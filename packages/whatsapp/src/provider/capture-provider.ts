import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { OutboundWhatsAppMessage, SendResult, WhatsAppProvider } from "./types";

export interface CapturedWhatsAppMessage extends OutboundWhatsAppMessage {
  id: string;
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
 */
export class CaptureProvider implements WhatsAppProvider {
  readonly name = "capture";
  private readonly captured: CapturedWhatsAppMessage[] = [];

  constructor(private readonly options: CaptureProviderOptions = {}) {}

  async send(message: OutboundWhatsAppMessage): Promise<SendResult> {
    const record: CapturedWhatsAppMessage = { ...message, id: randomUUID(), capturedAt: new Date().toISOString() };
    this.captured.push(record);
    if (this.options.filePath) {
      mkdirSync(dirname(this.options.filePath), { recursive: true });
      appendFileSync(this.options.filePath, `${JSON.stringify(record)}\n`, "utf8");
    }
    return { ok: true, providerMessageId: record.id };
  }

  /** Copia de lo capturado hasta ahora, en orden de envío. */
  list(): CapturedWhatsAppMessage[] {
    return [...this.captured];
  }

  /** El último mensaje capturado dirigido a un número, o `undefined` si no
   *  hay ninguno — conveniencia para pruebas. */
  findLastTo(to: string): CapturedWhatsAppMessage | undefined {
    return [...this.captured].reverse().find((c) => c.to === to);
  }

  clear(): void {
    this.captured.length = 0;
  }
}
