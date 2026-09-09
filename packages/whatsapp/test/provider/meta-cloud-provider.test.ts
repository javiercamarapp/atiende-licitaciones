import { describe, expect, it, vi } from "vitest";
import { createMetaCloudProvider } from "../../src/provider/meta-cloud-provider";
import type { OutboundWhatsAppMessage } from "../../src/provider/types";

const BASE_MESSAGE: OutboundWhatsAppMessage = {
  to: "+525512345678",
  templateName: "nuevo_match_licitacion",
  templateParams: { "1": "Suministro de uniformes", "2": "18 sep 2026" },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("createMetaCloudProvider", () => {
  it("devuelve not_configured si falta el access token", async () => {
    const provider = createMetaCloudProvider({ accessToken: undefined, phoneNumberId: "123456" });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toEqual({ ok: false, kind: "not_configured" });
  });

  it("devuelve not_configured si falta el phone-number-id", async () => {
    const provider = createMetaCloudProvider({ accessToken: "token", phoneNumberId: undefined });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toEqual({ ok: false, kind: "not_configured" });
  });

  it("devuelve not_configured sin llamar a fetch en absoluto", async () => {
    const fetchImpl = vi.fn();
    const provider = createMetaCloudProvider({ accessToken: undefined, phoneNumberId: undefined, fetchImpl });
    await provider.send(BASE_MESSAGE);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("envía con éxito y devuelve el id del proveedor", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { messages: [{ id: "wamid.ABC123" }] }));
    const provider = createMetaCloudProvider({ accessToken: "token", phoneNumberId: "123456", fetchImpl });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toEqual({ ok: true, providerMessageId: "wamid.ABC123" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/123456/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token");
    const body = JSON.parse(init.body as string);
    expect(body.messaging_product).toBe("whatsapp");
    // El `+` inicial se quita: Meta espera el número sin él.
    expect(body.to).toBe("525512345678");
    expect(body.type).toBe("template");
    expect(body.template.name).toBe("nuevo_match_licitacion");
    expect(body.template.language).toEqual({ code: "es_MX" });
    // Ordenado por llave posicional ("1", "2"), no por orden de inserción del objeto.
    expect(body.template.components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Suministro de uniformes" }, { type: "text", text: "18 sep 2026" }] },
    ]);
  });

  it("ordena templateParams por llave numérica aunque se den fuera de orden", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { messages: [{ id: "wamid.1" }] }));
    const provider = createMetaCloudProvider({ accessToken: "token", phoneNumberId: "123456", fetchImpl });
    await provider.send({ ...BASE_MESSAGE, templateParams: { "2": "segundo", "1": "primero" } });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.template.components[0].parameters).toEqual([{ type: "text", text: "primero" }, { type: "text", text: "segundo" }]);
  });

  it("usa languageCode del mensaje cuando se da, en vez del default", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { messages: [{ id: "wamid.1" }] }));
    const provider = createMetaCloudProvider({ accessToken: "token", phoneNumberId: "123456", fetchImpl });
    await provider.send({ ...BASE_MESSAGE, languageCode: "en_US" });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.template.language).toEqual({ code: "en_US" });
  });

  it("clasifica 429 como retryable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Too Many Requests", { status: 429 }));
    const provider = createMetaCloudProvider({ accessToken: "token", phoneNumberId: "123456", fetchImpl });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toMatchObject({ ok: false, kind: "retryable", statusCode: 429 });
  });

  it("clasifica 500 como retryable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Internal Error", { status: 500 }));
    const provider = createMetaCloudProvider({ accessToken: "token", phoneNumberId: "123456", fetchImpl });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toMatchObject({ ok: false, kind: "retryable", statusCode: 500 });
  });

  it("clasifica 400 (plantilla no aprobada / payload inválido) como permanent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(400, { error: { message: "Template name does not exist", type: "OAuthException", code: 132001 } }),
    );
    const provider = createMetaCloudProvider({ accessToken: "token", phoneNumberId: "123456", fetchImpl });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toMatchObject({ ok: false, kind: "permanent", statusCode: 400 });
  });

  it("un fallo de red (fetch que lanza) se clasifica como retryable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const provider = createMetaCloudProvider({ accessToken: "token", phoneNumberId: "123456", fetchImpl });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toMatchObject({ ok: false, kind: "retryable" });
  });

  it("usa la versión de API y el idioma default dados en las opciones", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { messages: [{ id: "wamid.1" }] }));
    const provider = createMetaCloudProvider({
      accessToken: "token",
      phoneNumberId: "123456",
      apiVersion: "v22.0",
      defaultLanguageCode: "en_US",
      fetchImpl,
    });
    await provider.send(BASE_MESSAGE);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v22.0/123456/messages");
    const body = JSON.parse(init.body as string);
    expect(body.template.language).toEqual({ code: "en_US" });
  });
});
