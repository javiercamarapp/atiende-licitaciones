import { describe, expect, it } from "vitest";
import { hashRawPayload, stableStringify } from "../src/util/hash.js";

describe("stableStringify / hashRawPayload", () => {
  it("produce el mismo resultado sin importar el orden de las claves del objeto (a cualquier nivel de anidación)", () => {
    const a = { z: 1, a: { y: 2, b: 3 }, m: [{ q: 1, p: 2 }] };
    const b = { a: { b: 3, y: 2 }, m: [{ p: 2, q: 1 }], z: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(hashRawPayload(a)).toBe(hashRawPayload(b));
  });

  it("distingue objetos con `Date` que representan instantes distintos (no colapsa Date a {})", () => {
    const a = { fecha: new Date("2026-08-01T00:00:00Z") };
    const b = { fecha: new Date("2026-08-02T00:00:00Z") };
    expect(hashRawPayload(a)).not.toBe(hashRawPayload(b));
  });

  it("produce el mismo hash para el mismo instante representado como Date o como string ISO", () => {
    const asDate = { fecha: new Date("2026-08-01T00:00:00.000Z") };
    const asString = { fecha: "2026-08-01T00:00:00.000Z" };
    expect(hashRawPayload(asDate)).toBe(hashRawPayload(asString));
  });

  it("es sensible a cambios reales de contenido", () => {
    expect(hashRawPayload({ a: 1 })).not.toBe(hashRawPayload({ a: 2 }));
  });
});
