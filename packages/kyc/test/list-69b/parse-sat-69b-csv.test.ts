import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeBestEffort } from "@atiende/sources";
import { parseListAsOfLegend, parseSat69BCsvText } from "../../src/list-69b/parse-sat-69b-csv.js";

const FIXTURE_PATH = fileURLToPath(new URL("../fixtures/sat-69b/listado-real-sample.csv", import.meta.url));

function loadRealFixtureText(): string {
  const bytes = readFileSync(FIXTURE_PATH);
  return decodeBestEffort(new Uint8Array(bytes));
}

describe("parseListAsOfLegend", () => {
  it("parsea la leyenda real del SAT a ISO", () => {
    const result = parseListAsOfLegend(
      '"Información actualizada al 31 de diciembre de 2025; los listados a que se hace mención..."',
    );
    expect(result.date).toBe("2025-12-31");
    expect(result.error).toBeUndefined();
  });

  it("rellena el día con cero a la izquierda", () => {
    const result = parseListAsOfLegend("Información actualizada al 5 de marzo de 2019");
    expect(result.date).toBe("2019-03-05");
  });

  it("nunca inventa una fecha cuando el patrón no aparece -- reporta el motivo explícito", () => {
    const result = parseListAsOfLegend("Este archivo no trae ninguna leyenda de fecha reconocible.");
    expect(result.date).toBeNull();
    expect(result.error).toMatch(/no se encontró/i);
  });

  it("nunca inventa una fecha cuando el mes no se reconoce", () => {
    const result = parseListAsOfLegend("Información actualizada al 31 de mesinventado de 2025");
    expect(result.date).toBeNull();
    expect(result.error).toMatch(/no reconocido/i);
  });
});

describe("parseSat69BCsvText contra el fixture REAL descargado en vivo (2026-09-10)", () => {
  const parsed = parseSat69BCsvText(loadRealFixtureText());

  it("extrae la fecha de corte real de la leyenda", () => {
    expect(parsed.listAsOfDate).toBe("2025-12-31");
    expect(parsed.listAsOfParseError).toBeUndefined();
  });

  it("parsea las 30 filas reales sin errores", () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toHaveLength(30);
  });

  it("conserva el RFC y el texto LITERAL de situación de una fila real conocida", () => {
    const entry = parsed.entries.find((e) => e.rfc === "AAA080808HL8");
    expect(entry).toBeDefined();
    expect(entry?.nombreContribuyente).toContain("ASESORES EN AVALÚOS Y ACTIVOS");
    expect(entry?.situacion).toBe("Sentencia Favorable");
  });

  it("incluye las 4 categorías reales de situación (Definitivo, Presunto, Desvirtuado, Sentencia Favorable)", () => {
    const situaciones = new Set(parsed.entries.map((e) => e.situacion));
    expect(situaciones).toEqual(new Set(["Sentencia Favorable", "Desvirtuado", "Presunto", "Definitivo"]));
  });

  it("decodifica correctamente los acentos (Windows-1252 real del SAT)", () => {
    const entry = parsed.entries.find((e) => e.rfc === "AAAA730727JE3");
    expect(entry?.nombreContribuyente).toContain("ABENDAÑO");
  });
});

describe("parseSat69BCsvText -- robustez", () => {
  it("archivo vacío no revienta: devuelve listas vacías, no null/undefined", () => {
    const result = parseSat69BCsvText("");
    expect(result.entries).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.listAsOfRaw).toBeNull();
  });

  it("sin fila de encabezado real (RFC+Situación), reporta un error explícito en vez de adivinar", () => {
    const result = parseSat69BCsvText('"Información actualizada al 1 de enero de 2026"\nsolo,una,fila,cualquiera\n1,2,3,4');
    expect(result.entries).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toMatch(/no se encontró la fila de encabezado real/i);
  });

  it("una fila sin RFC se descarta con su propio error, sin perder las demás filas válidas", () => {
    const csv =
      "Leyenda sin fecha\n" +
      "Titulo\n" +
      "No,RFC,Nombre del Contribuyente,Situación del contribuyente\n" +
      "1,,Sin RFC,Definitivo\n" +
      "2,ABC010101AB1,Con RFC,Presunto\n";
    const result = parseSat69BCsvText(csv);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].rfc).toBe("ABC010101AB1");
    expect(result.errors.some((e) => /sin rfc/i.test(e.message))).toBe(true);
  });
});
