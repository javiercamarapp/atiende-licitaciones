import { describe, expect, it } from "vitest";
import { parseResendWebhookPayload } from "../../src/webhooks/parse-resend-payload";

describe("parseResendWebhookPayload", () => {
  it("traduce un evento de rebote real de Resend", () => {
    const event = parseResendWebhookPayload({
      type: "email.bounced",
      created_at: "2026-01-01T00:00:00.000Z",
      data: { email_id: "msg_1", to: ["persona@ejemplo.mx"] },
    });
    expect(event).toEqual({
      type: "email.bounced",
      email: "persona@ejemplo.mx",
      providerMessageId: "msg_1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      raw: expect.any(Object),
    });
  });

  it("devuelve null para un tipo de evento que no modelamos", () => {
    expect(parseResendWebhookPayload({ type: "email.clicked", data: { to: ["a@b.mx"] } })).toBeNull();
  });

  it("devuelve null si falta el destinatario", () => {
    expect(parseResendWebhookPayload({ type: "email.bounced", data: { to: [] } })).toBeNull();
  });

  it("devuelve null (no lanza) ante un payload completamente ajeno", () => {
    expect(parseResendWebhookPayload({ algo: "distinto" })).toBeNull();
    expect(parseResendWebhookPayload(null)).toBeNull();
    expect(parseResendWebhookPayload("texto")).toBeNull();
  });

  it("usa la hora actual si created_at no viene en el payload", () => {
    const event = parseResendWebhookPayload({ type: "email.delivered", data: { to: ["a@b.mx"] } });
    expect(event?.occurredAt).toBeTruthy();
  });
});
