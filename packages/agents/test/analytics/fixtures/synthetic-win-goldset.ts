import type { WinDesertionGoldCase, WinFeatureVector } from "../../../src/analytics/win-probability.js";

/**
 * GOLD SET SINTÉTICO -- NO SON LICITACIONES REALES DE NINGÚN TENANT.
 *
 * Generado por una regla determinista (una fórmula logística conocida) +
 * un PRNG con semilla FIJA (`mulberry32`, nunca `Math.random()`), para que
 * la corrida sea siempre reproducible bit a bit. Sirve exclusivamente
 * para probar que `WinDesertionEngine` (extracción de features -> fit ->
 * predictProba -> AUC) funciona de punta a punta y para demostrar que el
 * algoritmo SÍ es capaz de recuperar una señal conocida cuando existe.
 *
 * Esto NO certifica el criterio de aceptación real de REQ-009 (AUC
 * P(ganar) ≥0.70-0.78, AUC P(desierta) ≥0.80 "sobre gold set histórico"):
 * ese gold set requiere licitaciones REALES en las que un tenant real
 * participó, con resultado real conocido -- pendiente del gold set humano
 * (REQ-021), ver `packages/agents/README.md` §Pendientes y el comentario
 * de cabecera de `src/analytics/win-probability.ts`.
 */

function mulberry32(seed: number): () => number {
  let state = seed;
  return function random(): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Semilla fija arbitraria (fecha de esta ronda, sin ningún significado
// estadístico) -- lo único que importa es que sea constante.
const rand = mulberry32(20260910);

function makeCase(index: number): WinDesertionGoldCase {
  const winRateKnown = rand() > 0.15; // 85% de los casos sí tienen historial suficiente
  const winRate = rand();
  const sampleSize = winRateKnown ? 1 + Math.floor(rand() * 19) : 0;
  const desertionRate = rand() * 0.6;
  const competitors = Math.floor(rand() * 10);
  const slack = 0.5 + rand() * 2.5; // 0.5..3.0 -- <1.0 representa un plazo por debajo del mínimo legal
  const budgetRatio = 0.3 + rand() * 2.7;

  const features: WinFeatureVector = {
    historicalWinRateSameClassifier: winRateKnown ? winRate : null,
    historicalSampleSize: sampleSize,
    buyerHistoricalDesertionRate: desertionRate,
    estimatedCompetitorCount: competitors,
    deadlineSlackRatio: slack,
    budgetToCapacityRatio: budgetRatio,
  };

  // Regla SINTÉTICA de generación de etiqueta (no una verdad de negocio
  // real): más probable ganar con tasa histórica alta, pocos competidores
  // y holgura de plazo suficiente; el ruido bernoulli (muestreo de
  // `pGanar`, no un umbral duro) es lo que hace el problema no-trivial y
  // permite medir un AUC realista en vez de 1.0 perfecto.
  const winLogit = 3.2 * (winRateKnown ? winRate : 0.5) - 0.18 * competitors + 0.6 * (slack - 1) - 1.1;
  const pGanar = 1 / (1 + Math.exp(-winLogit));
  const won: 0 | 1 = rand() < pGanar ? 1 : 0;

  // Un procedimiento ganado, por definición, no fue declarado desierto.
  // Coeficiente más fuerte que el de P(ganar) a propósito: el criterio de
  // aceptación de REQ-009 exige un AUC más alto para desierta (≥0.80) que
  // para ganar (≥0.70-0.78), así que la señal sintética debe ser
  // proporcionalmente más separable para que el pipeline pueda demostrar
  // que SÍ alcanza ese nivel cuando la señal real lo permite.
  let wasDeclaredVoid: 0 | 1 = 0;
  if (won === 0) {
    const voidLogit = 9.5 * desertionRate - 0.12 * competitors - 3.2;
    const pDesierta = 1 / (1 + Math.exp(-voidLogit));
    wasDeclaredVoid = rand() < pDesierta ? 1 : 0;
  }

  return { id: `synthetic-${index}`, features, won, wasDeclaredVoid };
}

export const SYNTHETIC_WIN_GOLDSET: WinDesertionGoldCase[] = Array.from({ length: 400 }, (_, i) => makeCase(i));
