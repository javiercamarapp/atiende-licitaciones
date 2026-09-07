import { classifyHttpStatus, DEFAULT_PROVIDER_TIMEOUT_MS, type MailProvider, type OutboundEmail, type SendResult } from "./types";

export interface ResendProviderOptions {
  apiKey: string | undefined;
  /** Dominio verificado en Resend (p. ej. `mail.atiende.mx`). Se usa un
   *  subdominio y no el raíz para aislar la reputación de envío. */
  domain: string | undefined;
  /** Parte local por defecto del remitente si el llamador no da una. */
  defaultFromLocalPart?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const API = "https://api.resend.com/emails";

/**
 * Adaptador de Resend por HTTP directo (sin el SDK): son tres llamadas
 * `fetch` — meter una dependencia al bundle para ahorrarse veinte líneas no
 * vale la pena. No reintenta por sí mismo: eso es responsabilidad de
 * `MailService`, que sabe cuántas veces ya se intentó un `messageKey`.
 */
export function createResendProvider(options: ResendProviderOptions): MailProvider {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: "resend",
    async send(message: OutboundEmail): Promise<SendResult> {
      if (!options.apiKey || !options.domain) {
        return { ok: false, kind: "not_configured" };
      }
      const from = `Atiende Licitaciones <${message.fromLocalPart ?? options.defaultFromLocalPart ?? "avisos"}@${options.domain}>`;
      try {
        const response = await fetchImpl(API, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            ...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey } : {}),
          },
          body: JSON.stringify({
            from,
            to: message.to,
            subject: message.subject,
            html: message.html,
            text: message.text,
            ...(message.headers ? { headers: message.headers } : {}),
            ...(message.attachments?.length
              ? {
                  attachments: message.attachments.map((a) => ({
                    filename: a.filename,
                    content: a.content,
                    content_id: a.contentId,
                    content_disposition: a.disposition ?? "attachment",
                  })),
                }
              : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).slice(0, 200);
          return { ok: false, kind: classifyHttpStatus(response.status), statusCode: response.status, detail: detail || `HTTP ${response.status}` };
        }

        const json = (await response.json().catch(() => null)) as { id?: string } | null;
        return { ok: true, providerMessageId: json?.id ?? "" };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, kind: "retryable", detail };
      }
    },
  };
}
