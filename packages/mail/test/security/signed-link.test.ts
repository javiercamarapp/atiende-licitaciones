import { describe, expect, it } from "vitest";
import { createLinkSigner } from "../../src/security/signed-link";

const SECRET = "una-llave-secreta-de-pruebas-muy-larga";

describe("createLinkSigner", () => {
  it("rechaza secretos demasiado cortos", () => {
    expect(() => createLinkSigner("corto")).toThrow(/al menos 16/);
  });

  it("arma una URL absoluta a partir de baseUrl + path", () => {
    const signer = createLinkSigner(SECRET);
    const url = signer.signedLink("https://app.atiende.mx", "/verificar-correo", { userId: "u1" }, 900);
    expect(url.startsWith("https://app.atiende.mx/verificar-correo?")).toBe(true);
    expect(url).toContain("d=");
    expect(url).toContain("s=");
  });

  it("verifica un enlace válido y recupera el payload original", () => {
    const signer = createLinkSigner(SECRET);
    const url = signer.signedLink("https://app.atiende.mx", "/verificar-correo", { userId: "u1", proposito: "verificacion" }, 900);
    const result = signer.verifySignedLink<{ userId: string; proposito: string }>(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.userId).toBe("u1");
      expect(result.payload.proposito).toBe("verificacion");
    }
  });

  it("rechaza un enlace expirado", () => {
    const signer = createLinkSigner(SECRET);
    const url = signer.signedLink("https://app.atiende.mx", "/verificar-correo", { userId: "u1" }, -10);
    const result = signer.verifySignedLink(url);
    expect(result).toEqual({ ok: false, reason: "expirado" });
  });

  it("rechaza un enlace manipulado (payload alterado sin resignar)", () => {
    const signer = createLinkSigner(SECRET);
    const url = signer.signedLink("https://app.atiende.mx", "/verificar-correo", { userId: "u1" }, 900);
    const tampered = new URL(url);
    tampered.searchParams.set("d", Buffer.from(JSON.stringify({ userId: "atacante", exp: 9999999999 })).toString("base64url"));
    const result = signer.verifySignedLink(tampered.toString());
    expect(result).toEqual({ ok: false, reason: "firma_invalida" });
  });

  it("rechaza un enlace manipulado (firma alterada)", () => {
    const signer = createLinkSigner(SECRET);
    const url = signer.signedLink("https://app.atiende.mx", "/verificar-correo", { userId: "u1" }, 900);
    const tampered = new URL(url);
    tampered.searchParams.set("s", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const result = signer.verifySignedLink(tampered.toString());
    expect(result).toEqual({ ok: false, reason: "firma_invalida" });
  });

  it("rechaza una URL sin los parámetros d/s", () => {
    const signer = createLinkSigner(SECRET);
    const result = signer.verifySignedLink("https://app.atiende.mx/verificar-correo");
    expect(result).toEqual({ ok: false, reason: "malformado" });
  });

  it("rechaza una URL malformada (no es una URL)", () => {
    const signer = createLinkSigner(SECRET);
    const result = signer.verifySignedLink("no-es-una-url");
    expect(result).toEqual({ ok: false, reason: "malformado" });
  });

  it("dos firmadores con secretos distintos no validan los enlaces del otro", () => {
    const signerA = createLinkSigner(SECRET);
    const signerB = createLinkSigner("otra-llave-secreta-distinta-tambien-larga");
    const url = signerA.signedLink("https://app.atiende.mx", "/x", { a: 1 }, 900);
    expect(signerB.verifySignedLink(url)).toEqual({ ok: false, reason: "firma_invalida" });
  });
});
