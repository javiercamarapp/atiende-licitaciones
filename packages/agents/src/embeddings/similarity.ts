/**
 * Similitud coseno entre dos vectores de la misma dimensión. Puro/determinista
 * (REQ-006): es el cálculo que reemplaza a `<=>` de pgvector cuando la
 * extensión no está disponible en el entorno (fallback determinista de
 * matching semántico, ver `apps/api/src/modules/matching/semantic.ts`).
 *
 * Devuelve un número en [-1, 1]; 0 si algún vector es todo ceros (norma 0),
 * nunca NaN/Infinity.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new RangeError(`cosineSimilarity: dimensiones distintas (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Normaliza un vector a norma L2 = 1 (si la norma es 0, lo devuelve sin cambios: nunca produce NaN por división entre 0). */
export function l2normalize(vec: readonly number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec.slice();
  return vec.map((v) => v / norm);
}
