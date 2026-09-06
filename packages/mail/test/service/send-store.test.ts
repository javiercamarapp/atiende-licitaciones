import { describe, expect, it } from "vitest";
import { InMemorySendRecordStore } from "../../src/service/send-store";

describe("InMemorySendRecordStore", () => {
  it("get() devuelve undefined para una llave nunca guardada", async () => {
    const store = new InMemorySendRecordStore();
    expect(await store.get("no-existe")).toBeUndefined();
  });

  it("save()/get() persisten y recuperan un registro por messageKey", async () => {
    const store = new InMemorySendRecordStore();
    await store.save({
      messageKey: "k1",
      templateId: "email-verification",
      status: "sent",
      providerMessageId: "p1",
      attempts: 1,
      maxAttempts: 4,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await store.get("k1")).toMatchObject({ status: "sent", providerMessageId: "p1" });
  });

  it("guardar de nuevo con la misma llave reemplaza el registro", async () => {
    const store = new InMemorySendRecordStore();
    await store.save({ messageKey: "k1", templateId: "t", status: "dead", attempts: 4, maxAttempts: 4, updatedAt: "a" });
    await store.save({ messageKey: "k1", templateId: "t", status: "sent", attempts: 1, maxAttempts: 4, updatedAt: "b" });
    expect((await store.get("k1"))?.status).toBe("sent");
  });

  it("all() lista todos los registros guardados", async () => {
    const store = new InMemorySendRecordStore();
    await store.save({ messageKey: "k1", templateId: "t", status: "sent", attempts: 1, maxAttempts: 4, updatedAt: "a" });
    await store.save({ messageKey: "k2", templateId: "t", status: "failed_permanent", attempts: 1, maxAttempts: 4, updatedAt: "b" });
    expect(store.all()).toHaveLength(2);
  });
});
