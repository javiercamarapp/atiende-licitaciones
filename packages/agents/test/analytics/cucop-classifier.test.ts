import { describe, expect, it } from "vitest";
import { classifyCucop, CUCOP_PRECISION_THRESHOLD, runCucopBenchmark, type CucopCatalogPort } from "../../src/analytics/cucop-classifier.js";
import { createSyntheticCucopCatalog, SYNTHETIC_CUCOP_CATALOG } from "./fixtures/synthetic-cucop-catalog.js";
import { SYNTHETIC_CUCOP_GOLDSET } from "./fixtures/synthetic-cucop-goldset.js";

describe("classifyCucop", () => {
  const catalog = createSyntheticCucopCatalog();

  it("rankea el código correcto en primer lugar cuando el texto coincide claramente con una sola descripción", () => {
    const candidates = classifyCucop("Contratación de servicio de limpieza integral de oficinas", catalog);
    expect(candidates[0]?.code).toBe("TEST-10101");
    expect(candidates[0]?.matchedTerms.length).toBeGreaterThan(0);
  });

  it("respeta topK", () => {
    const candidates = classifyCucop("servicios", catalog, 3);
    expect(candidates.length).toBeLessThanOrEqual(3);
  });

  it("texto sin ninguna palabra en común con el catálogo devuelve lista vacía (nunca inventa un candidato)", () => {
    const candidates = classifyCucop("xyzxyz qwqwqw zzzzzz", catalog);
    expect(candidates).toEqual([]);
  });

  it("texto vacío devuelve lista vacía", () => {
    expect(classifyCucop("", catalog)).toEqual([]);
    expect(classifyCucop("   ", catalog)).toEqual([]);
  });

  it("catálogo vacío devuelve lista vacía sin lanzar", () => {
    const empty: CucopCatalogPort = { entries: () => [] };
    expect(classifyCucop("cualquier texto", empty)).toEqual([]);
  });

  it("el orden es determinista: misma entrada produce siempre el mismo resultado", () => {
    const a = classifyCucop("Adquisición de computadoras portátiles", catalog);
    const b = classifyCucop("Adquisición de computadoras portátiles", catalog);
    expect(a).toEqual(b);
  });

  it("es insensible a mayúsculas/acentos (normaliza antes de tokenizar)", () => {
    const a = classifyCucop("ADQUISICIÓN DE COMPUTADORAS PORTÁTILES", catalog);
    const b = classifyCucop("adquisicion de computadoras portatiles", catalog);
    expect(a[0]?.code).toBe(b[0]?.code);
    expect(a[0]?.code).toBe("TEST-20201");
  });

  it("desempata por código ascendente cuando dos candidatos tienen exactamente el mismo score", () => {
    // catálogo simétrico: dos entradas con exactamente las mismas palabras -> mismo score
    const symmetric: CucopCatalogPort = {
      entries: () => [
        { code: "TEST-999", description: "alfa beta gamma" },
        { code: "TEST-001", description: "alfa beta gamma" },
      ],
    };
    const candidates = classifyCucop("alfa beta gamma", symmetric);
    expect(candidates[0]?.code).toBe("TEST-001");
    expect(candidates[1]?.code).toBe("TEST-999");
  });
});

describe("runCucopBenchmark (REQ-002: precision@5 ≥0.6)", () => {
  it("sobre el catálogo y gold set SINTÉTICOS, el pipeline completo alcanza el umbral (prueba de que el motor funciona, no del catálogo/gold set real pendiente)", () => {
    const result = runCucopBenchmark(SYNTHETIC_CUCOP_GOLDSET, createSyntheticCucopCatalog(), 5);
    expect(result.n).toBe(SYNTHETIC_CUCOP_GOLDSET.length);
    expect(result.k).toBe(5);
    expect(result.precisionAtK).toBeGreaterThanOrEqual(CUCOP_PRECISION_THRESHOLD);
    expect(result.meetsAcceptanceThreshold).toBe(true);
  });

  it("un gold set completamente desalineado del catálogo reporta precisión baja honesta, no fabricada", () => {
    const misaligned = SYNTHETIC_CUCOP_GOLDSET.map((c) => ({ ...c, text: "contenido irrelevante sin relación xyz" }));
    const result = runCucopBenchmark(misaligned, createSyntheticCucopCatalog(), 5);
    expect(result.precisionAtK).toBe(0);
    expect(result.meetsAcceptanceThreshold).toBe(false);
  });

  it("gold set vacío reporta precisión 0, nunca 1 por vacuidad", () => {
    const result = runCucopBenchmark([], createSyntheticCucopCatalog(), 5);
    expect(result.n).toBe(0);
    expect(result.precisionAtK).toBe(0);
    expect(result.meetsAcceptanceThreshold).toBe(false);
  });

  it("perCase trae los candidatos reales devueltos por classifyCucop para poder auditar cada acierto/fallo", () => {
    const result = runCucopBenchmark(SYNTHETIC_CUCOP_GOLDSET.slice(0, 1), createSyntheticCucopCatalog(), 5);
    expect(result.perCase[0].id).toBe(SYNTHETIC_CUCOP_GOLDSET[0].id);
    expect(result.perCase[0].candidates.length).toBeGreaterThan(0);
  });

  it("el catálogo sintético tiene al menos 10 entradas (suficiente para que el TF-IDF interno sea no trivial)", () => {
    expect(SYNTHETIC_CUCOP_CATALOG.length).toBeGreaterThanOrEqual(10);
  });
});
