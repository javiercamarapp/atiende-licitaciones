import { CaptureProvider } from "./capture-provider";
import { createMetaCloudProvider } from "./meta-cloud-provider";
import type { WhatsAppProvider } from "./types";

export type WhatsAppProviderKind = "meta" | "capture";

export interface WhatsAppEnv {
  WHATSAPP_PROVIDER?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_API_VERSION?: string;
  WHATSAPP_DEFAULT_LANGUAGE?: string;
  WHATSAPP_CAPTURE_FILE?: string;
}

function parseKind(raw: string | undefined): WhatsAppProviderKind {
  if (raw === "meta" || raw === "capture") return raw;
  // Sin `WHATSAPP_PROVIDER` (o con un valor desconocido), el default es
  // `capture`: mismo criterio que `createMailProviderFromEnv` de
  // `@atiende/mail` — nunca se intenta salir a Internet (y mucho menos a la
  // Cloud API de Meta, con credenciales que hoy no existen en este entorno)
  // sin que alguien lo haya pedido explícitamente con una variable de
  // entorno reconocida.
  return "capture";
}

/**
 * Arma el `WhatsAppProvider` real a partir de variables de entorno. El
 * adaptador de Meta ya declara `not_configured` si le faltan credenciales,
 * así que esta función nunca lanza por configuración incompleta — el fallo
 * se ve en el primer `send()`, mismo criterio que
 * `createMailProviderFromEnv` de `@atiende/mail`.
 */
export function createWhatsAppProviderFromEnv(env: WhatsAppEnv = process.env as WhatsAppEnv): WhatsAppProvider {
  const kind = parseKind(env.WHATSAPP_PROVIDER);
  switch (kind) {
    case "meta":
      return createMetaCloudProvider({
        accessToken: env.WHATSAPP_ACCESS_TOKEN,
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
        apiVersion: env.WHATSAPP_API_VERSION,
        defaultLanguageCode: env.WHATSAPP_DEFAULT_LANGUAGE,
      });
    case "capture":
    default:
      return new CaptureProvider({ filePath: env.WHATSAPP_CAPTURE_FILE });
  }
}
