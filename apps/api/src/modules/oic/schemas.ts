import { z } from 'zod';
import { OIC_ROLES } from '@atiende/db';
import { isoTimestamp } from '../../lib/schema-helpers.js';

const oicRoleEnum = z.enum(OIC_ROLES as unknown as [string, ...string[]]);

export const createOicOrgBodySchema = z.object({
  name: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'slug solo puede tener minúsculas, números y guiones'),
});

export const oicOrgSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
});

export const myOicOrgSchema = oicOrgSchema.extend({ role: oicRoleEnum });

const riskCategoryEnum = z.enum(['sin_clasificar', 'bases_dirigidas', 'plazo_corto', 'proveedor_unico', 'otro']);
const watchItemStatusEnum = z.enum(['abierto', 'en_revision', 'cerrado']);

export const createWatchItemBodySchema = z.object({
  source: z.string().min(1),
  externalId: z.string().min(1),
  contractingBody: z.string().optional(),
  title: z.string().min(1),
  riskCategory: riskCategoryEnum.optional(),
  riskNote: z.string().optional(),
});

export const updateWatchItemBodySchema = z.object({
  riskCategory: riskCategoryEnum.optional(),
  riskNote: z.string().nullable().optional(),
  status: watchItemStatusEnum.optional(),
});

export const watchItemSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  source: z.string(),
  externalId: z.string(),
  contractingBody: z.string().nullable(),
  title: z.string(),
  riskCategory: riskCategoryEnum,
  riskNote: z.string().nullable(),
  status: watchItemStatusEnum,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

export const watchItemListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z
    .string()
    .regex(/^\d+$/, 'limit debe ser un entero positivo')
    .optional(),
});

export const watchItemListResponseSchema = z.object({
  items: z.array(watchItemSchema),
  nextCursor: z.string().nullable(),
});

export const watchItemParamsSchema = z.object({
  id: z.string().uuid(),
});
