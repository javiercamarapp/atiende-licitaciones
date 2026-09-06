import { describe, expect, it, vi } from "vitest";
import { classifySmtpCode, createSmtpProvider } from "../../src/provider/smtp-provider";
import type { OutboundEmail } from "../../src/provider/types";

const BASE_MESSAGE: OutboundEmail = {
  to: ["destino@ejemplo.mx"],
  subject: "Asunto de prueba",
  html: "<p>hola</p>",
  text: "hola",
};

describe("classifySmtpCode", () => {
  it("4xx es retryable (rechazo temporal SMTP)", () => {
    expect(classifySmtpCode(450)).toBe("retryable");
  });
  it("5xx es permanent", () => {
    expect(classifySmtpCode(550)).toBe("permanent");
  });
  it("sin código (undefined) se trata como retryable", () => {
    expect(classifySmtpCode(undefined)).toBe("retryable");
  });
});

describe("createSmtpProvider", () => {
  it("devuelve not_configured si falta host/puerto/remitente", async () => {
    const provider = createSmtpProvider({ host: undefined, port: undefined, user: undefined, pass: undefined, fromAddress: undefined });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toEqual({ ok: false, kind: "not_configured" });
  });

  it("envía con éxito usando un transporter inyectado", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<abc@atiende.mx>" });
    const provider = createSmtpProvider({
      host: "smtp.ejemplo.mx",
      port: 587,
      user: "u",
      pass: "p",
      fromAddress: "avisos@atiende.mx",
      transporterFactory: () => ({ sendMail }) as never,
    });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toEqual({ ok: true, providerMessageId: "<abc@atiende.mx>" });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: "avisos@atiende.mx", to: ["destino@ejemplo.mx"], subject: "Asunto de prueba" }),
    );
  });

  it("un rechazo SMTP 550 se clasifica como permanent", async () => {
    const error = Object.assign(new Error("mailbox unavailable"), { responseCode: 550 });
    const sendMail = vi.fn().mockRejectedValue(error);
    const provider = createSmtpProvider({
      host: "smtp.ejemplo.mx",
      port: 587,
      user: "u",
      pass: "p",
      fromAddress: "avisos@atiende.mx",
      transporterFactory: () => ({ sendMail }) as never,
    });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toMatchObject({ ok: false, kind: "permanent", statusCode: 550 });
  });

  it("un rechazo SMTP 421 (temporal) se clasifica como retryable", async () => {
    const error = Object.assign(new Error("too busy"), { responseCode: 421 });
    const sendMail = vi.fn().mockRejectedValue(error);
    const provider = createSmtpProvider({
      host: "smtp.ejemplo.mx",
      port: 587,
      user: "u",
      pass: "p",
      fromAddress: "avisos@atiende.mx",
      transporterFactory: () => ({ sendMail }) as never,
    });
    const result = await provider.send(BASE_MESSAGE);
    expect(result).toMatchObject({ ok: false, kind: "retryable", statusCode: 421 });
  });

  it("pasa el adjunto inline como cid al transporter", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "m1" });
    const provider = createSmtpProvider({
      host: "smtp.ejemplo.mx",
      port: 587,
      user: "u",
      pass: "p",
      fromAddress: "avisos@atiende.mx",
      transporterFactory: () => ({ sendMail }) as never,
    });
    await provider.send({ ...BASE_MESSAGE, attachments: [{ filename: "logo.png", content: "QQ==", contentId: "logo", disposition: "inline" }] });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [expect.objectContaining({ filename: "logo.png", cid: "logo" })],
      }),
    );
  });
});
