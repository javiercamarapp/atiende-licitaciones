import { describe, expect, it } from "vitest";
import { InMemorySuppressionStore } from "../../src/suppression/types";

describe("InMemorySuppressionStore", () => {
  it("una dirección nunca suprimida no está suprimida", async () => {
    const store = new InMemorySuppressionStore();
    expect(await store.isSuppressed("a@b.mx")).toBe(false);
  });

  it("suppress() marca la dirección como suprimida", async () => {
    const store = new InMemorySuppressionStore();
    await store.suppress("a@b.mx", "bounce", "webhook_resend");
    expect(await store.isSuppressed("a@b.mx")).toBe(true);
    expect(await store.get("a@b.mx")).toMatchObject({ email: "a@b.mx", reason: "bounce", source: "webhook_resend" });
  });

  it("normaliza mayúsculas/espacios en el correo", async () => {
    const store = new InMemorySuppressionStore();
    await store.suppress("  A@B.MX  ", "complaint", "test");
    expect(await store.isSuppressed("a@b.mx")).toBe(true);
  });

  it("unsuppress() quita la supresión", async () => {
    const store = new InMemorySuppressionStore();
    await store.suppress("a@b.mx", "manual", "panel_admin");
    await store.unsuppress("a@b.mx");
    expect(await store.isSuppressed("a@b.mx")).toBe(false);
  });
});
