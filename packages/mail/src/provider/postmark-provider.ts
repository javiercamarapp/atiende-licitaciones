import { classifyHttpStatus, DEFAULT_PROVIDER_TIMEOUT_MS, type MailProvider, type OutboundEmail, type SendResult } from "./types";

export interface PostmarkProviderOptions {
  serverToken: string | undefined;
  /** Dirección de remitente verificada en Postmark (correo completo). */
  fromAddress: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const API = "https://api.postmarkapp.com/email";

export function createPostmarkProvider(options: PostmarkProviderOptions): MailProvider {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: "postmark",
    async send(message: OutboundEmail): Promise<SendResult> {
      if (!options.serverToken || !options.fromAddress) {
        return { ok: false, kind: "not_configured" };
      }
      try {
        const response = await fetchImpl(API, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Postmark-Server-Token": options.serverToken,
          },
          body: JSON.stringify({
            From: options.fromAddress,
            To: message.to.join(","),
            Subject: message.subject,
            HtmlBody: message.html,
            TextBody: message.text,
            MessageStream: "outbound",
            ...(message.headers
              ? { Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })) }
              : {}),
            ...(message.attachments?.length
              ? {
                  Attachments: message.attachments.map((a) => ({
                    Name: a.filename,
                    Content: a.content,
                    ContentType: a.contentType ?? "application/octet-stream",
                    ...(a.disposition === "inline" && a.contentId ? { ContentID: `cid:${a.contentId}` } : {}),
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

        const json = (await response.json().catch(() => null)) as { MessageID?: string; ErrorCode?: number; Message?: string } | null;
        if (json && typeof json.ErrorCode === "number" && json.ErrorCode !== 0) {
          // Postmark responde 200 con un ErrorCode propio para algunos rechazos
          // (p. ej. destinatario en su lista de supresión): es un rechazo
          // definitivo del envío puntual, no algo que un reintento arregle.
          return { ok: false, kind: "permanent", detail: json.Message ?? `Postmark ErrorCode ${json.ErrorCode}` };
        }
        return { ok: true, providerMessageId: json?.MessageID ?? "" };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, kind: "retryable", detail };
      }
    },
  };
}
