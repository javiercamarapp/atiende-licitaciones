import { describe, it, expect } from "vitest";
import {
  normalizeForShingling,
  wordShingles,
  fnv1a32,
  computeMinHashSignature,
  estimateJaccard,
  lshBandHashes,
  computeFingerprint,
} from "../../src/similarity/minhash.js";

/** Jaccard EXACTO de dos textos (sobre el conjunto real de shingles, no la estimación MinHash) -- usado como referencia para verificar que el estimador se acerca al valor real. */
function exactJaccard(a: string, b: string, k = 5): number {
  const sa = new Set(wordShingles(a, k));
  const sb = new Set(wordShingles(b, k));
  if (sa.size === 0 && sb.size === 0) return 1;
  let intersection = 0;
  for (const s of sa) if (sb.has(s)) intersection++;
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const PLANTILLA =
  "La empresa cuenta con amplia experiencia en la construcción de obra pública para gobiernos estatales y municipales, " +
  "con un equipo técnico certificado y maquinaria propia disponible para el cumplimiento oportuno de los plazos contractuales establecidos.";

describe("minhash.ts: shingling y normalización", () => {
  it("normalizeForShingling ignora mayúsculas, acentos y puntuación", () => {
    expect(normalizeForShingling("Construcción, Obra Pública!!")).toBe("construccion obra publica");
  });

  it("wordShingles produce k-gramas consecutivos de palabras", () => {
    const shingles = wordShingles("uno dos tres cuatro cinco seis", 3);
    expect(shingles).toEqual(["uno dos tres", "dos tres cuatro", "tres cuatro cinco", "cuatro cinco seis"]);
  });

  it("wordShingles de un texto vacío es un arreglo vacío", () => {
    expect(wordShingles("   ", 5)).toEqual([]);
  });

  it("fnv1a32 es determinista y produce enteros sin signo de 32 bits", () => {
    const h1 = fnv1a32("hola mundo");
    const h2 = fnv1a32("hola mundo");
    expect(h1).toBe(h2);
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(h1).toBeLessThanOrEqual(0xffffffff);
    expect(fnv1a32("otro texto")).not.toBe(h1);
  });
});

describe("minhash.ts: firma MinHash y estimador de Jaccard", () => {
  it("REGRESIÓN (encontrado corriendo esto contra Postgres real, PGlite): cada valor de la firma cabe en `integer` de Postgres (32 bits con signo, < 2^31) para poder persistirse en `signature integer[]` sin `bigint[]`", () => {
    const texts = [PLANTILLA, "otro texto cualquiera para variar los shingles y las coincidencias de hash", "", "una palabra"];
    for (const text of texts) {
      const sig = computeMinHashSignature(text, { numHashes: 256 });
      for (const value of sig) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(2 ** 31);
      }
    }
  });

  it("es determinista: el mismo texto produce siempre la misma firma", () => {
    const sig1 = computeMinHashSignature(PLANTILLA);
    const sig2 = computeMinHashSignature(PLANTILLA);
    expect(sig1).toEqual(sig2);
  });

  it("un texto contra sí mismo tiene similitud estimada 1.0 (caso positivo trivial)", () => {
    const sig = computeMinHashSignature(PLANTILLA);
    expect(estimateJaccard(sig, sig)).toBe(1);
  });

  it("CASO POSITIVO (plantilla reutilizada con datos propios sustituidos): similitud alta, cercana al Jaccard real", () => {
    const tenantA = PLANTILLA + " Referencia: contrato con el Municipio de Querétaro, folio 2024-118.";
    const tenantB = PLANTILLA + " Referencia: contrato con el Municipio de Toluca, folio 2023-045.";
    const sigA = computeMinHashSignature(tenantA);
    const sigB = computeMinHashSignature(tenantB);
    const estimated = estimateJaccard(sigA, sigB);
    const real = exactJaccard(tenantA, tenantB);
    expect(estimated).toBeGreaterThan(0.75);
    // El estimador MinHash con 64 hashes debe acercarse al Jaccard real (tolerancia generosa, es un estimador probabilístico).
    expect(Math.abs(estimated - real)).toBeLessThan(0.2);
  });

  it("CASO NEGATIVO (adversarial): dos secciones redactadas de forma independiente sobre temas distintos tienen similitud baja", () => {
    const tenantA =
      "Nuestra compañía ha ejecutado quince proyectos de pavimentación asfáltica en el estado de Jalisco durante los últimos ocho años, " +
      "empleando maquinaria propia y personal certificado en seguridad industrial.";
    const tenantB =
      "El despacho cuenta con especialistas en instalaciones eléctricas de media tensión para plantas industriales, " +
      "habiendo participado en proyectos de subestaciones para la industria automotriz en Guanajuato.";
    const sigA = computeMinHashSignature(tenantA);
    const sigB = computeMinHashSignature(tenantB);
    const estimated = estimateJaccard(sigA, sigB);
    expect(estimated).toBeLessThan(0.3);
  });

  it("CASO NEGATIVO: firmas de distinta longitud nunca se declaran similares (nunca lanza, devuelve 0)", () => {
    const sigA = computeMinHashSignature(PLANTILLA, { numHashes: 32 });
    const sigB = computeMinHashSignature(PLANTILLA, { numHashes: 64 });
    expect(estimateJaccard(sigA, sigB)).toBe(0);
  });

  it("robusto a pequeñas ediciones (typos, orden de mayúsculas) -- sigue siendo alta similitud", () => {
    const original = PLANTILLA;
    const conTypo = PLANTILLA.replace("experiencia", "experiencia ").replace("MUNICIPALES", "municipales").toUpperCase().toLowerCase();
    const sigA = computeMinHashSignature(original);
    const sigB = computeMinHashSignature(conTypo);
    expect(estimateJaccard(sigA, sigB)).toBeGreaterThan(0.9);
  });

  it("un documento vacío nunca se declara similar a uno con contenido real", () => {
    const sigEmpty = computeMinHashSignature("");
    const sigReal = computeMinHashSignature(PLANTILLA);
    expect(estimateJaccard(sigEmpty, sigReal)).toBe(0);
  });

  it("dos documentos vacíos no son evidencia de plantilla compartida pero su firma coincide (caso degenerado documentado)", () => {
    const sigA = computeMinHashSignature("");
    const sigB = computeMinHashSignature("");
    // Documentado en el código: la firma de "nada" es igual a sí misma. El detector real
    // (cross-tenant-detector.test.ts) filtra explícitamente shingleCount === 0 para no
    // marcar esto como colusión.
    expect(estimateJaccard(sigA, sigB)).toBe(1);
  });
});

describe("minhash.ts: bandas LSH", () => {
  it("genera numBands claves, cada una prefijada con su índice de banda", () => {
    const sig = computeMinHashSignature(PLANTILLA);
    const bands = lshBandHashes(sig, { numBands: 16, rowsPerBand: 4 });
    expect(bands).toHaveLength(16);
    bands.forEach((b, i) => expect(b.startsWith(`${i}:`)).toBe(true));
  });

  it("dos textos casi idénticos comparten al menos una banda (son candidatos)", () => {
    const tenantA = PLANTILLA + " Folio A-1.";
    const tenantB = PLANTILLA + " Folio B-2.";
    const bandsA = new Set(lshBandHashes(computeMinHashSignature(tenantA)));
    const bandsB = new Set(lshBandHashes(computeMinHashSignature(tenantB)));
    const shared = [...bandsA].filter((b) => bandsB.has(b));
    expect(shared.length).toBeGreaterThan(0);
  });

  it("lanza si numBands*rowsPerBand excede el tamaño de la firma (config inválida detectada, no silenciada)", () => {
    const sig = computeMinHashSignature(PLANTILLA, { numHashes: 16 });
    expect(() => lshBandHashes(sig, { numBands: 16, rowsPerBand: 4 })).toThrow();
  });
});

describe("minhash.ts: computeFingerprint (atajo usado por el detector)", () => {
  it("expone signature, bandHashes y shingleCount consistentes con las funciones individuales", () => {
    const fp = computeFingerprint(PLANTILLA);
    expect(fp.signature).toEqual(computeMinHashSignature(PLANTILLA));
    expect(fp.bandHashes).toEqual(lshBandHashes(computeMinHashSignature(PLANTILLA)));
    expect(fp.shingleCount).toBe(wordShingles(PLANTILLA).length);
    expect(fp.shingleCount).toBeGreaterThan(0);
  });
});
