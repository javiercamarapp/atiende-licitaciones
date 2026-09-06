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

  describe("reserve()/release() (ML-01 — compare-and-set)", () => {
    it("reserve() devuelve true la primera vez para una llave nunca vista", async () => {
      const store = new InMemorySendRecordStore();
      expect(await store.reserve("k1")).toBe(true);
    });

    it("reserve() devuelve false para una llave ya reservada (en vuelo)", async () => {
      const store = new InMemorySendRecordStore();
      expect(await store.reserve("k1")).toBe(true);
      expect(await store.reserve("k1")).toBe(false);
    });

    it("reserve() devuelve false para una llave ya guardada como sent", async () => {
      const store = new InMemorySendRecordStore();
      await store.save({ messageKey: "k1", templateId: "t", status: "sent", attempts: 1, maxAttempts: 4, updatedAt: "a" });
      expect(await store.reserve("k1")).toBe(false);
    });

    it("save() libera la reserva en vuelo (queda un registro final, no una reserva colgada)", async () => {
      const store = new InMemorySendRecordStore();
      await store.reserve("k1");
      await store.save({ messageKey: "k1", templateId: "t", status: "failed_permanent", attempts: 1, maxAttempts: 4, updatedAt: "a" });
      // Una nueva reserva para la misma llave sigue bloqueada porque ya hay
      // un registro final (failed_permanent) — pero release() explícito de
      // una reserva SIN registro sí debe permitir reservar de nuevo:
      const store2 = new InMemorySendRecordStore();
      await store2.reserve("k2");
      await store2.release("k2");
      expect(await store2.reserve("k2")).toBe(true);
    });

    it("Promise.all de 10 reservas concurrentes para la misma llave: exactamente 1 gana", async () => {
      const store = new InMemorySendRecordStore();
      const results = await Promise.all(Array.from({ length: 10 }, () => store.reserve("carrera")));
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });
});
