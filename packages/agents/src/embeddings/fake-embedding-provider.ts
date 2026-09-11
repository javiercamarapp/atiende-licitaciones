import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "./provider.js";
import { l2normalize } from "./similarity.js";

/**
 * Proveedor de embeddings determinista para pruebas/desarrollo sin
 * credenciales (mismo espíritu que `FakeProvider` de `../llm/fake-provider.ts`,
 * pero para vectores de similitud en vez de texto de chat). Nunca llama a la
 * red.
 *
 * A diferencia de `FakeProvider` (que resume el input a un hash de contenido
 * completo -- perfecto para pruebas de igualdad byte a byte, inútil para
 * medir similitud), aquí el vector se construye con la técnica de "hashing
 * trick" (bolsa de palabras con cada token proyectado a un índice fijo del
 * vector, con signo determinista por token -- Weinberger et al. 2009,
 * la misma idea que usa Vowpal Wabbit): dos textos que comparten vocabulario
 * producen vectores con coseno alto DE VERDAD. Esto es un algoritmo de
 * embedding real y determinista, no una simulación de uno -- permite probar
 * el pipeline completo de ranking híbrido (léxico + semántico) end-to-end.
 *
 * IMPORTANTE (esqueleto honesto, `verificado_contra_real=false`): esto NO
 * certifica la calidad semántica de un modelo de embeddings entrenado (no
 * captura sinónimos sin solape léxico, ni relaciones semánticas profundas).
 * Que la suite pase con este proveedor NO certifica la integración real con
 * OpenAI ni la precisión@k/nDCG contra un gold set real (pendiente: no
 * existe gold set de convocatorias reales en este repo, ver
 * docs/ACEPTACION.md REQ-006). Ver README.md, sección "Pendientes".
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id = "fake";
  readonly model = "fake-hashing-bow-v1";
  readonly dims: number;

  constructor(dims: number = 1536) {
    if (!Number.isInteger(dims) || dims <= 0) {
      throw new RangeError(`FakeEmbeddingProvider: dims debe ser un entero positivo (recibido ${dims})`);
    }
    this.dims = dims;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vec = new Array(this.dims).fill(0);
    for (const token of tokenize(text)) {
      const digest = createHash("sha256").update(token).digest();
      // Primeros 4 bytes -> índice en [0, dims); el bit siguiente decide el signo.
      // Determinista: el mismo token siempre cae en el mismo índice con el mismo signo.
      const index = digest.readUInt32BE(0) % this.dims;
      const sign = (digest[4] & 1) === 0 ? 1 : -1;
      vec[index] += sign;
    }
    return l2normalize(vec);
  }
}

const SPANISH_STOPWORDS = new Set([
  "de", "la", "el", "los", "las", "y", "en", "a", "un", "una", "para", "con", "que",
  "por", "se", "su", "del", "al", "es", "o", "no", "como", "sobre",
]);

/** Minúsculas, sin acentos, tokens alfanuméricos de longitud >=2, sin stopwords triviales del español. Determinista y puro. */
export function tokenize(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // quita marcas diacriticas combinantes (a con acento -> a, etc.)
  const rawTokens = normalized.match(/[a-z0-9]+/g) ?? [];
  return rawTokens.filter((t) => t.length >= 2 && !SPANISH_STOPWORDS.has(t));
}
