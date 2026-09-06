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

  describe("AG-19 (MEDIA): scanForUnsourcedSensitiveData también recorre Map/Set/Buffer/Date/JSON embebido", () => {
    it("detecta un campo sensible dentro de un Map (bypass original del hallazgo)", () => {
      const findings = scanForUnsourcedSensitiveData({ datos: new Map([["precio", 999999]]) });
      expect(findings.some((f) => f.kind === "precio")).toBe(true);
    });

    it("un Map con approvedSourceRef como entrada hermana sí cuenta como abastecido", () => {
      const findings = scanForUnsourcedSensitiveData({
        datos: new Map<string, unknown>([
          ["precio", 999999],
          ["approvedSourceRef", { docId: "d1", capturedAt: "t" }],
        ]),
      });
      expect(findings).toEqual([]);
    });

    it("detecta un objeto con campo sensible anidado dentro de un Set (bypass original del hallazgo)", () => {
      const findings = scanForUnsourcedSensitiveData({ datos: new Set([{ precio: 999999 }]) });
      expect(findings.some((f) => f.kind === "precio")).toBe(true);
    });

    it("detecta texto libre sospechoso cuando es un elemento directo (string) de un Set", () => {
      const findings = scanForUnsourcedSensitiveData({
        datos: new Set(["el precio final es de $1500"]),
      });
      expect(findings.some((f) => f.kind === "texto_libre")).toBe(true);
    });

    it("detecta un precio serializado como JSON dentro de un Buffer (bypass original del hallazgo)", () => {
      const buffer = Buffer.from(JSON.stringify({ precio: 999999 }), "utf-8");
      const findings = scanForUnsourcedSensitiveData({ adjunto: buffer });
      expect(findings.some((f) => f.kind === "precio")).toBe(true);
    });

    it("detecta un precio serializado como JSON dentro de un TypedArray (Uint8Array) genérico", () => {
      const bytes = new TextEncoder().encode(JSON.stringify({ costo: 12345 }));
      const findings = scanForUnsourcedSensitiveData({ adjunto: bytes });
      expect(findings.some((f) => f.kind === "precio")).toBe(true);
    });

    it("un Buffer/TypedArray sin nada sensible dentro no genera falsos positivos (basura binaria real)", () => {
      const randomBytes = Buffer.from([0x00, 0xff, 0x10, 0x8a, 0x01, 0x02, 0x03, 0x04]);
      const findings = scanForUnsourcedSensitiveData({ adjunto: randomBytes });
      expect(findings).toEqual([]);
    });

    it("una fecha (objeto Date) bajo una clave NO sensible es una hoja inerte: no se recorre buscando dentro de ella", () => {
      const findings = scanForUnsourcedSensitiveData({ createdAt: new Date("2026-12-31") });
      expect(findings).toEqual([]);
    });

    it("una fecha (objeto Date) bajo una clave sensible (vigencia) SÍ se reporta como no abastecida (comportamiento ya existente, no un bypass)", () => {
      const findings = scanForUnsourcedSensitiveData({ vigencia: new Date("2026-12-31") });
      expect(findings.some((f) => f.kind === "vigencia")).toBe(true);
    });

    it("detecta un precio serializado como JSON dentro de un string (JSON.stringify sin approvedSourceRef)", () => {
      const findings = scanForUnsourcedSensitiveData({
        payload: JSON.stringify({ precio: 999999 }),
      });
      expect(findings.some((f) => f.kind === "precio")).toBe(true);
    });

    it("detecta JSON embebido con texto alrededor (no solo cuando el string ENTERO es JSON puro)", () => {
      const findings = scanForUnsourcedSensitiveData({
        payload: `respuesta_cruda: ${JSON.stringify({ precio: 999999 })} (fin)`,
      });
      expect(findings.some((f) => f.kind === "precio")).toBe(true);
    });

    it("un string con approvedSourceRef ya presente en el JSON embebido no genera hallazgo", () => {
      const findings = scanForUnsourcedSensitiveData({
        payload: JSON.stringify({ precio: 999999, approvedSourceRef: { docId: "d1", capturedAt: "t" } }),
      });
      expect(findings).toEqual([]);
    });

    it("un string normal con llaves que NO es JSON válido no genera falsos positivos ni lanza", () => {
      expect(() =>
        scanForUnsourcedSensitiveData({ resumen: "el precio {ver anexo} está pendiente de confirmar" }),
      ).not.toThrow();
    });

    it("un Map anidado dentro de un array anidado dentro de un Set sigue siendo detectado (combinación de contenedores)", () => {
      const findings = scanForUnsourcedSensitiveData({
        raiz: new Set([[new Map([["precio", 1]])]]),
      });
      expect(findings.some((f) => f.kind === "precio")).toBe(true);
    });
  });

  describe("AG-21 (MEDIA): cierre de los 2 bypasses estructurales de AG-19 (Array de nivel superior, truncamiento de binarios) + base64", () => {
    it("detecta texto libre sensible como elemento DIRECTO de un Array de nivel superior (bypass original)", () => {
      const findings = scanForUnsourcedSensitiveData({
        notas: ["hay que pagar un costo de $999,999 sin certificar aun"],
      });
      expect(findings.some((f) => f.kind === "texto_libre")).toBe(true);
    });

    it("detecta texto libre sensible en un Array de nivel superior sin envoltura de objeto", () => {
      const findings = scanForUnsourcedSensitiveData(["el precio final es de $1500 sin fuente"]);
      expect(findings.some((f) => f.kind === "texto_libre")).toBe(true);
    });

    it("detecta texto libre sensible en cualquier combinación de contenedores anidados (Array > Set > Map > Array)", () => {
      const findings = scanForUnsourcedSensitiveData({
        raiz: new Map([["datos", new Set([["el costo final es de $50000 pendiente"]])]]),
      });
      expect(findings.some((f) => f.kind === "texto_libre")).toBe(true);
    });

    it("no genera falso positivo para un elemento de Array sin palabra clave sensible", () => {
      const findings = scanForUnsourcedSensitiveData({ notas: ["la convocatoria cierra el 2026-12-31"] });
      expect(findings).toEqual([]);
    });

    it("detecta un JSON sensible en un Buffer colocado DESPUÉS del offset 8192 (bypass original: antes se truncaba en silencio)", () => {
      const json = JSON.stringify({ precio: 999999 });
      const buffer = bufferWithEmbeddedJsonAt(9000, json, 12_000);
      const findings = scanForUnsourcedSensitiveData({ adjunto: buffer });
      expect(findings.some((f) => f.kind === "precio")).toBe(true);
    });

    it("detecta un JSON sensible que cae exactamente a caballo entre dos ventanas de decodificación", () => {
      // La ventana 1 cubre bytes [0, 8192): el JSON empieza en 8100 y termina
      // después de 8192, así que la ventana 1 lo trunca (JSON inválido). La
      // ventana 2 (offset 7680, solape de 512 bytes) lo cubre completo.
      const json = JSON.stringify({ precio: 999999 });
      const buffer = bufferWithEmbeddedJsonAt(8100, json, 12_000);
      const findings = scanForUnsourcedSensitiveData({ adjunto: buffer });
      expect(findings.some((f) => f.kind === "precio")).toBe(true);
    });

    it("un Buffer que excede el límite total configurable produce 'no_evaluable' en vez de dejarlo pasar sin examinar", () => {
      const big = Buffer.alloc(1000, 0x41);
      const findings = scanForUnsourcedSensitiveData({ adjunto: big }, { maxBinaryTotalBytes: 500 });
      expect(findings).toEqual([{ path: "$.adjunto", fieldName: "adjunto", kind: "no_evaluable" }]);
    });

    it("un Buffer dentro del límite total configurable se escanea con normalidad (no 'no_evaluable')", () => {
      const json = JSON.stringify({ precio: 999999 });
      const buffer = bufferWithEmbeddedJsonAt(100, json, 2000);
      const findings = scanForUnsourcedSensitiveData({ adjunto: buffer }, { maxBinaryTotalBytes: 5000 });
      expect(findings.some((f) => f.kind === "precio")).toBe(true);
      expect(findings.some((f) => f.kind === "no_evaluable")).toBe(false);
    });

    it("detecta un JSON sensible codificado en base64 como string plano (heurística de base64)", () => {
      const json = JSON.stringify({ precio: 999999, vigencia: "2026-01-01" });
      const encoded = Buffer.from(json, "utf-8").toString("base64");
      const findings = scanForUnsourcedSensitiveData({ payload: encoded });
      expect(findings.some((f) => f.kind === "precio")).toBe(true);
    });

    it("un string base64 que decodifica a texto plano SIN forma de JSON no genera un hallazgo (evita falsos positivos)", () => {
      const encoded = Buffer.from(
        "hola mundo esto es un texto normal sin nada sensible ni forma de json",
        "utf-8",
      ).toString("base64");
      const findings = scanForUnsourcedSensitiveData({ payload: encoded });
      expect(findings).toEqual([]);
    });

    it("un string corto que 'parece' base64 por alfabeto no se trata como candidato (evita falsos positivos triviales)", () => {
      expect(() => scanForUnsourcedSensitiveData({ id: "abcd" })).not.toThrow();
      expect(scanForUnsourcedSensitiveData({ id: "abcd" })).toEqual([]);
    });

    it("un string base64 sintácticamente válido pero cuyos bytes no son UTF-8 válido no genera un hallazgo ni lanza", () => {
      const garbage = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02, 0x03, 0xfd, 0xfc, 0x10, 0x20, 0x30, 0x40]).toString(
        "base64",
      );
      expect(() => scanForUnsourcedSensitiveData({ id: garbage })).not.toThrow();
      expect(scanForUnsourcedSensitiveData({ id: garbage })).toEqual([]);
    });
  });
});

/**
 * Construye un Buffer de `totalLength` bytes, relleno con 'A' (sin llaves ni
 * corchetes, para no interferir con `findJsonCandidates`), con el JSON dado
 * copiado a partir de `offset`.
 */
function bufferWithEmbeddedJsonAt(offset: number, json: string, totalLength: number): Buffer {
  const jsonBytes = Buffer.from(json, "utf-8");
  if (offset + jsonBytes.length > totalLength) {
    throw new Error("bufferWithEmbeddedJsonAt: totalLength insuficiente para offset + json");
  }
  const buffer = Buffer.alloc(totalLength, 0x41); // 'A'
  jsonBytes.copy(buffer, offset);
  return buffer;
}
