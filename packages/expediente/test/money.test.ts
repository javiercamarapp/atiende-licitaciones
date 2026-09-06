import { describe, expect, it } from "vitest";
import { addCents, fromCents, multiplyQuantityHalfUp, multiplyRateHalfUp, sumCents, toCents } from "../src/money.js";

describe("money (REQ-029 aritmética determinista half-up)", () => {
  it("convierte cadenas decimales a centavos y de vuelta sin pérdida", () => {
    expect(toCents("1234.56")).toBe(123456n);
    expect(toCents("100")).toBe(10000n);
    expect(toCents("0.05")).toBe(5n);
    expect(fromCents(123456n)).toBe("1234.56");
    expect(fromCents(10000n)).toBe("100.00");
  });

  it("rechaza cadenas decimales inválidas", () => {
    expect(() => toCents("12.345")).toThrow();
    expect(() => toCents("abc")).toThrow();
  });

  it("redondea half-up al calcular IVA sobre montos con residuo exacto de 0.5 centavo", () => {
    // 12.505 -> con tasa 0.1 sobre 125.05 centavos: 125.05*10=1250.5 -> half-up a 1251 -> pero usamos micros
    // Caso concreto y verificable a mano: subtotal 100.05, iva 16% => 1600.8 micro-centavos de iva exacto: 100.05*0.16=16.008 -> 1600.8 (unidades 1e-6 de centavo) round -> 1601 -> pero necesitamos casos con .5 exacto
    const cents = toCents("12.50"); // 1250 centavos
    const iva = multiplyRateHalfUp(cents, 0.001); // 1250 * 0.001 = 1.25 centavos -> half-up a 1 (no .5)
    expect(iva).toBe(1n);

    const halfCase = multiplyRateHalfUp(50n, 0.01); // 50 * 0.01 = 0.5 centavos exactos -> half-up sube a 1
    expect(halfCase).toBe(1n);
  });

  it("calcula IVA 16% determinista sobre un subtotal real", () => {
    const subtotal = toCents("1000.00");
    const iva = multiplyRateHalfUp(subtotal, 0.16);
    expect(fromCents(iva)).toBe("160.00");
  });

  it("multiplica cantidad por precio unitario con half-up", () => {
    const unitPrice = toCents("33.33");
    const subtotal = multiplyQuantityHalfUp(unitPrice, 3);
    expect(fromCents(subtotal)).toBe("99.99");
  });

  it("suma centavos de una lista de montos", () => {
    const total = sumCents([toCents("10.10"), toCents("20.20"), toCents("0.01")]);
    expect(fromCents(total)).toBe("30.31");
  });

  it("addCents es asociativo con enteros bigint simples", () => {
    expect(addCents(100n, 200n)).toBe(300n);
  });

  describe("EX-EXP-09: cota superior de quantity en multiplyQuantityHalfUp", () => {
    it("rechaza una cantidad absurda (1e10) que podría perder precisión silenciosamente", () => {
      const unitPrice = toCents("10.00");
      expect(() => multiplyQuantityHalfUp(unitPrice, 1e10)).toThrow(/quantity/);
    });

    it("acepta cantidades realistas de licitación (unidades/horas/servicios, típicamente < 10^6)", () => {
      const unitPrice = toCents("100.00");
      expect(() => multiplyQuantityHalfUp(unitPrice, 500_000)).not.toThrow();
    });
  });
});
