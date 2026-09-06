import { describe, expect, it } from "vitest";
import { decodeBestEffort, decodeHttpResponseText, extractCharset } from "../src/util/encoding.js";

describe("extractCharset", () => {
  it("extrae el charset declarado en Content-Type", () => {
    expect(extractCharset("text/csv; charset=iso-8859-1")).toBe("iso-8859-1");
    expect(extractCharset('text/html; charset="windows-1252"')).toBe("windows-1252");
    expect(extractCharset("application/json")).toBeUndefined();
    expect(extractCharset(null)).toBeUndefined();
  });
});

describe("decodeBestEffort (SR-15)", () => {
  it("decodifica UTF-8 válido como UTF-8 (no lo confunde con Latin-1)", () => {
    const text = "Adquisición de equipo de cómputo, señalización";
    const bytes = new TextEncoder().encode(text);
    expect(decodeBestEffort(bytes)).toBe(text);
  });

  it("quita un BOM UTF-8 explícito antes de decodificar", () => {
    const text = "codigo_contrato,proveedor";
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    expect(decodeBestEffort(withBom)).toBe(text);
  });

  it("usa el charset declarado cuando es distinto de UTF-8", () => {
    const bytes = Buffer.from("Instalación de cañería", "latin1");
    expect(decodeBestEffort(new Uint8Array(bytes), "iso-8859-1")).toBe("Instalación de cañería");
  });

  it("heurística: bytes NO válidos como UTF-8 se decodifican como Latin-1 en vez de producir mojibake silencioso", () => {
    const original = "cañería, año, señalización";
    const latin1Bytes = new Uint8Array(Buffer.from(original, "latin1"));
    // Confirma primero que estos bytes efectivamente NO son UTF-8 válido (si lo fueran, el test no probaría nada).
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(latin1Bytes)).toThrow();
    expect(decodeBestEffort(latin1Bytes)).toBe(original);
  });

  it("ignora un charset declarado pero no reconocido por TextDecoder y sigue con la heurística de contenido", () => {
    const text = "texto simple sin acentos";
    const bytes = new TextEncoder().encode(text);
    expect(decodeBestEffort(bytes, "charset-inventado-xyz")).toBe(text);
  });
});

describe("decodeHttpResponseText", () => {
  it("decodifica el cuerpo de una Response usando el charset declarado en Content-Type", async () => {
    const latin1Bytes = Buffer.from("señalización", "latin1");
    const response = new Response(latin1Bytes, { headers: { "Content-Type": "text/plain; charset=iso-8859-1" } });
    expect(await decodeHttpResponseText(response)).toBe("señalización");
  });

  it("decodifica el cuerpo de una Response sin charset declarado usando la heurística UTF-8 inválido -> Latin-1", async () => {
    const latin1Bytes = Buffer.from("señalización", "latin1");
    const response = new Response(latin1Bytes, { headers: { "Content-Type": "text/csv" } });
    expect(await decodeHttpResponseText(response)).toBe("señalización");
  });
});
