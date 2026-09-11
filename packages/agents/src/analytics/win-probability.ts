/**
 * Motor estadístico determinista de P(ganar) / P(desierta) (REQ-009):
 * regresión logística real (descenso de gradiente determinista, sin
 * aleatoriedad) entrenada sobre historial etiquetado del propio tenant.
 * No es un LLM y no hay ningún punto donde un LLM participe del cálculo
 * (ADR de la familia de repos: nunca delegar cálculo de dinero/
 * probabilidad a un LLM -- ver docs/REQUISITOS.md REQ-009 "modelo
 * estadístico" y REQ-069 "el LLM... nunca calcula precio, tarifa, impuesto
 * ni disponibilidad", mismo principio extendido aquí a probabilidad).
 *
 * ============================================================================
 * ESTADO HONESTO -- LEER ANTES DE USAR EN PRODUCCIÓN (ver también
 * `packages/agents/README.md` §Pendientes)
 * ============================================================================
 * El motor (extracción de features -> `LogisticRegressionModel.fit()` ->
 * `predictProba()` -> `computeAUC()`) está COMPLETO y probado de punta a
 * punta contra un gold set SINTÉTICO (`test/analytics/fixtures/
 * synthetic-win-goldset.ts`, marcado explícitamente como NO real, generado
 * por una regla determinista + PRNG con semilla fija, nunca por muestreo
 * de datos reales).
 *
 * El criterio de aceptación de REQ-009 (AUC P(ganar) ≥0.70-0.78, AUC
 * P(desierta) ≥0.80 "sobre gold set histórico") exige un gold set REAL de
 * licitaciones en las que ALGÚN tenant real participó, con resultado
 * conocido (ganó/perdió, declarada desierta o no). Ese dato **no existe
 * todavía**: se verificó explícitamente que el único dataset histórico
 * real de este repo (`packages/sources`, conector
 * `compras-mx-historico`, CSV real de la SABG) contiene contratos YA
 * ADJUDICADOS a nivel de todo el gobierno mexicano -- no la perspectiva
 * "¿este proveedor participó y qué pasó?" que requiere REQ-009, y por
 * construcción no incluye ningún procedimiento declarado desierto (un
 * contrato adjudicado, por definición, no fue desierto). No es un gold
 * set válido para este REQ y no se usa como tal.
 *
 * Por lo tanto, `WinDesertionCalibrationResult.verificadoContraReal` es
 * **siempre `false`** salvo que el llamador pase explícitamente
 * `goldSetIsReal: true` a `evaluate()` -- una bandera que solo un humano
 * con el gold set humano pendiente (REQ-021: "100-300 convocatorias
 * anotadas") debe activar, nunca este código por sí solo. Cualquier AUC
 * que este módulo reporte hoy mide qué tan bien el ALGORITMO recupera una
 * regla sintética conocida (validación de que el pipeline funciona), no
 * la precisión real del producto.
 */

export interface WinFeatureVector {
  /**
   * Tasa histórica de éxito del tenant en licitaciones del mismo
   * clasificador (CUCoP/UNSPSC), 0..1, o `null` si no hay historial
   * suficiente -- nunca se fabrica un valor cuando no hay dato.
   */
  historicalWinRateSameClassifier: number | null;
  /** Tamaño de muestra (número de licitaciones históricas) que respalda la tasa anterior. */
  historicalSampleSize: number;
  /** Tasa histórica de desierta de la unidad compradora, 0..1, o `null` si no hay historial. */
  buyerHistoricalDesertionRate: number | null;
  /** Número estimado de competidores en procedimientos comparables recientes. */
  estimatedCompetitorCount: number;
  /** Holgura de plazo: días reales entre publicación y presentación / mínimo legal (REQ-056). 1.0 = exactamente el mínimo legal. */
  deadlineSlackRatio: number;
  /** Presupuesto de la convocatoria / ticket típico del tenant. 1.0 = tamaño típico para el tenant. */
  budgetToCapacityRatio: number;
}

export interface LabeledSample {
  features: WinFeatureVector;
  outcome: 0 | 1;
}

function toVector(f: WinFeatureVector): number[] {
  return [
    1, // intercepto
    f.historicalWinRateSameClassifier ?? 0.5, // dato ausente -> prior neutro (nunca 0 ni 1 fabricados)
    Math.log(1 + Math.max(0, f.historicalSampleSize)),
    f.buyerHistoricalDesertionRate ?? 0,
    Math.log(1 + Math.max(0, f.estimatedCompetitorCount)),
    f.deadlineSlackRatio,
    f.budgetToCapacityRatio,
  ];
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export const MIN_TRAINING_SAMPLES = 10;

export interface LogisticFitOptions {
  learningRate?: number;
  iterations?: number;
  /** Regularización L2 (ridge), aplicada a todos los pesos salvo el intercepto. */
  l2?: number;
}

/**
 * Regresión logística ajustada por descenso de gradiente por lotes,
 * 100% determinista (mismas muestras + mismas opciones -> mismos pesos
 * siempre, sin ninguna fuente de aleatoriedad). No reporta probabilidad
 * alguna antes de `fit()`: REQ-009 prohíbe fabricar una cifra de
 * probabilidad sin haberla calculado de un modelo ajustado a datos reales.
 */
export class LogisticRegressionModel {
  private weights: number[] | null = null;

  get isFitted(): boolean {
    return this.weights !== null;
  }

  fit(samples: LabeledSample[], options: LogisticFitOptions = {}): void {
    if (samples.length < MIN_TRAINING_SAMPLES) {
      throw new Error(
        `LogisticRegressionModel.fit: se requieren al menos ${MIN_TRAINING_SAMPLES} muestras etiquetadas reales; se recibieron ${samples.length}.`,
      );
    }
    const positives = samples.filter((s) => s.outcome === 1).length;
    if (positives === 0 || positives === samples.length) {
      throw new Error(
        "LogisticRegressionModel.fit: las muestras deben incluir al menos un caso positivo y uno negativo; no se puede calibrar un modelo de una sola clase.",
      );
    }

    const learningRate = options.learningRate ?? 0.1;
    const iterations = options.iterations ?? 2000;
    const l2 = options.l2 ?? 0.01;

    const X = samples.map((s) => toVector(s.features));
    const y = samples.map((s) => s.outcome);
    const dim = X[0].length;
    const n = X.length;
    let w = new Array(dim).fill(0);

    for (let iter = 0; iter < iterations; iter++) {
      const gradients = new Array(dim).fill(0);
      for (let i = 0; i < n; i++) {
        const pred = sigmoid(dot(w, X[i]));
        const error = pred - y[i];
        for (let j = 0; j < dim; j++) gradients[j] += error * X[i][j];
      }
      const nextW = new Array(dim);
      for (let j = 0; j < dim; j++) {
        const reg = j === 0 ? 0 : l2 * w[j]; // no regulariza el intercepto
        nextW[j] = w[j] - learningRate * (gradients[j] / n + reg);
      }
      w = nextW;
    }

    this.weights = w;
  }

  predictProba(features: WinFeatureVector): number {
    if (!this.weights) {
      throw new Error(
        "LogisticRegressionModel.predictProba: el modelo no ha sido entrenado (fit()) -- nunca se reporta una probabilidad sin calcularla de un modelo ajustado a datos reales.",
      );
    }
    return sigmoid(dot(this.weights, toVector(features)));
  }

  getWeights(): number[] {
    if (!this.weights) throw new Error("LogisticRegressionModel.getWeights: el modelo no ha sido entrenado.");
    return [...this.weights];
  }
}

export interface AucSample {
  score: number;
  label: 0 | 1;
}

/**
 * AUC (área bajo la curva ROC) calculada por el método de rangos
 * (equivalente al estadístico U de Mann-Whitney normalizado), con manejo
 * de empates por rango promedio. Determinista, sin librerías de ML.
 * Devuelve `null` cuando no hay ambas clases presentes (AUC no está
 * definida en ese caso -- nunca se fabrica un valor por defecto como 0.5
 * o 1).
 */
export function computeAUC(samples: AucSample[]): number | null {
  const positives = samples.filter((s) => s.label === 1);
  const negatives = samples.filter((s) => s.label === 0);
  if (positives.length === 0 || negatives.length === 0) return null;

  const sorted = [...samples].sort((a, b) => a.score - b.score);
  const ranks = new Array<number>(sorted.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].score === sorted[i].score) j++;
    const avgRank = (i + 1 + (j + 1)) / 2; // rangos 1-indexados, promedio para empates
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }

  let sumRanksPositive = 0;
  for (let idx = 0; idx < sorted.length; idx++) {
    if (sorted[idx].label === 1) sumRanksPositive += ranks[idx];
  }

  const nPos = positives.length;
  const nNeg = negatives.length;
  return (sumRanksPositive - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/**
 * Un caso de gold set histórico: features de una licitación real (o, en
 * pruebas, sintética) + su resultado real conocido. `won` y
 * `wasDeclaredVoid` son mutuamente excluyentes en la práctica (un
 * procedimiento ganado no fue desierto), pero se modelan como dos
 * etiquetas independientes porque son dos modelos distintos (REQ-009
 * pide AUC separado para cada uno).
 */
export interface WinDesertionGoldCase {
  id: string;
  features: WinFeatureVector;
  won: 0 | 1;
  wasDeclaredVoid: 0 | 1;
}

export const WIN_AUC_MIN = 0.7;
export const WIN_AUC_TARGET = 0.78;
export const VOID_AUC_MIN = 0.8;

export interface WinDesertionCalibrationResult {
  n: number;
  aucGanar: number | null;
  aucDesierta: number | null;
  meetsGanarThreshold: boolean;
  meetsDesiertaThreshold: boolean;
  /**
   * `true` únicamente cuando el llamador declaró explícitamente
   * `goldSetIsReal: true` en `evaluate()`. Por defecto (y siempre que se
   * mida contra el fixture sintético de pruebas) es `false`: el motor no
   * puede saber por sí solo si el gold set que recibió es real, así que
   * nunca asume que lo es.
   */
  verificadoContraReal: boolean;
}

export interface EvaluateOptions {
  /**
   * Debe ponerse en `true` únicamente cuando `goldCases` proviene de un
   * gold set histórico REAL anotado por humanos (REQ-021). Nunca pasar
   * `true` con el fixture sintético de pruebas.
   */
  goldSetIsReal?: boolean;
}

/**
 * Combina dos `LogisticRegressionModel` independientes (P(ganar) y
 * P(desierta)) sobre el mismo vector de features.
 */
export class WinDesertionEngine {
  readonly winModel = new LogisticRegressionModel();
  readonly desertionModel = new LogisticRegressionModel();

  fit(goldCases: WinDesertionGoldCase[], options: LogisticFitOptions = {}): void {
    this.winModel.fit(
      goldCases.map((c) => ({ features: c.features, outcome: c.won })),
      options,
    );
    this.desertionModel.fit(
      goldCases.map((c) => ({ features: c.features, outcome: c.wasDeclaredVoid })),
      options,
    );
  }

  predict(features: WinFeatureVector): { pGanar: number; pDesierta: number } {
    return { pGanar: this.winModel.predictProba(features), pDesierta: this.desertionModel.predictProba(features) };
  }

  evaluate(goldCases: WinDesertionGoldCase[], options: EvaluateOptions = {}): WinDesertionCalibrationResult {
    const aucGanar = computeAUC(goldCases.map((c) => ({ score: this.winModel.predictProba(c.features), label: c.won })));
    const aucDesierta = computeAUC(
      goldCases.map((c) => ({ score: this.desertionModel.predictProba(c.features), label: c.wasDeclaredVoid })),
    );

    return {
      n: goldCases.length,
      aucGanar,
      aucDesierta,
      meetsGanarThreshold: aucGanar !== null && aucGanar >= WIN_AUC_MIN,
      meetsDesiertaThreshold: aucDesierta !== null && aucDesierta >= VOID_AUC_MIN,
      verificadoContraReal: options.goldSetIsReal === true,
    };
  }
}
