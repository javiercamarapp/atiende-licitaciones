import nodemailer, { type Transporter } from "nodemailer";
import type { MailProvider, OutboundEmail, SendResult } from "./types";

export interface SmtpProviderOptions {
  host: string | undefined;
  port: number | undefined;
  secure?: boolean;
  user: string | undefined;
  pass: string | undefined;
  fromAddress: string | undefined;
  /** Se inyecta en pruebas para no abrir una conexión SMTP real. */
  transporterFactory?: (options: Omit<SmtpProviderOptions, "transporterFactory">) => Transporter;
}

/**
 * SMTP genérico vía `nodemailer` — el proveedor de reserva cuando no hay
 * Resend ni Postmark (p. ej. el SMTP transaccional que ya trae el hosting).
 *
 * Los códigos SMTP van AL REVÉS de HTTP: 4xx es un rechazo TEMPORAL
 * (buzón lleno, límite de tasa del servidor destino — vale la pena
 * reintentar) y 5xx es DEFINITIVO (dirección inexistente, dominio
 * rechazado). `classifySmtpCode` refleja exactamente eso.
 */
export function classifySmtpCode(code: number | undefined): "retryable" | "permanent" {
  if (code === undefined) return "retryable";
  if (code >= 400 && code < 500) return "retryable";
  if (code >= 500) return "permanent";
  return "retryable";
}

interface NodemailerError extends Error {
  responseCode?: number;
  code?: string;
}

export function createSmtpProvider(options: SmtpProviderOptions): MailProvider {
  return {
    name: "smtp",
    async send(message: OutboundEmail): Promise<SendResult> {
      if (!options.host || !options.port || !options.fromAddress) {
        return { ok: false, kind: "not_configured" };
      }
      const transporter =
        options.transporterFactory?.(options) ??
        nodemailer.createTransport({
          host: options.host,
          port: options.port,
          secure: options.secure ?? options.port === 465,
          auth: options.user && options.pass ? { user: options.user, pass: options.pass } : undefined,
        });

      try {
        const info = await transporter.sendMail({
          from: options.fromAddress,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          headers: message.headers,
          attachments: message.attachments?.map((a) => ({
            filename: a.filename,
            content: a.content,
            encoding: "base64" as const,
            contentType: a.contentType,
            cid: a.disposition === "inline" ? a.contentId : undefined,
          })),
        });
        return { ok: true, providerMessageId: info.messageId ?? "" };
      } catch (error) {
        const err = error as NodemailerError;
        const kind = classifySmtpCode(err.responseCode);
        return { ok: false, kind, statusCode: err.responseCode, detail: err.message };
      }
    },
  };
}
