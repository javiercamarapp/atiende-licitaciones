import { z } from 'zod';
import { ORG_ROLES } from '@atiende/db';

const orgRoleEnum = z.enum(ORG_ROLES as unknown as [string, ...string[]]);

export const createOrgBodySchema = z.object({
  name: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'slug solo puede tener minúsculas, números y guiones'),
});

export const orgSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
});

export const myOrgSchema = orgSchema.extend({ role: orgRoleEnum });

export const inviteBodySchema = z.object({
  email: z.string().email(),
  role: orgRoleEnum,
});

export const invitationSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  role: orgRoleEnum,
  status: z.string(),
});

export const changeRoleBodySchema = z.object({
  role: orgRoleEnum,
});

export const memberParamsSchema = z.object({ userId: z.string().uuid() });
