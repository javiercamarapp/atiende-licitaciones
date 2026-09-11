import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeHmacDigest, matchesAnyHmacSignature } from "../src/hmac";

const SECRET = Buffer.from("una-llave-de-prueba-para-hmac-sha256");

describe("computeHmacDigest", () => {
  it("coincide con node:crypto usado directamente", () => {
    const expected = createHmac("sha256", SECRET).update("contenido").digest("hex");
    expect(computeHmacDigest("contenido", SECRET, "hex")).toBe(expected);
  });

  it("hex y base64 codifican el MISMO digest de forma distinta", () => {
    const hex = computeHmacDigest("contenido", SECRET, "hex");
    const base64 = computeHmacDigest("contenido", SECRET, "base64");
    expect(Buffer.from(hex, "hex").equals(Buffer.from(base64, "base64"))).toBe(true);
  });
});

describe("matchesAnyHmacSignature", () => {
  it("acepta la firma correcta (hex)", () => {
    const content = JSON.stringify({ hola: "mundo" });
    const digest = computeHmacDigest(content, SECRET, "hex");
    expect(matchesAnyHmacSignature(content, [digest], SECRET, "hex")).toBe(true);
  });

  it("acepta la firma correcta (base64)", () => {
    const content = JSON.stringify({ hola: "mundo" });
    const digest = computeHmacDigest(content, SECRET, "base64");
    expect(matchesAnyHmacSignature(content, [digest], SECRET, "base64")).toBe(true);
  });

  it("rechaza si el contenido fue alterado después de firmar", () => {
    const digest = computeHmacDigest("original", SECRET, "hex");
    expect(matchesAnyHmacSignature("alterado", [digest], SECRET, "hex")).toBe(false);
  });

  it("rechaza con el secreto equivocado", () => {
    const digest = computeHmacDigest("contenido", SECRET, "hex");
    expect(matchesAnyHmacSignature("contenido", [digest], Buffer.from("otro-secreto-distinto"), "hex")).toBe(false);
  });

  it("acepta si ALGUNA de varias firmas coincide (rotación de secreto)", () => {
    const digest = computeHmacDigest("contenido", SECRET, "hex");
    expect(matchesAnyHmacSignature("contenido", ["firmavieja00", digest], SECRET, "hex")).toBe(true);
  });

  it("rechaza una lista vacía de candidatos", () => {
    expect(matchesAnyHmacSignature("contenido", [], SECRET, "hex")).toBe(false);
  });

  it("rechaza un candidato que no es hex/base64 válido sin lanzar", () => {
    expect(() => matchesAnyHmacSignature("contenido", ["no es hex ni base64 §§§"], SECRET, "hex")).not.toThrow();
  });

  it("rechaza un secreto vacío (nunca debe 'coincidir con todo')", () => {
    const digest = computeHmacDigest("contenido", Buffer.alloc(0), "hex");
    expect(matchesAnyHmacSignature("contenido", [digest], Buffer.alloc(0), "hex")).toBe(false);
  });

  it("nunca lanza por buffers de distinta longitud (evita el crash de timingSafeEqual)", () => {
    // Un candidato hex de longitud impar decodifica a un Buffer más corto
    // que el digest esperado (32 bytes) — no debe lanzar, solo rechazar.
    expect(() => matchesAnyHmacSignature("contenido", ["abc"], SECRET, "hex")).not.toThrow();
    expect(matchesAnyHmacSignature("contenido", ["abc"], SECRET, "hex")).toBe(false);
  });
});
