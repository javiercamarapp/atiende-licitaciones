import { CaptureProvider } from "./capture-provider";
import { createPostmarkProvider } from "./postmark-provider";
import { createResendProvider } from "./resend-provider";
import { createSmtpProvider } from "./smtp-provider";
import type { MailProvider } from "./types";

export type MailProviderKind = "resend" | "postmark" | "smtp" | "capture";

export interface MailEnv {
  MAIL_PROVIDER?: string;
  RESEND_API_KEY?: string;
  RESEND_EMAIL_DOMAIN?: string;
  POSTMARK_SERVER_TOKEN?: string;
  POSTMARK_FROM_ADDRESS?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_SECURE?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_FROM_ADDRESS?: string;
  MAIL_CAPTURE_FILE?: string;
}

function parseKind(raw: string | undefined): MailProviderKind {
  if (raw === "resend" || raw === "postmark" || raw === "smtp" || raw === "capture") return raw;
  // Sin `MAIL_PROVIDER` (o con un valor desconocido), el default es
  // `capture`: nunca se intenta salir a Internet sin que alguien lo haya
  // pedido explícitamente con una variable de entorno reconocida.
  return "capture";
}

/**
 * Arma el `MailProvider` real a partir de variables de entorno. Cada
 * adaptador ya declara `not_configured` si le faltan credenciales, así que
 * esta función nunca lanza por configuración incompleta — el fallo se ve
 * en el primer `send()`, con el mismo criterio que `correoConfigurado()`
 * en la app de referencia: ausencia de configuración es un estado
 * declarado, no un error de arranque.
 */
export function createMailProviderFromEnv(env: MailEnv = process.env as MailEnv): MailProvider {
  const kind = parseKind(env.MAIL_PROVIDER);
  switch (kind) {
    case "resend":
      return createResendProvider({ apiKey: env.RESEND_API_KEY, domain: env.RESEND_EMAIL_DOMAIN });
    case "postmark":
      return createPostmarkProvider({ serverToken: env.POSTMARK_SERVER_TOKEN, fromAddress: env.POSTMARK_FROM_ADDRESS });
    case "smtp":
      return createSmtpProvider({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT ? Number(env.SMTP_PORT) : undefined,
        secure: env.SMTP_SECURE === "true",
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        fromAddress: env.SMTP_FROM_ADDRESS,
      });
    case "capture":
    default:
      return new CaptureProvider({ filePath: env.MAIL_CAPTURE_FILE });
  }
}
