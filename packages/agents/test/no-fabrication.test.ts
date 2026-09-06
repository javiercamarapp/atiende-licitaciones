import { describe, expect, it } from "vitest";
import { NoFabricationPolicy, scanForUnsourcedSensitiveData, sourcedValueSchema, type SourcedValue } from "../src/no-fabrication.js";
import { z } from "zod";

describe("NoFabricationPolicy", () => {
  it("marca 'pendiente_no_evaluable' con la lista exacta de campos faltantes cuando falta el valor", () => {
    const policy = new NoFabricationPolicy();
    const values: SourcedValue[] = [
      { kind: "precio", fieldName: "precioUnitario", value: null, approvedSourceRef: null },
      { kind: "certificacion", fieldName: "iso9001", value: "vigente", approvedSourceRef: { docId: "d1", capturedAt: "2026-01-01" } },
    ];
    const result = policy.evaluate(values);
    expect(result).toEqual({ status: "pendiente_no_evaluable", missing: ["precioUnitario"] });
  });

  it("marca 'pendiente_no_evaluable' cuando el valor existe pero falta approvedSourceRef", () => {
    const policy = new NoFabricationPolicy();
    const result = policy.evaluate([
      { kind: "vigencia", fieldName: "opinionSat", value: "2026-12-31", approvedSourceRef: null },
    ]);
    expect(result.status).toBe("pendiente_no_evaluable");
    if (result.status === "pendiente_no_evaluable") {
      expect(result.missing).toEqual(["opinionSat"]);
    }
  });

  it("nunca produce un valor 'evaluable' parcial: si falta cualquiera, todos quedan pendientes", () => {
    const policy = new NoFabricationPolicy();
    const result = policy.evaluate([
      { kind: "precio", fieldName: "a", value: 100, approvedSourceRef: { docId: "d1", capturedAt: "t" } },
      { kind: "experiencia", fieldName: "b", value: null, approvedSourceRef: null },
      { kind: "referencia", fieldName: "c", value: "cliente-x", approvedSourceRef: null },
    ]);
    expect(result.status).toBe("pendiente_no_evaluable");
    if (result.status === "pendiente_no_evaluable") {
      expect(result.missing.sort()).toEqual(["b", "c"]);
    }
  });

  it("retorna 'evaluable' con los valores cuando todos traen fuente aprobada", () => {
    const policy = new NoFabricationPolicy();
    const result = policy.evaluate([
      { kind: "precio", fieldName: "precioUnitario", value: 1234.5, approvedSourceRef: { docId: "tarifario-2026", capturedAt: "2026-01-01" } },
      { kind: "firma", fieldName: "representanteLegal", value: "Juan Pérez", approvedSourceRef: { docId: "poder-notarial", page: 3, capturedAt: "2026-01-01" } },
    ]);
    expect(result).toEqual({
      status: "evaluable",
      values: { precioUnitario: 1234.5, representanteLegal: "Juan Pérez" },
    });
  });

  it("evaluateOne() es azúcar sintáctica sobre evaluate() para un solo campo", () => {
    const policy = new NoFabricationPolicy();
    const missing = policy.evaluateOne({ kind: "referencia", fieldName: "cliente", value: undefined, approvedSourceRef: undefined });
    expect(missing.status).toBe("pendiente_no_evaluable");
  });

  it("sourcedValueSchema valida la forma {value, approvedSourceRef} con value/ref anulables", () => {
    const schema = sourcedValueSchema(z.number());
    expect(schema.safeParse({ value: 10, approvedSourceRef: { docId: "d1", capturedAt: "t" } }).success).toBe(true);
    expect(schema.safeParse({ value: null, approvedSourceRef: null }).success).toBe(true);
    expect(schema.safeParse({ value: "no-es-numero", approvedSourceRef: null }).success).toBe(false);
  });

  describe("AG-10 (ALTA): scanForUnsourcedSensitiveData — evaluación por defecto, no opt-in", () => {
    it("detecta un campo sensible por sinónimo (costo/vigente_hasta) sin approvedSourceRef, anidado en un array", () => {
      const findings = scanForUnsourcedSensitiveData({
        items: [{ costo: 1000, vigente_hasta: "2026-12-31" }],
      });
      const kinds = findings.map((f) => f.kind).sort();
      expect(kinds).toContain("precio");
      expect(kinds).toContain("vigencia");
    });

    it("no reporta nada si approvedSourceRef está presente junto al campo sensible (mismo objeto)", () => {
      const findings = scanForUnsourcedSensitiveData({
        precio: 100,
        approvedSourceRef: { docId: "d1", capturedAt: "t" },
      });
      expect(findings).toEqual([]);
    });

    it("reconoce la convención anidada {value, approvedSourceRef}", () => {
      const sourced = scanForUnsourcedSensitiveData({
        precio: { value: 100, approvedSourceRef: { docId: "d1", capturedAt: "t" } },
      });
      expect(sourced).toEqual([]);

      const unsourced = scanForUnsourcedSensitiveData({ precio: { value: 100, approvedSourceRef: null } });
      expect(unsourced.length).toBeGreaterThan(0);
    });

    it("detecta números/fechas sospechosos en texto libre junto a una palabra clave sensible", () => {
      const findings = scanForUnsourcedSensitiveData({
        resumen: "El precio final es de $1500 y está vigente hasta 2026-12-31",
      });
      expect(findings.some((f) => f.kind === "texto_libre")).toBe(true);
    });

    it("no genera falsos positivos en texto libre sin palabras clave sensibles (aunque tenga fecha)", () => {
      const findings = scanForUnsourcedSensitiveData({
        resumen: "La convocatoria 123 tiene 4 partidas y cierra el 2026-12-31",
      });
      expect(findings).toEqual([]);
    });

    it("no reporta nada para campos comunes no sensibles (count, title)", () => {
      expect(scanForUnsourcedSensitiveData({ count: 1, title: "convocatoria 123" })).toEqual([]);
    });

    it("cada hallazgo trae fieldName (para cruzar con extractSensitiveValues) y path completo", () => {
      const [finding] = scanForUnsourcedSensitiveData({ items: [{ costo: 1000 }] });
      expect(finding.fieldName).toBe("costo");
      expect(finding.path).toContain("costo");
    });
  });
});
