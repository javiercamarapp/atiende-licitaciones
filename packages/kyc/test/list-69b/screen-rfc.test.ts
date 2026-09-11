import { describe, expect, it } from "vitest";
import { indexEntriesByRfc, screenRfcAgainstEntries } from "../../src/list-69b/screen-rfc.js";
import type { NegativeListEntry } from "../../src/types.js";

const ENTRIES: NegativeListEntry[] = [
  { rfc: "AAA080808HL8", nombreContribuyente: "Sentencia favorable co.", situacion: "Sentencia Favorable" },
  { rfc: "AAA091014835", nombreContribuyente: "Desvirtuado co.", situacion: "Desvirtuado" },
  { rfc: "AAAA730727JE3", nombreContribuyente: "Presunto persona", situacion: "Presunto" },
  { rfc: "AAC0608103B5", nombreContribuyente: "Definitivo co.", situacion: "Definitivo" },
  { rfc: "ZZZ010101AB1", nombreContribuyente: "Categoría futura del SAT", situacion: "Vinculado a Fraude Fiscal Nuevo" },
];

describe("screenRfcAgainstEntries", () => {
  const index = indexEntriesByRfc(ENTRIES);

  it("RFC en lista 69-B Definitivo -> verdict suspended (REQ-026 tolerancia cero)", () => {
    const result = screenRfcAgainstEntries("aac0608103b5", index);
    expect(result.matched).toBe(true);
    expect(result.verdict).toBe("suspended");
  });

  it("RFC en Presunto -> flagged, no suspended (aún desvirtuable)", () => {
    const result = screenRfcAgainstEntries("AAAA730727JE3", index);
    expect(result.verdict).toBe("flagged");
  });

  it("RFC en Desvirtuado -> clear (el propio SAT confirma que ya salió)", () => {
    const result = screenRfcAgainstEntries("AAA091014835", index);
    expect(result.verdict).toBe("clear");
  });

  it("RFC en Sentencia Favorable -> clear", () => {
    const result = screenRfcAgainstEntries("AAA080808HL8", index);
    expect(result.verdict).toBe("clear");
  });

  it("caso negativo: RFC que no aparece en el listado -> clear, matched=false", () => {
    const result = screenRfcAgainstEntries("NOEXISTE010101XX1", index);
    expect(result.matched).toBe(false);
    expect(result.verdict).toBe("clear");
  });

  it("adversarial: espacios/guiones/minúsculas en el RFC no evaden el cruce", () => {
    const result = screenRfcAgainstEntries("  aac-0608103-b5  ", index);
    expect(result.matched).toBe(true);
    expect(result.verdict).toBe("suspended");
  });

  it("adversarial: una categoría del SAT no contemplada NUNCA se trata como clear -- flagged conservador", () => {
    const result = screenRfcAgainstEntries("ZZZ010101AB1", index);
    expect(result.matched).toBe(true);
    expect(result.verdict).toBe("flagged");
  });
});
