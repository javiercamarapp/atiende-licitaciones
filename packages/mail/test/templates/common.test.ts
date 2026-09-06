import { describe, expect, it } from "vitest";
import { BaseVariablesSchema, formatFechaEs } from "../../src/templates/common";

describe("formatFechaEs", () => {
  it("formatea una fecha ISO como 'd de mes de yyyy' en español", () => {
    expect(formatFechaEs("2026-09-06T18:00:00.000Z")).toBe("6 de septiembre de 2026");
  });

  it("formatea el primer día del año (enero)", () => {
    expect(formatFechaEs("2026-01-01T00:00:00.000Z")).toBe("1 de enero de 2026");
  });

  it("devuelve el valor original si no es una fecha válida", () => {
    expect(formatFechaEs("no-es-una-fecha")).toBe("no-es-una-fecha");
  });
});

describe("BaseVariablesSchema", () => {
  it("acepta el mínimo requerido", () => {
    const result = BaseVariablesSchema.safeParse({
      recipientName: "Ana",
      appUrl: "https://app.atiende.mx",
      supportEmail: "soporte@atiende.mx",
    });
    expect(result.success).toBe(true);
  });

  it("rechaza appUrl que no es una URL", () => {
    const result = BaseVariablesSchema.safeParse({ recipientName: "Ana", appUrl: "no-url", supportEmail: "soporte@atiende.mx" });
    expect(result.success).toBe(false);
  });

  it("rechaza supportEmail que no es un correo", () => {
    const result = BaseVariablesSchema.safeParse({ recipientName: "Ana", appUrl: "https://a.mx", supportEmail: "no-correo" });
    expect(result.success).toBe(false);
  });

  it("rechaza recipientName vacío", () => {
    const result = BaseVariablesSchema.safeParse({ recipientName: "", appUrl: "https://a.mx", supportEmail: "a@a.mx" });
    expect(result.success).toBe(false);
  });
});
