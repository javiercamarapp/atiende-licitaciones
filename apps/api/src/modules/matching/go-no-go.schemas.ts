import { z } from 'zod';
import { isoTimestamp } from '../../lib/schema-helpers.js';

export const goNoGoDecisionCreateSchema = z.object({
  decision: z.enum(['go', 'no_go']),
  reasons: z.array(z.string().min(1)).min(1, 'Se requiere al menos un motivo'),
});

export const goNoGoDecisionSchema = z.object({
  id: z.string().uuid(),
  tenderId: z.string().uuid(),
  decision: z.enum(['go', 'no_go']),
  reasons: z.array(z.string()),
  decidedBy: z.string().uuid().nullable(),
  decidedAt: isoTimestamp,
});
