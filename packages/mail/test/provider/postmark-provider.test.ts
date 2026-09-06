import { describe, expect, it, vi } from "vitest";
import { createPostmarkProvider } from "../../src/provider/postmark-provider";
import type { OutboundEmail } from "../../src/provider/types";

const BASE_MESSAGE: OutboundEmail = {
  to: ["destino@ejemplo.mx"],
  subject: "Asunto de prueba",
  html: "<p>hola</p>",
  text: "hola",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("createPostmarkProvider", () => {
  it("devuelve not_configured si faltan credenciales", async () => {
    const provider = createPostmarkProvider({ serverToken: undefined, fromAddress: undefined });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toEqual({ ok: false, kind: "not_configured" });
  });

  it("envía con éxito", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { MessageID: "abc-123", ErrorCode: 0 }));
    const provider = createPostmarkProvider({ serverToken: "t", fromAddress: "avisos@atiende.mx", fetchImpl });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toEqual({ ok: true, providerMessageId: "abc-123" });
  });

  it("clasifica 429 como retryable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const provider = createPostmarkProvider({ serverToken: "t", fromAddress: "avisos@atiende.mx", fetchImpl });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toMatchObject({ ok: false, kind: "retryable" });
  });

  it("clasifica un 4xx HTTP como permanent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
    const provider = createPostmarkProvider({ serverToken: "t", fromAddress: "avisos@atiende.mx", fetchImpl });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toMatchObject({ ok: false, kind: "permanent" });
  });

  it("un ErrorCode distinto de 0 con HTTP 200 se trata como rechazo permanente", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ErrorCode: 406, Message: "Destinatario suprimido" }));
    const provider = createPostmarkProvider({ serverToken: "t", fromAddress: "avisos@atiende.mx", fetchImpl });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toEqual({ ok: false, kind: "permanent", detail: "Destinatario suprimido" });
  });

  it("un fallo de red se clasifica como retryable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("timeout"));
    const provider = createPostmarkProvider({ serverToken: "t", fromAddress: "avisos@atiende.mx", fetchImpl });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toMatchObject({ ok: false, kind: "retryable" });
  });

  it("agrega el adjunto inline con ContentID prefijado cid:", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { MessageID: "m1", ErrorCode: 0 }));
    const provider = createPostmarkProvider({ serverToken: "t", fromAddress: "avisos@atiende.mx", fetchImpl });
    await provider.send({
      ...BASE_MESSAGE,
      attachments: [{ filename: "logo.png", content: "QQ==", contentType: "image/png", contentId: "logo", disposition: "inline" }],
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.Attachments).toEqual([{ Name: "logo.png", Content: "QQ==", ContentType: "image/png", ContentID: "cid:logo" }]);
  });

  it("ML-02: traduce List-Unsubscribe/List-Unsubscribe-Post al formato Headers: [{Name,Value}]", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { MessageID: "m1", ErrorCode: 0 }));
    const provider = createPostmarkProvider({ serverToken: "t", fromAddress: "avisos@atiende.mx", fetchImpl });
    await provider.send({
      ...BASE_MESSAGE,
      headers: {
        "List-Unsubscribe": "<https://app.atiende.mx/baja>, <mailto:soporte@atiende.mx?subject=unsubscribe>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.Headers).toEqual([
      { Name: "List-Unsubscribe", Value: "<https://app.atiende.mx/baja>, <mailto:soporte@atiende.mx?subject=unsubscribe>" },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    ]);
  });
});
