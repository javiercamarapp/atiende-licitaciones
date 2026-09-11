import { compareCents, fromCents, multiplyRateHalfUp, toCents, type DecimalString } from "./decimal.js";

/**
 * Motor determinista de banda legal de precio (REQ-030):
 *
 *   banda = [ promedio_IM × 0.60, mediana_IM × 1.10 ]
 *
 * donde IM = investigación de mercado (BLUEPRINT L673/L1425-1426; L02
 * §6.3). Esta es la ÚNICA fórmula que produce la banda; el LLM (si algún
 * día explica la cifra al usuario) solo puede leer el resultado de este
 * motor, nunca calcularlo (ADR de la familia de repos: nunca delegar
 * cálculo de dinero/probabilidad a un LLM, ver docs/REQUISITOS.md
 * REQ-069).
 *
 * Los valores de entrada (promedio y mediana de la investigación de
 * mercado) deben provenir de un estudio de mercado REAL de esa
 * convocatoria específica (cotizaciones reales recabadas por un analista,
 * o extracción de un anexo de bases) -- fuera del alcance de este módulo,
 * que nunca fabrica ni asume esos números, solo aplica la fórmula legal
 * sobre lo que se le entregue. `computeMarketResearchStats` es un auxiliar
 * opcional para cuando el llamador ya tiene la lista de observaciones
 * reales y solo necesita el promedio/mediana calculados sin error de
 * punto flotante.
 */

export const PRICE_BAND_LOWER_FACTOR = 0.6;
export const PRICE_BAND_UPPER_FACTOR = 1.1;

export interface MarketResearchInput {
  /** Promedio de las cotizaciones/precios de la investigación de mercado. */
  averageMarketResearch: DecimalString;
  /** Mediana de las cotizaciones/precios de la investigación de mercado. */
  medianMarketResearch: DecimalString;
}

export interface PriceBand {
  min: DecimalString;
  max: DecimalString;
  /**
   * `true` si `min > max` -- posible con distribuciones de IM atípicas
   * (promedio muy por encima de la mediana). Nunca se intercambian los
   * valores en silencio para "arreglar" la banda: se reporta explícito
   * para que un humano revise la investigación de mercado, en vez de
   * mostrar una banda económicamente engañosa como si fuera normal.
   */
  degenerate: boolean;
}

export function computePriceBand(input: MarketResearchInput): PriceBand {
  const avgCents = toCents(input.averageMarketResearch);
  const medianCents = toCents(input.medianMarketResearch);
  if (avgCents < 0n || medianCents < 0n) {
    throw new Error("computePriceBand: la investigación de mercado no admite montos negativos.");
  }
  const minCents = multiplyRateHalfUp(avgCents, PRICE_BAND_LOWER_FACTOR);
  const maxCents = multiplyRateHalfUp(medianCents, PRICE_BAND_UPPER_FACTOR);
  return {
    min: fromCents(minCents),
    max: fromCents(maxCents),
    degenerate: compareCents(minCents, maxCents) > 0,
  };
}

/** `true` si `offerAmount` cae dentro de `[band.min, band.max]` (inclusive). */
export function isWithinPriceBand(offerAmount: DecimalString, band: PriceBand): boolean {
  const offerCents = toCents(offerAmount);
  return compareCents(offerCents, toCents(band.min)) >= 0 && compareCents(offerCents, toCents(band.max)) <= 0;
}

/**
 * Calcula promedio y mediana de forma determinista (half-up, sin error de
 * punto flotante) a partir de una lista de precios comparables YA
 * RECOPILADOS por un humano (cotizaciones reales de proveedores,
 * contratos históricos comparables, etc.). Esta función nunca decide qué
 * observaciones son comparables ni las inventa: solo hace la aritmética
 * sobre la lista real que se le entregue.
 */
export function computeMarketResearchStats(observations: DecimalString[]): MarketResearchInput {
  if (observations.length === 0) {
    throw new Error("computeMarketResearchStats: se requiere al menos una observación real de mercado.");
  }
  const centsValues = observations.map((v) => {
    const cents = toCents(v);
    if (cents < 0n) throw new Error(`computeMarketResearchStats: observación negativa no admitida: "${v}"`);
    return cents;
  });
  const sorted = [...centsValues].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const n = BigInt(sorted.length);
  const sum = sorted.reduce((acc, v) => acc + v, 0n);
  const remainder = sum % n;
  const avgCents = remainder * 2n >= n ? sum / n + 1n : sum / n;

  const mid = Math.floor(sorted.length / 2);
  let medianCents: bigint;
  if (sorted.length % 2 === 1) {
    medianCents = sorted[mid];
  } else {
    const total = sorted[mid - 1] + sorted[mid];
    medianCents = total % 2n === 0n ? total / 2n : (total + 1n) / 2n; // half-up
  }

  return { averageMarketResearch: fromCents(avgCents), medianMarketResearch: fromCents(medianCents) };
}
