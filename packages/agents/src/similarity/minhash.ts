/**
 * MinHash + LSH real (REQ-032, BLUEPRINT L625-627 G-11): huellas de
 * similitud de texto entre tenants "sin cruzar contenido" -- el contrato de
 * este módulo es que, a partir de aquí en adelante, nada que salga de él
 * (`MinHashSignature`, `computeFingerprint(...).bandHashes`) permite
 * reconstruir el texto original. Un MinHash es una función de un solo
 * sentido sobre el conjunto de shingles del documento: dos documentos
 * pueden compartir una huella casi idéntica sin que nadie que solo vea las
 * huellas pueda recuperar ni una palabra del contenido real.
 *
 * Este es el algoritmo real (no una aproximación de juguete): shingling por
 * palabras, familia de funciones hash universales `h_i(x) = (a_i*x + b_i)
 * mod p` con `p` primo (Broder 1997 / Rajaraman-Ullman "Mining of Massive
 * Datasets" cap. 3), firma MinHash de tamaño fijo, estimador de Jaccard por
 * coincidencia de posiciones, y bandas LSH (Leskovec et al.) para encontrar
 * candidatos sin comparar la firma completa contra cada documento
 * existente. `p = 2^31 - 1` (primo de Mersenne, M31) -- elegido
 * DELIBERADAMENTE cerca de 2^31 (no 2^32) para que cada valor de la firma
 * quepa en la columna `integer` (32 bits CON signo) de Postgres sin
 * necesitar `bigint[]` (encontrado corriendo esto contra Postgres real,
 * PGlite: un módulo > 2^31 produce valores que Postgres rechaza con "value
 * ... is out of range for type integer").
 *
 * IMPORTANTE (honestidad de calibración): el UMBRAL de similitud que decide
 * "esto es una plantilla compartida" (`DEFAULT_SIMILARITY_THRESHOLD` en
 * `cross-tenant-detector.ts`) es un parámetro de ingeniería razonable, NO
 * un valor calibrado contra un gold-set real de pares de propuestas con
 * colusión confirmada (ese gold-set no existe todavía -- no se fabrica
 * aquí). `calibrado_contra_datos_reales=false` hasta que exista evidencia
 * real para ajustar precisión/recall del detector.
 */

/** Número de funciones hash de la firma MinHash (tamaño de la firma). Más alto = estimador de Jaccard más preciso, más costo. */
export const DEFAULT_NUM_HASHES = 64;

/** Tamaño de shingle (n-grama de PALABRAS, no caracteres) -- robusto a sustituir nombres/cifras dentro de una plantilla reutilizada. */
export const DEFAULT_SHINGLE_SIZE = 5;

/**
 * Módulo de la familia de hash universal: 2^31 - 1 (primo de Mersenne M31,
 * primalidad verificada por división de prueba, no asumida). Elegido
 * DELIBERADAMENTE por debajo de 2^32 (en vez del primo "obvio" justo por
 * encima, 2^32+15) para que cada valor quepa en la columna `integer` (32
 * bits CON signo) de `packages/db/migrations/0099` sin necesitar
 * `bigint[]` -- un valor de firma nunca es negativo ni >= este primo, así
 * que siempre es representable como `integer` de Postgres.
 */
const UNIVERSAL_HASH_PRIME = 2147483647n; // 2^31 - 1
const MAX_HASH = 2147483646n; // p - 1: máximo valor representable de la firma

/**
 * Genera `count` pares de coeficientes (a, b) DETERMINISTAS a partir de una
 * semilla fija (no aleatorios en cada corrida: dos procesos distintos deben
 * producir EXACTAMENTE la misma familia de funciones hash para que sus
 * firmas MinHash sean comparables). Usa SplitMix32 (Steele/Vigna), un
 * generador determinista real, no una tabla de números inventados a mano.
 */
function splitMix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    return z;
  };
}

/**
 * Coeficientes (a_i, b_i) de la familia de hash universal, fijos para todo
 * el proceso (y para cualquier otro proceso que use esta misma versión del
 * algoritmo, ver `ALGORITHM_VERSION` en cross-tenant-detector.ts). Reducidos
 * módulo `p` (así viven en el cuerpo finito correcto de la familia `h(x) =
 * (a*x+b) mod p`, no solo "números grandes que casualmente funcionan").
 * `a_i` nunca es 0 (una función hash con a=0 sería constante, inútil para
 * MinHash) -- se fuerza a 1 si el módulo diera 0.
 */
function generateCoefficients(count: number, seed = 0xa17e17de): { a: bigint; b: bigint }[] {
  const rng = splitMix32(seed);
  const coefficients: { a: bigint; b: bigint }[] = [];
  for (let i = 0; i < count; i++) {
    const a = BigInt(rng()) % UNIVERSAL_HASH_PRIME || 1n;
    const b = BigInt(rng()) % UNIVERSAL_HASH_PRIME;
    coefficients.push({ a, b });
  }
  return coefficients;
}

/** Familia de hash universal fija (memoizada por tamaño de firma solicitado). */
const coefficientsCache = new Map<number, { a: bigint; b: bigint }[]>();
function coefficientsFor(numHashes: number): { a: bigint; b: bigint }[] {
  let cached = coefficientsCache.get(numHashes);
  if (!cached) {
    cached = generateCoefficients(numHashes);
    coefficientsCache.set(numHashes, cached);
  }
  return cached;
}

/** FNV-1a de 32 bits -- hash determinista real de un shingle a un entero sin signo. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Normaliza texto para shingling: minúsculas, quita acentos/diacríticos
 * (para que "construcción"/"construccion" produzcan el mismo shingle),
 * colapsa espacios y puntuación a un solo separador. NO quita números --
 * una plantilla reutilizada con cifras distintas sigue compartiendo la
 * mayoría de sus shingles de palabras alrededor de esas cifras.
 */
export function normalizeForShingling(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // marcas diacríticas combinantes (acentos, tras normalize NFD)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Shingles de `k` palabras consecutivas sobre el texto ya normalizado. Texto más corto que `k` palabras produce un único shingle (todo el texto). */
export function wordShingles(text: string, k: number = DEFAULT_SHINGLE_SIZE): string[] {
  const normalized = normalizeForShingling(text);
  if (normalized.length === 0) return [];
  const words = normalized.split(" ");
  if (words.length <= k) return [words.join(" ")];
  const shingles: string[] = [];
  for (let i = 0; i <= words.length - k; i++) {
    shingles.push(words.slice(i, i + k).join(" "));
  }
  return shingles;
}

/** Firma MinHash: un entero por función hash de la familia, el MÍNIMO valor hasheado entre todos los shingles del documento. */
export type MinHashSignature = readonly number[];

/**
 * Calcula la firma MinHash de un texto. `shingleSize`/`numHashes`
 * controlan sensibilidad/costo -- deben ser IGUALES entre dos firmas para
 * que sean comparables (ver `ALGORITHM_VERSION`, que fija esto de facto en
 * el detector real).
 */
export function computeMinHashSignature(
  text: string,
  options: { shingleSize?: number; numHashes?: number } = {},
): MinHashSignature {
  const shingleSize = options.shingleSize ?? DEFAULT_SHINGLE_SIZE;
  const numHashes = options.numHashes ?? DEFAULT_NUM_HASHES;
  const shingles = wordShingles(text, shingleSize);
  const coefficients = coefficientsFor(numHashes);

  if (shingles.length === 0) {
    // Documento vacío: firma "máxima" en todas las posiciones -- comparado
    // contra cualquier documento no vacío, el estimador de Jaccard da 0
    // salvo que el otro documento TAMBIÉN esté vacío (correcto: dos
    // secciones vacías no son evidencia de plantilla compartida, son
    // ambas "nada").
    return coefficients.map(() => Number(MAX_HASH));
  }

  const shingleHashes = shingles.map((s) => BigInt(fnv1a32(s)));
  return coefficients.map(({ a, b }) => {
    let min = MAX_HASH;
    for (const x of shingleHashes) {
      const h = (a * x + b) % UNIVERSAL_HASH_PRIME;
      if (h < min) min = h;
    }
    return Number(min);
  });
}

/** Estima el índice de Jaccard entre dos documentos a partir de sus firmas MinHash: fracción de posiciones donde coinciden. */
export function estimateJaccard(a: MinHashSignature, b: MinHashSignature): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) matches++;
  }
  return matches / a.length;
}

/**
 * Bandas LSH (Locality-Sensitive Hashing): divide la firma en `numBands`
 * bandas de `rowsPerBand` valores cada una y devuelve una clave de bucket
 * por banda (hash de los valores concatenados, prefijado con el índice de
 * banda para que la misma combinación de valores en bandas distintas NUNCA
 * colisione entre sí). Dos documentos son "candidatos" a similares si
 * comparten AL MENOS una clave de banda -- permite encontrar coincidencias
 * sin comparar la firma completa contra cada documento ya existente
 * (búsqueda por índice, no por escaneo).
 *
 * Con `numBands=16`/`rowsPerBand=4` (firma de 64), la probabilidad de que
 * dos documentos con similitud real `s` compartan al menos una banda es
 * aproximadamente `1 - (1 - s^4)^16` -- por ejemplo ~78% para s=0.5, ~99.9%
 * para s=0.8. Deliberadamente sensible (prefiere falsos candidatos, que el
 * estimador de Jaccard exacto sobre la firma completa descarta después,
 * antes que perder una coincidencia real).
 */
export function lshBandHashes(
  signature: MinHashSignature,
  options: { numBands?: number; rowsPerBand?: number } = {},
): string[] {
  const numBands = options.numBands ?? 16;
  const rowsPerBand = options.rowsPerBand ?? 4;
  if (numBands * rowsPerBand > signature.length) {
    throw new Error(
      `lshBandHashes: numBands*rowsPerBand (${numBands * rowsPerBand}) excede el tamaño de la firma (${signature.length})`,
    );
  }
  const bands: string[] = [];
  for (let band = 0; band < numBands; band++) {
    const start = band * rowsPerBand;
    const slice = signature.slice(start, start + rowsPerBand);
    const bucket = fnv1a32(slice.join(","));
    bands.push(`${band}:${bucket}`);
  }
  return bands;
}

export interface TextFingerprint {
  signature: MinHashSignature;
  bandHashes: string[];
  shingleCount: number;
}

/** Atajo: firma + bandas + conteo de shingles en una sola llamada, con los parámetros por defecto del algoritmo real usado por el detector. */
export function computeFingerprint(
  text: string,
  options: { shingleSize?: number; numHashes?: number; numBands?: number; rowsPerBand?: number } = {},
): TextFingerprint {
  const signature = computeMinHashSignature(text, options);
  const bandHashes = lshBandHashes(signature, options);
  return { signature, bandHashes, shingleCount: wordShingles(text, options.shingleSize ?? DEFAULT_SHINGLE_SIZE).length };
}
