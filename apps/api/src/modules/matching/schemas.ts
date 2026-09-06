import { z } from 'zod';

export const matchCriterionSchema = z.object({
  criterion: z.string(),
  score: z.number(),
  maxScore: z.number(),
  explanation: z.string(),
});

export const eligibilityCriterionSchema = z.object({
  requirement: z.string(),
  status: z.enum(['cumple', 'no_cumple', 'no_evaluable']),
  explanation: z.string(),
});

export const matchResultSchema = z.object({
  tenderId: z.string().uuid(),
  tenderKey: z.string(),
  relevance: z.object({
    score: z.number(),
    criteria: z.array(matchCriterionSchema),
  }),
  eligibility: z.object({
    status: z.enum(['cumple', 'no_cumple', 'no_evaluable']),
    criteria: z.array(eligibilityCriterionSchema),
  }),
  missingProfileFields: z.array(z.string()),
});

export const matchListResponseSchema = z.object({
  items: z.array(matchResultSchema),
});
