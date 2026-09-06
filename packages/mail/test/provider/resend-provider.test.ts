import { describe, expect, it, vi } from "vitest";
import { createResendProvider } from "../../src/provider/resend-provider";
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

describe("createResendProvider", () => {
  it("devuelve not_configured si faltan credenciales", async () => {
    const provider = createResendProvider({ apiKey: undefined, domain: undefined });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toEqual({ ok: false, kind: "not_configured" });
  });

  it("envía con éxito y devuelve el id del proveedor", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: "msg_123" }));
    const provider = createResendProvider({ apiKey: "k", domain: "mail.atiende.mx", fetchImpl });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toEqual({ ok: true, providerMessageId: "msg_123" });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.from).toContain("mail.atiende.mx");
    expect(body.to).toEqual(["destino@ejemplo.mx"]);
  });

  it("clasifica 429 como retryable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Too Many Requests", { status: 429 }));
    const provider = createResendProvider({ apiKey: "k", domain: "mail.atiende.mx", fetchImpl });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toMatchObject({ ok: false, kind: "retryable", statusCode: 429 });
  });

  it("clasifica 500 como retryable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Internal Error", { status: 500 }));
    const provider = createResendProvider({ apiKey: "k", domain: "mail.atiende.mx", fetchImpl });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toMatchObject({ ok: false, kind: "retryable", statusCode: 500 });
  });

  it("clasifica 422 como permanent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Unprocessable", { status: 422 }));
    const provider = createResendProvider({ apiKey: "k", domain: "mail.atiende.mx", fetchImpl });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toMatchObject({ ok: false, kind: "permanent", statusCode: 422 });
  });

  it("un fallo de red (fetch que lanza) se clasifica como retryable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const provider = createResendProvider({ apiKey: "k", domain: "mail.atiende.mx", fetchImpl });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toMatchObject({ ok: false, kind: "retryable" });
  });

  it("agrega el adjunto inline (cid) cuando el mensaje lo trae", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: "msg_1" }));
    const provider = createResendProvider({ apiKey: "k", domain: "mail.atiende.mx", fetchImpl });
    await provider.send({
      ...BASE_MESSAGE,
      attachments: [{ filename: "logo.png", content: "QQ==", contentId: "logo", disposition: "inline" }],
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.attachments).toEqual([{ filename: "logo.png", content: "QQ==", content_id: "logo", content_disposition: "inline" }]);
  });
});
