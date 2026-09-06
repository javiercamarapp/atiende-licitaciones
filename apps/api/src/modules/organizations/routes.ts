import { randomUUID, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MEMBERSHIP_ADMIN_ROLES, type DbExecutor } from '@atiende/db';
import { ConflictError, ForbiddenError } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { runIdempotent, hashRequestBody } from '../../lib/idempotency.js';
import {
  createOrgBodySchema,
  orgSchema,
  myOrgSchema,
  inviteBodySchema,
  invitationSchema,
  changeRoleBodySchema,
  memberParamsSchema,
} from './schemas.js';

const UNIQUE_VIOLATION = '23505';

export async function organizationRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    '/',
    {
      preHandler: [app.authenticate],
      schema: { body: createOrgBodySchema, response: { 201: orgSchema } },
    },
    async (request, reply) => {
      const { name, slug } = request.body;
      const orgId = randomUUID();
      const userId = request.userId!;

      try {
        await app.db.transaction(async (tx) => {
          await tx.query('set local role app_role');
          await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
          // Sin RETURNING: el actor aún no es miembro (ver nota de diseño en
          // packages/db/test/org-bootstrap.test.ts).
          await tx.query('insert into organizations (id, name, slug) values ($1, $2, $3)', [orgId, name, slug]);
          // Fija el contexto de org DENTRO de la misma transacción para
          // poder auto-asignarse como owner (política de bootstrap, 0008).
          await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
          await tx.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [
            orgId,
            userId,
          ]);
          await recordAudit(tx, {
            orgId,
            actorId: userId,
            action: 'organization.create',
            entity: 'organization',
            entityId: orgId,
            after: { name, slug },
            requestId: request.id,
          });
        });
      } catch (err) {
        const pgErr = err as { code?: string };
        if (pgErr.code === UNIQUE_VIOLATION) {
          throw new ConflictError('Ya existe una organización con ese slug');
        }
        throw err;
      }

      reply.code(201);
      return { id: orgId, name, slug };
    }
  );

  server.get(
    '/',
    {
      preHandler: [app.authenticate],
      schema: { response: { 200: z.array(myOrgSchema) } },
    },
    async (request) => {
      const userId = request.userId!;
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        return tx.query<{ org_id: string; org_name: string; org_slug: string; role: string }>(
          'select * from app.my_organizations($1)',
          [userId]
        );
      });
      return rows.map((r) => ({ id: r.org_id, name: r.org_name, slug: r.org_slug, role: r.role as any }));
    }
  );

  server.post(
    '/invitations',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { body: inviteBodySchema, response: { 201: invitationSchema } },
    },
    async (request, reply) => {
      const orgId = request.orgId!;
      const userId = request.userId!;

      if (!MEMBERSHIP_ADMIN_ROLES.includes(request.orgRole as any)) {
        throw new ForbiddenError('Solo owner/admin pueden invitar miembros');
      }

      const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
      const requestHash = hashRequestBody(request.body);

      const { email, role } = request.body;
      const invitationId = randomUUID();
      const tokenHash = createHash('sha256').update(randomUUID()).digest('hex');

      type InvitationBody = { id: string; email: string; role: string; status: string };

      const doInsert = async (tx: DbExecutor): Promise<{ statusCode: 201; body: InvitationBody }> => {
        await tx.query(
          `insert into invitations (id, org_id, email, role, token_hash, invited_by, expires_at)
           values ($1, $2, $3, $4, $5, $6, now() + interval '7 days')`,
          [invitationId, orgId, email, role, tokenHash, userId]
        );
        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: 'invitation.create',
          entity: 'invitation',
          entityId: invitationId,
          after: { email, role },
          requestId: request.id,
        });
        return { statusCode: 201, body: { id: invitationId, email, role, status: 'pending' } };
      };

      let result: { statusCode: number; body: InvitationBody };
      try {
        result = await app.db.transaction(async (tx) => {
          await tx.query('set local role app_role');
          await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
          await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);

          if (idempotencyKey) {
            const idemResult = await runIdempotent(tx, { orgId, key: idempotencyKey, requestHash }, () =>
              doInsert(tx)
            );
            return { statusCode: idemResult.statusCode, body: idemResult.body };
          }
          return doInsert(tx);
        });
      } catch (err) {
        const pgErr = err as { code?: string };
        if (pgErr.code === UNIQUE_VIOLATION) {
          throw new ConflictError('Ya hay una invitación pendiente para ese email en esta organización');
        }
        throw err;
      }

      reply.code(201);
      return result.body;
    }
  );

  server.patch(
    '/memberships/:userId',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: memberParamsSchema, body: changeRoleBodySchema, response: { 200: z.object({ userId: z.string(), role: z.string() }) } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const actorId = request.userId!;
      const targetUserId = request.params.userId;
      const { role } = request.body;

      if (!MEMBERSHIP_ADMIN_ROLES.includes(request.orgRole as any)) {
        throw new ForbiddenError('Solo owner/admin pueden cambiar roles');
      }

      const updated = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [actorId]);

        const before = await tx.query('select role from memberships where org_id = $1 and user_id = $2', [
          orgId,
          targetUserId,
        ]);

        const res = await tx.query(
          'update memberships set role = $1 where org_id = $2 and user_id = $3',
          [role, orgId, targetUserId]
        );

        if (res.rowCount > 0) {
          await recordAudit(tx, {
            orgId,
            actorId,
            action: 'membership.change_role',
            entity: 'membership',
            entityId: targetUserId,
            before: before.rows[0] ?? null,
            after: { role },
            requestId: request.id,
          });
        }
        return res.rowCount;
      });

      if (updated === 0) {
        throw new ConflictError('El usuario no es miembro de esta organización (o no tienes permiso para verlo)');
      }

      return { userId: targetUserId, role };
    }
  );
}
