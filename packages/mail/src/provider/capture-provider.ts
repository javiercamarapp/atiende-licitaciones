import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { MailProvider, OutboundEmail, SendResult } from "./types";

export interface CapturedEmail extends OutboundEmail {
  id: string;
  capturedAt: string;
}

export interface CaptureProviderOptions {
  /** Si se da, cada correo capturado se agrega como una línea JSONL a este
   *  archivo (además de guardarse en memoria) — útil para inspeccionar
   *  envíos de un proceso de pruebas E2E fuera del proceso de Node. */
  filePath?: string;
}

/**
 * El "provider" de desarrollo y pruebas: no manda nada por red, guarda cada
 * correo en memoria (y opcionalmente en un JSONL en disco) para que un test
 * o una persona desarrollando puedan inspeccionar exactamente qué se habría
 * enviado. Es el default cuando `MAIL_PROVIDER` no apunta a uno real — así
 * un entorno sin credenciales configuradas nunca intenta salir a Internet
 * por accidente.
 */
export class CaptureProvider implements MailProvider {
  readonly name = "capture";
  private readonly captured: CapturedEmail[] = [];

  constructor(private readonly options: CaptureProviderOptions = {}) {}

  async send(message: OutboundEmail): Promise<SendResult> {
    const record: CapturedEmail = { ...message, id: randomUUID(), capturedAt: new Date().toISOString() };
    this.captured.push(record);
    if (this.options.filePath) {
      mkdirSync(dirname(this.options.filePath), { recursive: true });
      appendFileSync(this.options.filePath, `${JSON.stringify(record)}\n`, "utf8");
    }
    return { ok: true, providerMessageId: record.id };
  }

  /** Copia de lo capturado hasta ahora, en orden de envío. */
  list(): CapturedEmail[] {
    return [...this.captured];
  }

  /** El último correo capturado que coincide con un asunto o destinatario,
   *  o `undefined` si no hay ninguno — conveniencia para pruebas. */
  findLastTo(email: string): CapturedEmail | undefined {
    return [...this.captured].reverse().find((c) => c.to.includes(email));
  }

  clear(): void {
    this.captured.length = 0;
  }
}
