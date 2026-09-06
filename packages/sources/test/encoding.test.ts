import { describe, expect, it } from "vitest";
import { decodeBestEffort, decodeByteChunksStream, decodeHttpResponseText, extractCharset } from "../src/util/encoding.js";

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

describe("decodeBestEffort: SR-22 (UTF-16LE/BE, residual de la ronda 2 de corrección)", () => {
  const text = "Instalación de cañería, año 2026";

  function toUtf16Be(leBytes: Buffer): Uint8Array {
    const be = Buffer.alloc(leBytes.length);
    for (let i = 0; i < leBytes.length; i += 2) {
      be[i] = leBytes[i + 1];
      be[i + 1] = leBytes[i];
    }
    return new Uint8Array(be);
  }

  it("decodifica UTF-16LE CON BOM explícito (FF FE)", () => {
    const withoutBom = Buffer.from(text, "utf16le");
    const withBom = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), withoutBom]));
    expect(decodeBestEffort(withBom)).toBe(text);
  });

  it("decodifica UTF-16LE SIN BOM por heurística de bytes NUL alternos (Excel 'Guardar como texto Unicode')", () => {
    const bytes = new Uint8Array(Buffer.from(text, "utf16le"));
    // Confirma primero que este NO es el caso trivial (BOM ausente, heurística obligatoria).
    expect(bytes[0]).not.toBe(0xff);
    expect(decodeBestEffort(bytes)).toBe(text);
  });

  it("decodifica UTF-16BE CON BOM explícito (FE FF) -- TextDecoder no tiene una etiqueta 'utf-16be' nativa", () => {
    const be = toUtf16Be(Buffer.from(text, "utf16le"));
    const withBom = new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
    expect(decodeBestEffort(withBom)).toBe(text);
  });

  it("decodifica UTF-16BE SIN BOM por heurística de bytes NUL alternos (patrón invertido respecto a LE)", () => {
    const be = toUtf16Be(Buffer.from(text, "utf16le"));
    expect(decodeBestEffort(be)).toBe(text);
  });

  it("texto UTF-8/ASCII normal (sin bytes NUL) NO se confunde con UTF-16 -- la heurística no produce falsos positivos", () => {
    expect(decodeBestEffort(new TextEncoder().encode(text))).toBe(text);
    expect(decodeBestEffort(new TextEncoder().encode("texto corto"))).toBe("texto corto");
  });
});

describe("decodeByteChunksStream (streaming, mejora de memoria de la ronda 3 de corrección)", () => {
  async function collect(gen: AsyncGenerator<string>): Promise<string> {
    let out = "";
    for await (const chunk of gen) out += chunk;
    return out;
  }

  async function* asyncChunks(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
    for (const c of chunks) yield c;
  }

  it("decodifica UTF-8 aunque un carácter multibyte quede dividido EXACTAMENTE en la frontera entre dos chunks", async () => {
    const text = "café con leche, año 2026, adquisición";
    const bytes = new TextEncoder().encode(text);
    const cut = bytes.indexOf(0xc3) + 1; // corta justo después del byte líder de una secuencia UTF-8 de 2 bytes.
    expect(cut).toBeGreaterThan(0);
    const result = await collect(decodeByteChunksStream(asyncChunks([bytes.subarray(0, cut), bytes.subarray(cut)])));
    expect(result).toBe(text);
  });

  it("decodifica Latin-1 en streaming (heurística de contenido) cuando los bytes no son UTF-8 válido, dividido en dos chunks", async () => {
    const text = "cañería, año, señalización";
    const bytes = new Uint8Array(Buffer.from(text, "latin1"));
    const mid = Math.floor(bytes.length / 2);
    const result = await collect(decodeByteChunksStream(asyncChunks([bytes.subarray(0, mid), bytes.subarray(mid)])));
    expect(result).toBe(text);
  });

  it("usa el charset declarado (Content-Type) igual que decodeBestEffort", async () => {
    const bytes = new Uint8Array(Buffer.from("Instalación de cañería", "latin1"));
    const result = await collect(decodeByteChunksStream(asyncChunks([bytes]), "iso-8859-1"));
    expect(result).toBe("Instalación de cañería");
  });

  it("quita un BOM UTF-8 explícito antes de decodificar", async () => {
    const text = "codigo_contrato,proveedor";
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    const result = await collect(decodeByteChunksStream(asyncChunks([withBom])));
    expect(result).toBe(text);
  });

  it("SR-22: decodifica UTF-16LE con BOM también en la ruta de streaming", async () => {
    const text = "linea uno\nlinea dos";
    const withBom = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
    const result = await collect(decodeByteChunksStream(asyncChunks([withBom])));
    expect(result).toBe(text);
  });

  it("un stream vacío produce texto vacío sin lanzar", async () => {
    const result = await collect(decodeByteChunksStream(asyncChunks([])));
    expect(result).toBe("");
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
