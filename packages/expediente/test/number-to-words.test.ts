import { describe, expect, it } from "vitest";
import { centsToPesosWords, integerToWords } from "../src/number-to-words.js";

describe("integerToWords (REQ-031 motor propio de cantidad con letra)", () => {
  const cases: Array<[number, string]> = [
    [0, "cero"],
    [1, "uno"],
    [16, "dieciséis"],
    [21, "veintiuno"],
    [22, "veintidós"],
    [30, "treinta"],
    [31, "treinta y uno"],
    [100, "cien"],
    [101, "ciento uno"],
    [200, "doscientos"],
    [999, "novecientos noventa y nueve"],
    [1000, "mil"],
    [1001, "mil uno"],
    [2000, "dos mil"],
    [21000, "veintiún mil"],
    [100000, "cien mil"],
    [123456, "ciento veintitrés mil cuatrocientos cincuenta y seis"],
    [1000000, "un millón"],
    [2000000, "dos millones"],
    [1500000, "un millón quinientos mil"],
    [999999999, "novecientos noventa y nueve millones novecientos noventa y nueve mil novecientos noventa y nueve"],
  ];

  it.each(cases)("convierte %i a '%s'", (n, expected) => {
    expect(integerToWords(n)).toBe(expected);
  });

  it("rechaza negativos y no enteros", () => {
    expect(() => integerToWords(-1)).toThrow();
    expect(() => integerToWords(1.5)).toThrow();
  });
});

describe("centsToPesosWords", () => {
  it("formatea un monto con centavos en el formato estándar mexicano", () => {
    const words = centsToPesosWords(123456n); // $1,234.56
    expect(words).toBe("SON: MIL DOSCIENTOS TREINTA Y CUATRO PESOS 56/100 M.N.");
  });

  it("formatea un monto exacto sin centavos", () => {
    const words = centsToPesosWords(100000n); // $1,000.00
    expect(words).toBe("SON: MIL PESOS 00/100 M.N.");
  });

  it("rechaza montos negativos", () => {
    expect(() => centsToPesosWords(-1n)).toThrow();
  });
});
