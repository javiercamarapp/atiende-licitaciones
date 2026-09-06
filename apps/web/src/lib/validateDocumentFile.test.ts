import { describe, expect, it } from "vitest";

import { MAX_DOCUMENT_SIZE_BYTES, validateDocumentFile } from "@/lib/validateDocumentFile";

function makeFile(name: string, size: number, type: string): Pick<File, "name" | "size" | "type"> {
  return { name, size, type };
}

describe("validateDocumentFile (WI-02, REQ-098)", () => {
  it("acepta un PDF real de tamaño normal", () => {
    const result = validateDocumentFile(makeFile("constancia.pdf", 1024 * 500, "application/pdf"));
    expect(result.ok).toBe(true);
  });

  it("acepta por MIME aunque la extensión no calce exactamente (p. ej. .jpeg vs .jpg)", () => {
    const result = validateDocumentFile(makeFile("foto", 1000, "image/jpeg"));
    expect(result.ok).toBe(true);
  });

  it.each([".cer", ".key", ".pfx", ".p12", ".der", ".pem"])(
    "rechaza SIEMPRE un archivo de e.firma (%s) — REQ-098, tolerancia cero",
    (extension) => {
      const result = validateDocumentFile(makeFile(`credencial${extension}`, 100, "application/octet-stream"));
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/REQ-098|e\.firma/);
    },
  );

  it("rechaza un archivo más grande que el límite de 22MB", () => {
    const result = validateDocumentFile(makeFile("grande.pdf", MAX_DOCUMENT_SIZE_BYTES + 1, "application/pdf"));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/22 MB/);
  });

  it("acepta un archivo exactamente en el límite de 22MB", () => {
    const result = validateDocumentFile(makeFile("limite.pdf", MAX_DOCUMENT_SIZE_BYTES, "application/pdf"));
    expect(result.ok).toBe(true);
  });

  it("rechaza un tipo de archivo no admitido (ni extensión ni MIME reconocidos)", () => {
    const result = validateDocumentFile(makeFile("script.exe", 100, "application/x-msdownload"));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no tiene un tipo admitido/);
  });

  it("rechaza un .zip aunque el servidor también lo rechace por magic bytes (defensa en profundidad temprana)", () => {
    const result = validateDocumentFile(makeFile("paquete.zip", 100, "application/zip"));
    expect(result.ok).toBe(false);
  });
});
