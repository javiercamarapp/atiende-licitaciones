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

  it("ML-03: bloquea un host que solo EMPIEZA con 'localhost' (localhost.evil.com) y cae al fallback", () => {
    expect(safeUrl("http://localhost.evil.com/phish", "https://fallback.mx")).toBe("https://fallback.mx");
  });

  it("ML-03: bloquea localhost-mx.ejemplo.com (mismo ataque de prefijo, dominio con apariencia local)", () => {
    expect(safeUrl("http://localhost-mx.ejemplo.com/phish", "https://fallback.mx")).toBe("https://fallback.mx");
  });

  it("ML-03: deja pasar http://127.0.0.1 (desarrollo) con puerto y ruta", () => {
    expect(safeUrl("http://127.0.0.1:5173/x", "https://fallback.mx")).toBe("http://127.0.0.1:5173/x");
  });

  it("ML-03: deja pasar http://localhost SIN puerto ni ruta (host exacto)", () => {
    expect(safeUrl("http://localhost", "https://fallback.mx")).toBe("http://localhost");
  });

  it("ML-03: dominio público por env (MAIL_PUBLIC_APP_HOST) se acepta en http:// exactamente, no por prefijo", () => {
    expect(safeUrl("http://app.atiende.mx/x", "https://fallback.mx", { MAIL_PUBLIC_APP_HOST: "app.atiende.mx" })).toBe(
      "http://app.atiende.mx/x",
    );
    expect(
      safeUrl("http://app.atiende.mx.evil.com/x", "https://fallback.mx", { MAIL_PUBLIC_APP_HOST: "app.atiende.mx" }),
    ).toBe("https://fallback.mx");
  });
});
