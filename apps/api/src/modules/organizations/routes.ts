import { randomUUID, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MEMBERSHIP_ADMIN_ROLES, type DbExecutor } from '@atiende/db';
import { ConflictError, ForbiddenError, UnauthorizedError } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { runIdempotent, hashRequestBody } from '../../lib/idempotency.js';
import { fireAndForgetMail } from '../../lib/mail/pending.js';
import { sendOrganizationInviteEmail } from '../../lib/mail/triggers.js';
import { encodeCursor, decodeCursor, parsePageSize, toIsoString } from '../../lib/cursor.js';
import {
  createOrgBodySchema,
  orgSchema,
  myOrgSchema,
  inviteBodySchema,
  invitationSchema,
  changeRoleBodySchema,
  memberParamsSchema,
  acceptInvitationBodySchema,
  acceptedInvitationSchema,
  membershipListParamsSchema,
  membershipListQuerySchema,
  membershipListResponseSchema,
} from './schemas.js';

const UNIQUE_VIOLATION = '23505';

/** REQ-181: `invitations.expires_at` se fija a `now() + 7 days` en el INSERT
 *  de abajo -- el enlace firmado del correo usa exactamente el mismo plazo,
 *  para que la firma nunca sobreviva a la invitación ni al revés. */
const INVITATION_TTL_MINUTES = 7 * 24 * 60;

/** Nombre legible del rol dentro del correo de invitación (el `role` crudo
 *  es un enum de base, no algo que se le enseñe a quien recibe el correo). */
const ROLE_LABELS: Record<string, string> = {
  owner: 'Propietario',
  admin: 'Administrador',
  analyst: 'Analista',
  writer: 'Redactor',
  reviewer: 'Revisor',
  viewer: 'Solo lectura',
};

/**
 * Datos que el correo de invitación necesita y que la transacción de la
 * invitación no devuelve: el nombre de la organización y el de quien invita.
 * Se leen CON el contexto RLS de quien invita (ya autenticado y miembro,
 * verificado por `app.requireOrg`), nunca con una función SECURITY DEFINER
 * nueva. Si algo faltara, se cae a un texto genérico antes que a un fallo:
 * la invitación ya existe, el correo no puede tumbarla.
 */
async function invitationMailContext(
  app: FastifyInstance,
  orgId: string,
  inviterId: string
): Promise<{ organizationName: string; inviterName: string }> {
  const { rows } = await app.db.transaction(async (tx) => {
    await tx.query('set local role app_role');
    await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
    await tx.query("select set_config('app.current_user_id', $1, true)", [inviterId]);
    return tx.query<{ org_name: string | null; inviter_name: string | null; inviter_email: string | null }>(
      `select (select name from organizations where id = $1) as org_name,
              (select full_name from users where id = $2) as inviter_name,
              (select email from users where id = $2) as inviter_email`,
      [orgId, inviterId]
    );
  });
  const row = rows[0];
  return {
    organizationName: row?.org_name ?? 'tu organización',
    inviterName: row?.inviter_name?.trim() || row?.inviter_email?.split('@')[0] || 'el equipo',
  };
}

/**
 * Protección del último owner (cierre de pendiente ronda 1): una
 * organización nunca puede quedarse sin ningún owner activo, ni por cambio
 * de rol ni por baja de membresía. Cuenta owners ACTIVOS distintos del
 * usuario objetivo dentro de la misma transacción/contexto de tenant ya
 * fijado por el llamador.
 */
async function assertNotLastOwner(tx: DbExecutor, orgId: string, targetUserId: string): Promise<void> {
  const { rows } = await tx.query<{ count: string }>(
    `select count(*)::text as count from memberships
     where org_id = $1 and role = 'owner' and status = 'active' and user_id <> $2`,
    [orgId, targetUserId]
  );
  if (Number(rows[0]?.count ?? '0') === 0) {
    throw new ConflictError('No puedes dejar a la organización sin ningún owner activo');
  }
}

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
            requestId: request.id, correlationId: request.correlationId,
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
        // DB-12 (docs/auditoria-1/db-api-reverificacion.md): `app.my_organizations`
        // ya no acepta un `user_id` arbitrario -- siempre resuelve las
        // organizaciones del `app.current_user_id()` fijado aquí (el propio
        // actor autenticado, nunca un valor de entrada del cliente).
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
        return tx.query<{ org_id: string; org_name: string; org_slug: string; role: string }>(
          'select * from app.my_organizations()'
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

      // API-08/API-02 (docs/auditoria-1/db-api-reverificacion.md, ALTA):
      // el PATCH de cambio de rol ya bloqueaba que un admin (no-owner) se
      // autopromoviera u otorgara `owner`, pero esta misma ruta de
      // invitación no tenía la protección equivalente -- un admin podía
      // invitar directamente a un tercero con `role:'owner'` y, al aceptar
      // la invitación, el rol se concedía sin control (mismo resultado que
      // API-02, por una puerta distinta). Misma regla que
      // `PATCH /organizations/memberships/:userId` (más abajo): solo un
      // owner puede CONCEDER el rol owner, sea por cambio de rol o por
      // invitación.
      if (request.body.role === 'owner' && request.orgRole !== 'owner') {
        throw new ForbiddenError('Solo un owner puede invitar con el rol owner');
      }

      const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
      const requestHash = hashRequestBody(request.body);

      const { email, role } = request.body;
      const invitationId = randomUUID();
      // El token EN CLARO solo existe en memoria hasta este punto: se
      // devuelve una única vez en la respuesta (ver invitationSchema) y solo
      // su hash se persiste. Sin esto, "aceptar invitación" sería imposible
      // (pendiente real de ronda 1: el token nunca se exponía).
      const token = randomUUID();
      const tokenHash = createHash('sha256').update(token).digest('hex');

      type InvitationBody = { id: string; email: string; role: string; status: string; token: string };

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
          requestId: request.id, correlationId: request.correlationId,
        });
        return { statusCode: 201, body: { id: invitationId, email, role, status: 'pending', token } };
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

      // REQ-181 (plantilla `organization-invite`): el correo de invitación.
      // Reutiliza la MISMA invitación y el MISMO token que ya emitió la
      // transacción de arriba (no se emite otro): el correo solo lo envuelve
      // en un enlace firmado con expiración -- ver `lib/mail/triggers.ts`.
      // Va sin `await` por la misma razón que el registro (un fallo del
      // proveedor no puede convertir una invitación ya creada en un 500), y
      // es idempotente por `messageKey`, así que un reintento con la misma
      // `Idempotency-Key` nunca manda dos correos.
      const contexto = await invitationMailContext(app, orgId, userId);
      fireAndForgetMail(app, 'organization-invite', () =>
        sendOrganizationInviteEmail(app, {
          invitationId: result.body.id,
          email: result.body.email,
          organizationId: orgId,
          organizationName: contexto.organizationName,
          inviterName: contexto.inviterName,
          roleLabel: ROLE_LABELS[result.body.role] ?? result.body.role,
          token: result.body.token,
          expiresInMinutes: INVITATION_TTL_MINUTES,
        })
      );

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

      // API-02 (docs/auditoria-1/db-api.md): solo un owner puede CONCEDER el
      // rol owner (a sí mismo o a otro miembro). Un admin puede administrar
      // el resto de roles, pero nunca escalar a owner -- si pudiera, un
      // admin se autopromovería libremente a owner (verificado en la
      // auditoría con 200 OK).
      if (role === 'owner' && request.orgRole !== 'owner') {
        throw new ForbiddenError('Solo un owner puede conceder el rol owner');
      }

      const updated = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [actorId]);

        const before = await tx.query('select role from memberships where org_id = $1 and user_id = $2', [
          orgId,
          targetUserId,
        ]);

        // Protección del último owner: si el objetivo es owner hoy y el
        // nuevo rol no lo es, no puede ser el último owner activo.
        if (before.rows[0]?.role === 'owner' && role !== 'owner') {
          await assertNotLastOwner(tx, orgId, targetUserId);
        }

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
            requestId: request.id, correlationId: request.correlationId,
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

  server.delete(
    '/memberships/:userId',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: memberParamsSchema },
    },
    async (request, reply) => {
      const orgId = request.orgId!;
      const actorId = request.userId!;
      const targetUserId = request.params.userId;

      if (!MEMBERSHIP_ADMIN_ROLES.includes(request.orgRole as any)) {
        throw new ForbiddenError('Solo owner/admin pueden eliminar miembros');
      }

      const deleted = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [actorId]);

        const before = await tx.query<{ role: string }>('select role from memberships where org_id = $1 and user_id = $2', [
          orgId,
          targetUserId,
        ]);
        if (before.rows[0]?.role === 'owner') {
          await assertNotLastOwner(tx, orgId, targetUserId);
        }

        const res = await tx.query('delete from memberships where org_id = $1 and user_id = $2', [orgId, targetUserId]);
        if (res.rowCount > 0) {
          await recordAudit(tx, {
            orgId,
            actorId,
            action: 'membership.delete',
            entity: 'membership',
            entityId: targetUserId,
            before: before.rows[0] ?? null,
            requestId: request.id, correlationId: request.correlationId,
          });
        }
        return res.rowCount;
      });

      if (deleted === 0) {
        throw new ConflictError('El usuario no es miembro de esta organización');
      }
      return reply.code(204).send();
    }
  );

  server.post(
    '/invitations/accept',
    {
      preHandler: [app.authenticate],
      schema: { body: acceptInvitationBodySchema, response: { 200: acceptedInvitationSchema } },
    },
    async (request) => {
      const userId = request.userId!;
      const tokenHash = createHash('sha256').update(request.body.token).digest('hex');

      let result: { org_id: string; role: string };
      try {
        const { rows } = await app.db.transaction(async (tx) => {
          await tx.query('set local role app_role');
          await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
          return tx.query<{ out_org_id: string; out_role: string }>('select * from app.accept_invitation($1, $2)', [
            tokenHash,
            userId,
          ]);
        });
        result = { org_id: rows[0].out_org_id, role: rows[0].out_role };
      } catch (err) {
        const pgErr = err as { message?: string };
        if (pgErr.message?.includes('invitation_not_found')) {
          throw new ConflictError('Invitación no encontrada');
        }
        if (pgErr.message?.includes('invitation_not_pending')) {
          throw new ConflictError('La invitación ya fue aceptada o revocada');
        }
        if (pgErr.message?.includes('invitation_expired')) {
          throw new ConflictError('La invitación ha expirado');
        }
        if (pgErr.message?.includes('invitation_email_mismatch')) {
          throw new UnauthorizedError('Esta invitación fue emitida para otro correo electrónico');
        }
        throw err;
      }

      await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [result.org_id]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
        await recordAudit(tx, {
          orgId: result.org_id,
          actorId: userId,
          action: 'invitation.accept',
          entity: 'invitation',
          entityId: null,
          after: { role: result.role },
          requestId: request.id, correlationId: request.correlationId,
        });
      });

      return { orgId: result.org_id, role: result.role as any };
    }
  );

  // ---------------------------------------------------------------------
  // Ronda 4: `GET /organizations/:orgId/memberships` -- lista los miembros
  // de una organización con su rol (email/nombre incluidos vía
  // `app.org_members`, SECURITY DEFINER, packages/db/migrations/0052).
  // Visible para cualquier miembro activo ("member+": cualquier rol,
  // incluido `viewer`) -- misma política que la RLS real de `memberships`
  // (0008, `sel_memberships`), sin restricción adicional en la aplicación.
  // El `:orgId` de la ruta se valida contra `X-Org-Id` (fuente real de la
  // organización activa, `app.requireOrg`): nunca se confía en el
  // parámetro de la URL por sí solo, mismo criterio que el resto de esta
  // API (ver DB-01/API-04).
  // ---------------------------------------------------------------------
  server.get(
    '/:orgId/memberships',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: {
        description: 'Lista los miembros de la organización con su rol real. Visible para member+ (cualquier rol activo).',
        params: membershipListParamsSchema,
        querystring: membershipListQuerySchema,
        response: { 200: membershipListResponseSchema },
      },
    },
    async (request) => {
      const orgId = request.orgId!;
      if (request.params.orgId !== orgId) {
        throw new ForbiddenError('El orgId de la ruta no coincide con el encabezado X-Org-Id');
      }
      const { cursor, limit } = request.query;
      const pageSize = parsePageSize(limit);
      const decoded = cursor ? decodeCursor(cursor) : null;

      const conditions: string[] = [];
      const params: unknown[] = [orgId];
      if (decoded) {
        params.push(decoded.sortKey, decoded.id);
        conditions.push(`(joined_at, user_id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      params.push(pageSize + 1);
      const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';

      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query<{ user_id: string; email: string; full_name: string | null; role: string; status: string; joined_at: string }>(
          `select * from app.org_members($1) ${where} order by joined_at asc, user_id asc limit $${params.length}`,
          params
        );
      });

      const hasMore = rows.length > pageSize;
      const page = hasMore ? rows.slice(0, pageSize) : rows;
      const last = page[page.length - 1];
      const nextCursor = hasMore && last ? encodeCursor(toIsoString(last.joined_at), last.user_id) : null;
      return {
        items: page.map((r) => ({ userId: r.user_id, email: r.email, fullName: r.full_name, role: r.role as any, status: r.status as any, joinedAt: r.joined_at })),
        nextCursor,
      };
    }
  );
}
