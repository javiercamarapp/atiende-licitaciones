/**
 * Clasificador determinista de CUCoP/COG (REQ-002): dado el texto de una
 * convocatoria (título + descripción), rankea los códigos de un catálogo
 * por similitud léxica ponderada por IDF (TF-IDF simplificado, calculado
 * sobre el propio catálogo, sin ningún servicio externo).
 *
 * El PDF fuente (BLUEPRINT-LICITACIONES.pdf L639) describe este
 * componente como "usando LLM", pero la instrucción explícita de esta
 * ronda (y el ADR de la familia de repos sobre nunca delegar cálculo de
 * probabilidad/clasificación numérica a un LLM, ver docs/REQUISITOS.md
 * REQ-069: "el LLM elige entre opciones válidas, nunca calcula...") es
 * construirlo como motor determinista, igual que
 * `packages/sources/src/matching/matching-engine.ts` (matching híbrido ya
 * existente, 100% léxico/reglas). Un LLM puede consumir después el
 * resultado de este motor para EXPLICAR la elección en lenguaje natural,
 * pero nunca para decidir el código.
 *
 * ESTADO HONESTO (ver `packages/agents/README.md` §Pendientes): el motor
 * está completo y probado end-to-end contra un catálogo y un gold set
 * SINTÉTICOS (`test/analytics/fixtures/synthetic-cucop-*.ts`, marcados
 * explícitamente como NO reales). El criterio de aceptación de REQ-002
 * (precision@5 ≥0.6 sobre gold set de 300-500 procedimientos reales)
 * requiere (a) el catálogo OFICIAL CUCoP/COG vigente completo, y (b) un
 * gold set de 300-500 procedimientos reales anotados a mano con su código
 * correcto -- ninguno de los dos existe todavía en este repo, y ninguno
 * se fabrica aquí. `CucopCatalogPort` es el punto de extensión real donde
 * se debe conectar el catálogo oficial cuando exista.
 */

export interface CucopCatalogEntry {
  code: string;
  description: string;
}

/**
 * Puerto real del catálogo CUCoP/COG. Quien lo implemente en producción
 * debe cargarlo del catálogo oficial vigente publicado por la autoridad
 * de la materia (hoy SABG, ver docs/REQUISITOS.md REQ-108) -- este módulo
 * nunca fabrica entradas de catálogo.
 */
export interface CucopCatalogPort {
  entries(): CucopCatalogEntry[];
}

export interface CucopCandidate {
  code: string;
  description: string;
  /** Score normalizado 0..1 (fracción del peso IDF de la consulta que el candidato cubre). */
  score: number;
  matchedTerms: string[];
}

const SPANISH_STOPWORDS = new Set([
  "de",
  "la",
  "el",
  "los",
  "las",
  "y",
  "o",
  "a",
  "en",
  "para",
  "por",
  "con",
  "un",
  "una",
  "unos",
  "unas",
  "del",
  "al",
  "su",
  "sus",
  "que",
  "se",
  "es",
  "no",
]);

function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function tokenize(text: string): string[] {
  return stripDiacritics(text.toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !SPANISH_STOPWORDS.has(t));
}

/**
 * Clasifica `text` contra el catálogo, devolviendo hasta `topK` candidatos
 * ordenados por score descendente (desempate por código ascendente para
 * que el resultado sea 100% determinista). El IDF se calcula sobre las
 * frecuencias de documento del propio catálogo -- ningún dato externo ni
 * LLM interviene en el cálculo.
 */
export function classifyCucop(text: string, catalog: CucopCatalogPort, topK = 5): CucopCandidate[] {
  const entries = catalog.entries();
  if (entries.length === 0) return [];

  const queryTokens = [...new Set(tokenize(text))];
  if (queryTokens.length === 0) return [];

  const entryTokenSets = entries.map((e) => new Set(tokenize(e.description)));

  const documentFrequency = new Map<string, number>();
  for (const tokens of entryTokenSets) {
    for (const t of tokens) documentFrequency.set(t, (documentFrequency.get(t) ?? 0) + 1);
  }
  const n = entries.length;
  const idf = (term: string): number => Math.log((n + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1;

  const queryWeight = queryTokens.reduce((s, t) => s + idf(t), 0) || 1;

  const scored: CucopCandidate[] = entries.map((entry, i) => {
    const tokens = entryTokenSets[i];
    const matchedTerms = queryTokens.filter((t) => tokens.has(t));
    const score = matchedTerms.reduce((s, t) => s + idf(t), 0) / queryWeight;
    return { code: entry.code, description: entry.description, score, matchedTerms };
  });

  return scored
    .filter((c) => c.matchedTerms.length > 0)
    .sort((a, b) => b.score - a.score || a.code.localeCompare(b.code))
    .slice(0, topK);
}

export interface CucopGoldCase {
  id: string;
  text: string;
  /** Código(s) correctos aceptables para este caso -- basta que uno aparezca en el top-K. */
  expectedCodes: string[];
}

export interface CucopBenchmarkResult {
  n: number;
  k: number;
  /**
   * Fracción de casos del gold set en los que al menos uno de los
   * `expectedCodes` aparece dentro del top-`k` de candidatos devueltos
   * (interpretación de "precision@k" usada por REQ-002 cuando cada caso
   * tiene un único código correcto conocido -- equivalente a hit-rate@k /
   * recall@k en ese régimen de una sola etiqueta relevante por consulta;
   * se documenta explícitamente esta interpretación porque el PDF fuente
   * no define la métrica con mayor precisión).
   */
  precisionAtK: number;
  meetsAcceptanceThreshold: boolean;
  perCase: Array<{ id: string; hit: boolean; candidates: CucopCandidate[] }>;
}

export const CUCOP_PRECISION_THRESHOLD = 0.6;

export function runCucopBenchmark(cases: CucopGoldCase[], catalog: CucopCatalogPort, k = 5): CucopBenchmarkResult {
  const perCase = cases.map((c) => {
    const candidates = classifyCucop(c.text, catalog, k);
    const hit = candidates.some((cand) => c.expectedCodes.includes(cand.code));
    return { id: c.id, hit, candidates };
  });

  const precisionAtK = cases.length === 0 ? 0 : perCase.filter((c) => c.hit).length / cases.length;

  return {
    n: cases.length,
    k,
    precisionAtK,
    meetsAcceptanceThreshold: precisionAtK >= CUCOP_PRECISION_THRESHOLD,
    perCase,
  };
}
