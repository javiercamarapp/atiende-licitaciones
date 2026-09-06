import { describe, expect, it } from "vitest";
import { applyMailWebhookEvent } from "../../src/webhooks/apply-event";
import { InMemorySuppressionStore } from "../../src/suppression/types";
import type { MailWebhookEvent } from "../../src/webhooks/types";

function event(type: MailWebhookEvent["type"], email = "persona@ejemplo.mx"): MailWebhookEvent {
  return { type, email, occurredAt: "2026-01-01T00:00:00.000Z" };
}

describe("applyMailWebhookEvent", () => {
  it("un rebote (bounced) suprime la dirección con razón bounce", async () => {
    const store = new InMemorySuppressionStore();
    await applyMailWebhookEvent(event("email.bounced"), store, "webhook_resend");
    expect(await store.get("persona@ejemplo.mx")).toMatchObject({ reason: "bounce", source: "webhook_resend" });
  });

  it("una queja (complained) suprime la dirección con razón complaint", async () => {
    const store = new InMemorySuppressionStore();
    await applyMailWebhookEvent(event("email.complained"), store, "webhook_resend");
    expect(await store.get("persona@ejemplo.mx")).toMatchObject({ reason: "complaint" });
  });

  it("eventos informativos (sent/delivered/delivery_delayed) no suprimen nada", async () => {
    const store = new InMemorySuppressionStore();
    await applyMailWebhookEvent(event("email.sent"), store, "webhook_resend");
    await applyMailWebhookEvent(event("email.delivered"), store, "webhook_resend");
    await applyMailWebhookEvent(event("email.delivery_delayed"), store, "webhook_resend");
    expect(await store.isSuppressed("persona@ejemplo.mx")).toBe(false);
  });
});
