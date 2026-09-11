import { describe, expect, it } from "vitest";
import { FakeOcrAdapter } from "../src/fake-adapter.js";

describe("FakeOcrAdapter", () => {
  it("declara liveVerification.verified=false y nunca ejecuta OCR real", async () => {
    const fake = new FakeOcrAdapter();
    expect(fake.liveVerification.verified).toBe(false);
    expect(fake.name).toBe("fake");
  });

  it("sin `respond` configurado, devuelve una página vacía (nunca inventa texto por defecto)", async () => {
    const fake = new FakeOcrAdapter();
    const result = await fake.recognize({ image: Buffer.from("cualquier cosa") });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.page.text).toBe("");
    expect(result.page.meanConfidence).toBe(0);
  });

  it("con `respond` fijo, devuelve exactamente ese resultado", async () => {
    const canned = {
      ok: true as const,
      page: { imageWidth: 100, imageHeight: 50, text: "REQUISITO OBLIGATORIO", meanConfidence: 91, lines: [] },
    };
    const fake = new FakeOcrAdapter({ respond: canned });
    const result = await fake.recognize({ image: Buffer.from("x") });
    expect(result).toEqual(canned);
  });

  it("con `respond` como función, varía la respuesta según el input", async () => {
    const fake = new FakeOcrAdapter({
      respond: (input) => ({
        ok: true,
        page: { imageWidth: 1, imageHeight: 1, text: `len=${input.image.length}`, meanConfidence: 100, lines: [] },
      }),
    });
    const a = await fake.recognize({ image: Buffer.from("ab") });
    const b = await fake.recognize({ image: Buffer.from("abcd") });
    if (!a.ok || !b.ok) throw new Error("unreachable");
    expect(a.page.text).toBe("len=2");
    expect(b.page.text).toBe("len=4");
  });

  it("registra cada llamada en `calls` en orden, para que un test verifique qué se le pasó realmente", async () => {
    const fake = new FakeOcrAdapter();
    await fake.recognize({ image: Buffer.from("uno"), language: "spa" });
    await fake.recognize({ image: Buffer.from("dos") });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0].language).toBe("spa");
    expect(fake.calls[1].language).toBeUndefined();
  });

  it("puede simular un estado not_configured/failed explícito", async () => {
    const fake = new FakeOcrAdapter({ respond: { ok: false, kind: "not_configured", detail: "sin credencial" } });
    const result = await fake.recognize({ image: Buffer.from("x") });
    expect(result).toEqual({ ok: false, kind: "not_configured", detail: "sin credencial" });
  });

  it("terminate() no lanza y es seguro llamarlo repetidamente", async () => {
    const fake = new FakeOcrAdapter();
    await fake.terminate();
    await fake.terminate();
  });
});
