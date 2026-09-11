import { describe, expect, it } from "vitest";
import { resolveWebhookSubscriptionChallenge } from "../../src/webhook/subscription-challenge";

describe("handshake de suscripción de webhook de Meta (GET hub.mode/hub.verify_token/hub.challenge)", () => {
  it("mode/token correctos -> devuelve el challenge", () => {
    const result = resolveWebhookSubscriptionChallenge(
      { "hub.mode": "subscribe", "hub.verify_token": "secreto-verify", "hub.challenge": "12345" },
      "secreto-verify"
    );
    expect(result).toEqual({ ok: true, challenge: "12345" });
  });

  it("sin verify_token configurado -> rechazado (falla cerrado)", () => {
    const result = resolveWebhookSubscriptionChallenge(
      { "hub.mode": "subscribe", "hub.verify_token": "x", "hub.challenge": "1" },
      undefined
    );
    expect(result).toEqual({ ok: false });
  });

  it("ADVERSARIAL: verify_token incorrecto -> rechazado", () => {
    const result = resolveWebhookSubscriptionChallenge(
      { "hub.mode": "subscribe", "hub.verify_token": "adivinado", "hub.challenge": "1" },
      "secreto-verify"
    );
    expect(result).toEqual({ ok: false });
  });

  it("hub.mode distinto de 'subscribe' -> rechazado", () => {
    const result = resolveWebhookSubscriptionChallenge(
      { "hub.mode": "unsubscribe", "hub.verify_token": "secreto-verify", "hub.challenge": "1" },
      "secreto-verify"
    );
    expect(result).toEqual({ ok: false });
  });

  it("sin hub.challenge -> rechazado", () => {
    const result = resolveWebhookSubscriptionChallenge({ "hub.mode": "subscribe", "hub.verify_token": "secreto-verify" }, "secreto-verify");
    expect(result).toEqual({ ok: false });
  });
});
