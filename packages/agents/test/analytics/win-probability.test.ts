import { describe, expect, it } from "vitest";
import {
  computeAUC,
  LogisticRegressionModel,
  MIN_TRAINING_SAMPLES,
  VOID_AUC_MIN,
  WIN_AUC_MIN,
  WinDesertionEngine,
  type LabeledSample,
  type WinFeatureVector,
} from "../../src/analytics/win-probability.js";
import { SYNTHETIC_WIN_GOLDSET } from "./fixtures/synthetic-win-goldset.js";

const BASE_FEATURES: WinFeatureVector = {
  historicalWinRateSameClassifier: 0.5,
  historicalSampleSize: 5,
  buyerHistoricalDesertionRate: 0.1,
  estimatedCompetitorCount: 3,
  deadlineSlackRatio: 1.5,
  budgetToCapacityRatio: 1,
};

describe("computeAUC", () => {
  it("separación perfecta (todos los positivos puntúan más alto que todos los negativos) da AUC = 1", () => {
    const samples = [
      { score: 0.9, label: 1 as const },
      { score: 0.8, label: 1 as const },
      { score: 0.2, label: 0 as const },
      { score: 0.1, label: 0 as const },
    ];
    expect(computeAUC(samples)).toBe(1);
  });

  it("separación perfectamente invertida da AUC = 0", () => {
    const samples = [
      { score: 0.1, label: 1 as const },
      { score: 0.2, label: 1 as const },
      { score: 0.8, label: 0 as const },
      { score: 0.9, label: 0 as const },
    ];
    expect(computeAUC(samples)).toBe(0);
  });

  it("scores indistinguibles entre clases da AUC = 0.5", () => {
    const samples = [
      { score: 0.5, label: 1 as const },
      { score: 0.5, label: 0 as const },
      { score: 0.5, label: 1 as const },
      { score: 0.5, label: 0 as const },
    ];
    expect(computeAUC(samples)).toBe(0.5);
  });

  it("sin ambas clases presentes, AUC no está definida (null, nunca un valor fabricado)", () => {
    expect(computeAUC([{ score: 0.9, label: 1 }])).toBeNull();
    expect(computeAUC([{ score: 0.1, label: 0 }])).toBeNull();
    expect(computeAUC([])).toBeNull();
  });

  it("maneja empates de rango correctamente (fórmula de Mann-Whitney con rango promedio)", () => {
    // 1 positivo empatado con 1 negativo en el score más alto: ese par
    // cuenta como "medio acierto" -> AUC = 0.5 + 0.5*(algo), calculado a mano:
    // scores: neg=0.3, pos=0.3(empate), neg=0.1
    // positives={0.3}, negatives={0.3,0.1}; rango de 0.3 (empatado) = promedio de rangos 2,3 = 2.5
    // sumRanksPositive = 2.5; nPos=1, nNeg=2
    // AUC = (2.5 - 1*2/2) / (1*2) = (2.5-1)/2 = 0.75
    const samples = [
      { score: 0.3, label: 1 as const },
      { score: 0.3, label: 0 as const },
      { score: 0.1, label: 0 as const },
    ];
    expect(computeAUC(samples)).toBeCloseTo(0.75, 10);
  });
});

describe("LogisticRegressionModel", () => {
  it("predictProba lanza antes de fit() -- nunca fabrica una probabilidad sin modelo ajustado", () => {
    const model = new LogisticRegressionModel();
    expect(model.isFitted).toBe(false);
    expect(() => model.predictProba(BASE_FEATURES)).toThrow(/no ha sido entrenado/);
  });

  it("fit() rechaza menos del mínimo de muestras requerido", () => {
    const model = new LogisticRegressionModel();
    const tooFew: LabeledSample[] = Array.from({ length: MIN_TRAINING_SAMPLES - 1 }, (_, i) => ({
      features: BASE_FEATURES,
      outcome: (i % 2) as 0 | 1,
    }));
    expect(() => model.fit(tooFew)).toThrow(new RegExp(`al menos ${MIN_TRAINING_SAMPLES}`));
  });

  it("fit() rechaza un conjunto de una sola clase (no se puede calibrar sin ambos resultados)", () => {
    const model = new LogisticRegressionModel();
    const oneClass: LabeledSample[] = Array.from({ length: 20 }, () => ({ features: BASE_FEATURES, outcome: 1 as const }));
    expect(() => model.fit(oneClass)).toThrow(/al menos un caso positivo y uno negativo/);
  });

  it("aprende una relación lineal simple y separable de forma determinista y reproducible", () => {
    // Feature dominante: historicalWinRateSameClassifier alto -> gana; bajo -> pierde.
    const samples: LabeledSample[] = [];
    for (let i = 0; i < 40; i++) {
      const high = i % 2 === 0;
      samples.push({
        features: { ...BASE_FEATURES, historicalWinRateSameClassifier: high ? 0.9 : 0.1 },
        outcome: high ? 1 : 0,
      });
    }
    const model = new LogisticRegressionModel();
    model.fit(samples);
    expect(model.isFitted).toBe(true);

    const highProba = model.predictProba({ ...BASE_FEATURES, historicalWinRateSameClassifier: 0.9 });
    const lowProba = model.predictProba({ ...BASE_FEATURES, historicalWinRateSameClassifier: 0.1 });
    expect(highProba).toBeGreaterThan(lowProba);
    expect(highProba).toBeGreaterThan(0.5);
    expect(lowProba).toBeLessThan(0.5);

    // Determinismo: reentrenar con las mismas muestras y opciones produce EXACTAMENTE los mismos pesos.
    const model2 = new LogisticRegressionModel();
    model2.fit(samples);
    expect(model2.getWeights()).toEqual(model.getWeights());
  });

  it("dato ausente (historial nulo) usa un prior neutro 0.5, nunca 0 ni 1 fabricados", () => {
    const samples: LabeledSample[] = Array.from({ length: 20 }, (_, i) => ({
      features: { ...BASE_FEATURES, historicalWinRateSameClassifier: i % 2 === 0 ? 0.9 : null, historicalSampleSize: i % 2 === 0 ? 10 : 0 },
      outcome: (i % 2) as 0 | 1,
    }));
    const model = new LogisticRegressionModel();
    model.fit(samples);
    // No debe lanzar ni producir NaN al predecir con dato ausente.
    const proba = model.predictProba({ ...BASE_FEATURES, historicalWinRateSameClassifier: null, historicalSampleSize: 0 });
    expect(Number.isFinite(proba)).toBe(true);
    expect(proba).toBeGreaterThanOrEqual(0);
    expect(proba).toBeLessThanOrEqual(1);
  });

  it("getWeights() lanza si el modelo no ha sido entrenado", () => {
    const model = new LogisticRegressionModel();
    expect(() => model.getWeights()).toThrow(/no ha sido entrenado/);
  });
});

describe("WinDesertionEngine sobre el gold set SINTÉTICO (REQ-009)", () => {
  it("entrena ambos modelos y calcula AUC de P(ganar) y P(desierta) por encima de los umbrales de REQ-009 SOBRE EL FIXTURE SINTÉTICO (demuestra que el pipeline funciona; no certifica precisión real, ver cabecera de win-probability.ts)", () => {
    const engine = new WinDesertionEngine();
    engine.fit(SYNTHETIC_WIN_GOLDSET);

    const result = engine.evaluate(SYNTHETIC_WIN_GOLDSET);

    expect(result.n).toBe(SYNTHETIC_WIN_GOLDSET.length);
    expect(result.aucGanar).not.toBeNull();
    expect(result.aucDesierta).not.toBeNull();
    expect(result.aucGanar!).toBeGreaterThanOrEqual(WIN_AUC_MIN);
    expect(result.aucDesierta!).toBeGreaterThanOrEqual(VOID_AUC_MIN);
    expect(result.meetsGanarThreshold).toBe(true);
    expect(result.meetsDesiertaThreshold).toBe(true);
  });

  it("verificadoContraReal es SIEMPRE false por defecto, incluso cuando los umbrales se cumplen en el sintético", () => {
    const engine = new WinDesertionEngine();
    engine.fit(SYNTHETIC_WIN_GOLDSET);
    const result = engine.evaluate(SYNTHETIC_WIN_GOLDSET);
    expect(result.verificadoContraReal).toBe(false);
  });

  it("verificadoContraReal solo se vuelve true si el llamador lo declara explícitamente (goldSetIsReal: true)", () => {
    const engine = new WinDesertionEngine();
    engine.fit(SYNTHETIC_WIN_GOLDSET);
    const result = engine.evaluate(SYNTHETIC_WIN_GOLDSET, { goldSetIsReal: true });
    expect(result.verificadoContraReal).toBe(true);
    // Nota: esto NO significa que el fixture se volvió real -- es responsabilidad
    // del llamador nunca pasar `true` con datos sintéticos en un flujo real.
  });

  it("predict() devuelve ambas probabilidades después de fit()", () => {
    const engine = new WinDesertionEngine();
    engine.fit(SYNTHETIC_WIN_GOLDSET);
    const { pGanar, pDesierta } = engine.predict(SYNTHETIC_WIN_GOLDSET[0].features);
    expect(pGanar).toBeGreaterThanOrEqual(0);
    expect(pGanar).toBeLessThanOrEqual(1);
    expect(pDesierta).toBeGreaterThanOrEqual(0);
    expect(pDesierta).toBeLessThanOrEqual(1);
  });

  it("predict() antes de fit() lanza (ningún modelo por defecto silencioso)", () => {
    const engine = new WinDesertionEngine();
    expect(() => engine.predict(BASE_FEATURES)).toThrow(/no ha sido entrenado/);
  });
});
