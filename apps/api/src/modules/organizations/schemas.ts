import { z } from 'zod';
import { ORG_ROLES } from '@atiende/db';
import { isoTimestamp } from '../../lib/schema-helpers.js';

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
  // Token en claro devuelto SOLO en la respuesta de creación (no se persiste
  // en claro, solo su hash en `invitations.token_hash`): es la única vez que
  // el sistema lo expone, igual que una API key. El invitador debe
  // transmitirlo fuera de banda (esta ronda no envía email); ver
  // `POST /organizations/invitations/accept`.
  token: z.string().optional(),
});

export const changeRoleBodySchema = z.object({
  role: orgRoleEnum,
});

export const memberParamsSchema = z.object({ userId: z.string().uuid() });

export const acceptInvitationBodySchema = z.object({
  token: z.string().min(1),
});

export const acceptedInvitationSchema = z.object({
  orgId: z.string().uuid(),
  role: orgRoleEnum,
});

// ---------------------------------------------------------------------------
// Ronda 4: `GET /organizations/:orgId/memberships` (apps/web README,
// "Endpoints... gaps": no existía forma de LISTAR los miembros de una
// organización). Ver `app.org_members` (packages/db/migrations/0052).
// ---------------------------------------------------------------------------
export const membershipSchema = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  fullName: z.string().nullable(),
  role: orgRoleEnum,
  status: z.enum(['active', 'suspended']),
  joinedAt: isoTimestamp,
});

export const membershipListParamsSchema = z.object({ orgId: z.string().uuid() });

export const membershipListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z
    .string()
    .regex(/^\d+$/, 'limit debe ser un entero positivo')
    .optional(),
});

export const membershipListResponseSchema = z.object({
  items: z.array(membershipSchema),
  nextCursor: z.string().nullable(),
});
