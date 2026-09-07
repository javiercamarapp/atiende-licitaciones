import { classifyHttpStatus, type OutboundWhatsAppMessage, type SendResult, type WhatsAppProvider } from "./types";

export interface MetaCloudProviderOptions {
  accessToken: string | undefined;
  phoneNumberId: string | undefined;
  /** Versión de la Graph API de Meta (p. ej. `"v21.0"`). Default `"v21.0"` —
   *  Meta deprecia versiones con un calendario público; fijarla explícita
   *  (en vez de dejar que Meta resuelva la "última") evita que un cambio de
   *  comportamiento de la API llegue sin aviso un día cualquiera. */
  apiVersion?: string;
  /** Código de idioma por default para plantillas que no dan el suyo propio
   *  en `OutboundWhatsAppMessage.languageCode`. Default `"es_MX"`. */
  defaultLanguageCode?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_API_VERSION = "v21.0";
const DEFAULT_LANGUAGE_CODE = "es_MX";

/** Meta exige el número sin el signo `+` (p. ej. `"525512345678"`, no
 *  `"+525512345678"`) en el campo `to` del payload — el contrato público de
 *  este paquete (`OutboundWhatsAppMessage.to`) sigue siendo E.164 con `+`
 *  porque es el formato estándar que ya usa el resto del repo (validación,
 *  almacenamiento); esta función es la única que conoce la particularidad
 *  del endpoint de Meta. */
function toMetaPhoneFormat(e164: string): string {
  return e164.startsWith("+") ? e164.slice(1) : e164;
}

/** Ordena `templateParams` por su llave numérica ("1", "2", "3", ...) para
 *  construir el arreglo posicional que exige `template.components[].parameters`
 *  de Meta — ver el comentario de `OutboundWhatsAppMessage.templateParams`
 *  en `./types` para el porqué de este formato. Una llave no numérica se
 *  ordena al final, en el orden en que `Object.entries` la haya dado (mejor
 *  esfuerzo: en la práctica el llamador siempre debe usar llaves "1".."n"). */
function buildTemplateParameters(templateParams: Record<string, string>): Array<{ type: "text"; text: string }> {
  const entries = Object.entries(templateParams);
  entries.sort(([a], [b]) => {
    const na = Number(a);
    const nb = Number(b);
    const aIsNum = Number.isFinite(na);
    const bIsNum = Number.isFinite(nb);
    if (aIsNum && bIsNum) return na - nb;
    if (aIsNum) return -1;
    if (bIsNum) return 1;
    return a.localeCompare(b);
  });
  return entries.map(([, value]) => ({ type: "text" as const, text: value }));
}

/**
 * Adaptador REAL de Meta WhatsApp Business Cloud API — `POST
 * https://graph.facebook.com/{version}/{phone-number-id}/messages` con
 * `Authorization: Bearer {access-token}` y un payload `type: "template"`.
 * Mismo patrón que `createResendProvider` de `@atiende/mail`: `fetch`
 * directo (sin SDK del proveedor), timeout explícito, y la misma
 * clasificación retryable/permanent de códigos HTTP (`classifyHttpStatus`
 * de `./types`, replicada del criterio de `@atiende/mail` — ver el
 * comentario de `SendResult` en `./types` para el porqué de replicar en vez
 * de importar — 429/5xx son transitorios, el resto de los 4xx son un
 * rechazo definitivo del payload o la configuración, igual en Meta que en
 * un proveedor de correo).
 *
 * NUNCA falsifica un envío exitoso: si faltan `accessToken`/`phoneNumberId`
 * devuelve `{ok:false, kind:"not_configured"}` sin lanzar y sin tocar la
 * red — no hay credenciales reales de Meta disponibles en este entorno
 * todavía (pendientes de que Javier las conecte), así que este camino es el
 * único que puede ejercitarse hoy fuera de pruebas con `fetchImpl` mockeado.
 */
export function createMetaCloudProvider(options: MetaCloudProviderOptions): WhatsAppProvider {
  const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
  const defaultLanguageCode = options.defaultLanguageCode ?? DEFAULT_LANGUAGE_CODE;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: "meta",
    async send(message: OutboundWhatsAppMessage): Promise<SendResult> {
      if (!options.accessToken || !options.phoneNumberId) {
        return { ok: false, kind: "not_configured" };
      }
      const url = `https://graph.facebook.com/${apiVersion}/${options.phoneNumberId}/messages`;
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: toMetaPhoneFormat(message.to),
            type: "template",
            template: {
              name: message.templateName,
              language: { code: message.languageCode ?? defaultLanguageCode },
              components: [
                {
                  type: "body",
                  parameters: buildTemplateParameters(message.templateParams),
                },
              ],
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).slice(0, 200);
          return { ok: false, kind: classifyHttpStatus(response.status), statusCode: response.status, detail: detail || `HTTP ${response.status}` };
        }

        const json = (await response.json().catch(() => null)) as { messages?: Array<{ id?: string }> } | null;
        return { ok: true, providerMessageId: json?.messages?.[0]?.id ?? "" };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, kind: "retryable", detail };
      }
    },
  };
}
