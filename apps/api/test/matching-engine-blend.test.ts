import { describe, expect, it } from 'vitest';
import { blendRelevance } from '../src/modules/matching/engine.js';
import { SEMANTIC_RELEVANCE_WEIGHT, type SemanticRelevanceResult } from '../src/modules/matching/semantic.js';
import type { MatchResult } from '@atiende/sources';

const lexical: { score: number; criteria: MatchResult['criteria'] } = {
  score: 80,
  criteria: [
    { criterion: 'keywords', score: 50, maxScore: 60, explanation: 'x' },
    { criterion: 'budget', score: 30, maxScore: 40, explanation: 'y' },
  ],
};

function semanticOf(cosine: number, score0to100: number): SemanticRelevanceResult {
  return { cosine, score0to100, provider: 'fake', model: 'fake-hashing-bow-v1' };
}

describe('blendRelevance (REQ-006: matching híbrido semántico + léxico)', () => {
  it('sin señal semántica (null), el resultado es IDÉNTICO al léxico puro -- comportamiento previo intacto', () => {
    const result = blendRelevance(lexical, null);
    expect(result).toEqual(lexical);
  });

  it('con señal semántica, añade un criterio "semantic_similarity" y reescala los criterios léxicos', () => {
    const result = blendRelevance(lexical, semanticOf(1, 100));
    const semanticCriterion = result.criteria.find((c) => c.criterion === 'semantic_similarity');
    expect(semanticCriterion).toBeDefined();
    expect(result.criteria.length).toBe(lexical.criteria.length + 1);

    // Con coseno=1 (score0to100=100) y peso semántico configurado, el
    // criterio semántico aporta EXACTAMENTE 100 * SEMANTIC_RELEVANCE_WEIGHT.
    expect(semanticCriterion!.score).toBeCloseTo(100 * SEMANTIC_RELEVANCE_WEIGHT, 5);
  });

  it('INVARIANTE (REQ-168, explicabilidad): la suma de los scores de los criterios siempre reproduce relevance.score', () => {
    for (const [cosine, score0to100] of [
      [1, 100],
      [0, 50],
      [-1, 0],
      [0.37, 68.5],
    ] as const) {
      const result = blendRelevance(lexical, semanticOf(cosine, score0to100));
      const sum = result.criteria.reduce((acc, c) => acc + c.score, 0);
      expect(sum).toBeCloseTo(result.score, 1);
    }
  });

  it('CASO NEGATIVO: coseno -1 (dirección opuesta) contribuye 0 al score semántico, nunca un score negativo dentro del criterio', () => {
    const result = blendRelevance(lexical, semanticOf(-1, 0));
    const semanticCriterion = result.criteria.find((c) => c.criterion === 'semantic_similarity');
    expect(semanticCriterion!.score).toBe(0);
    // El score total baja respecto al 100% léxico porque una porción del
    // peso total ahora la ocupa un criterio que aportó 0.
    expect(result.score).toBeLessThan(lexical.score);
  });

  it('los criterios léxicos reescalados sí cambian de score (dejan de sumar 80) cuando hay semántica', () => {
    const result = blendRelevance(lexical, semanticOf(0.5, 75));
    const lexicalPortion = result.criteria.filter((c) => c.criterion !== 'semantic_similarity');
    const lexicalSum = lexicalPortion.reduce((acc, c) => acc + c.score, 0);
    expect(lexicalSum).toBeCloseTo(lexical.score * (1 - SEMANTIC_RELEVANCE_WEIGHT), 1);
    expect(lexicalSum).not.toBeCloseTo(lexical.score, 1);
  });

  it('el score final siempre queda acotado a [0, 100]', () => {
    const result = blendRelevance({ score: 100, criteria: lexical.criteria }, semanticOf(1, 100));
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
