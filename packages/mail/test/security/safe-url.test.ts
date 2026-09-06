import { describe, expect, it } from "vitest";
import { safeUrl } from "../../src/security/safe-url";

describe("safeUrl", () => {
  it("deja pasar https://", () => {
    expect(safeUrl("https://app.atiende.mx/x", "https://fallback.mx")).toBe("https://app.atiende.mx/x");
  });

  it("deja pasar http://localhost (desarrollo)", () => {
    expect(safeUrl("http://localhost:3000/x", "https://fallback.mx")).toBe("http://localhost:3000/x");
  });

  it("bloquea javascript: y cae al fallback", () => {
    expect(safeUrl("javascript:alert(1)", "https://fallback.mx")).toBe("https://fallback.mx");
  });

  it("bloquea data: y cae al fallback", () => {
    expect(safeUrl("data:text/html,hola", "https://fallback.mx")).toBe("https://fallback.mx");
  });

  it("bloquea http:// que no es localhost y cae al fallback", () => {
    expect(safeUrl("http://ejemplo.mx/x", "https://fallback.mx")).toBe("https://fallback.mx");
  });

  it("recorta espacios antes de validar", () => {
    expect(safeUrl("   https://app.atiende.mx  ", "https://fallback.mx")).toBe("https://app.atiende.mx");
  });
});
