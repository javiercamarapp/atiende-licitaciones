/**
 * REQ-060: módulo de lado comprador (OIC/contraloría), con su propio
 * aislamiento de datos y roles respecto al lado proveedor -- ver
 * packages/db/migrations/0099_req060_oic_module.sql para el diseño
 * completo y packages/db/test/req060-oic-isolation.test.ts para la prueba
 * de aislamiento adversarial (criterio de aceptación literal de REQ-060).
 *
 * Deliberadamente NO reutiliza `modules/organizations/routes.ts`:
 *  - Autenticación de organización vía `app.requireOicOrg` (cabecera
 *    `X-Oic-Org-Id`), nunca `app.requireOrg` (`X-Org-Id`) -- ver
 *    `plugins/auth.plugin.ts`.
 *  - Autorización de rol vía `requireOicRole`/`request.oicRole`, nunca
 *    `requireOrgRole`/`request.orgRole`.
 *  - Toda consulta a la base fija el contexto de sesión con
 *    `oicOrgId`/`userId` (nunca `orgId`), para que la RLS de
 *    `oic_memberships`/`oic_watch_items` (basada en `app.has_oic_role`) sea
 *    la que realmente decide.
 *
 * HONESTO/PENDIENTE (ver migración 0099): `oic_watch_items` no está
 * enganchado a ningún feed público real de convocatorias -- REQ-058
 * (hechos públicos compartidos) sigue sin construirse, así que el folio se
 * captura manualmente. Tampoco hay flujo de invitación por correo para dar
 * de alta un segundo/tercer miembro OIC (solo alta directa por
 * `director_oic`, ver `POST /oic/organizations/members`) -- ninguna de las
 * dos cosas es parte del criterio de aceptación de REQ-060 (aislamiento),
 * y ambas quedan fuera de alcance de esta ronda.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { OIC_MEMBERSHIP_ADMIN_ROLES, OIC_WRITE_ROLES, type OicRole } from '@atiende/db';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { requireOicRole } from '../../lib/authorize.js';
import { encodeCursor, decodeCursor, parsePageSize, toIsoString } from '../../lib/cursor.js';
import {
  createOicOrgBodySchema,
  oicOrgSchema,
  myOicOrgSchema,
  createWatchItemBodySchema,
  updateWatchItemBodySchema,
  watchItemSchema,
  watchItemListQuerySchema,
  watchItemListResponseSchema,
  watchItemParamsSchema,
} from './schemas.js';

const UNIQUE_VIOLATION = '23505';

const addMemberBodySchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['director_oic', 'analista_oic', 'consulta_oic']),
});

// Tipo de retorno `any` a propósito -- mismo patrón que `mapAuditLogRow` en
// modules/audit/routes.ts: `created_at`/`updated_at` llegan como `Date`
// (driver de Postgres/PGlite), que es el tipo de ENTRADA de `isoTimestamp`
// (packages/db/../lib/schema-helpers.js), no su tipo de SALIDA (string) --
// el serializador de fastify-type-provider-zod aplica el `.transform()` él
// mismo antes de responder.
function mapWatchItemRow(r: Record<string, unknown>): any {
  return {
    id: r.id,
    orgId: r.org_id,
    source: r.source,
    externalId: r.external_id,
    contractingBody: r.contracting_body ?? null,
    title: r.title,
    riskCategory: r.risk_category,
    riskNote: r.risk_note ?? null,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function oicRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // -------------------------------------------------------------------
  // Organizaciones (lado comprador) -- paralelo de POST/GET /organizations,
  // pero sobre oic_memberships. Mismo patrón de bootstrap sin RETURNING
  // (ver packages/db/test/org-bootstrap.test.ts): el creador aún no es
  // miembro OIC cuando se inserta la organización.
  // -------------------------------------------------------------------
  server.post(
    '/organizations',
    {
      preHandler: [app.authenticate],
      schema: { body: createOicOrgBodySchema, response: { 201: oicOrgSchema } },
    },
    async (request, reply) => {
      const { name, slug } = request.body;
      const orgId = randomUUID();
      const userId = request.userId!;

      try {
        await app.db.transaction(async (tx) => {
          await tx.query('set local role app_role');
          await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
          await tx.query("insert into organizations (id, name, slug, kind) values ($1, $2, $3, 'comprador')", [
            orgId,
            name,
            slug,
          ]);
          await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
          await tx.query("insert into oic_memberships (org_id, user_id, role) values ($1, $2, 'director_oic')", [
            orgId,
            userId,
          ]);
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
    '/organizations',
    {
      preHandler: [app.authenticate],
      schema: { response: { 200: z.array(myOicOrgSchema) } },
    },
    async (request) => {
      const userId = request.userId!;
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
        return tx.query<{ org_id: string; org_name: string; org_slug: string; role: string }>(
          'select * from app.my_oic_organizations()'
        );
      });
      return rows.map((r) => ({ id: r.org_id, name: r.org_name, slug: r.org_slug, role: r.role as OicRole }));
    }
  );

  // Alta directa de un miembro OIC adicional (sin invitación por correo,
  // ver nota "HONESTO/PENDIENTE" al inicio del archivo). Solo director_oic.
  server.post(
    '/organizations/members',
    {
      preHandler: [app.authenticate, app.requireOicOrg],
      schema: { body: addMemberBodySchema, response: { 201: z.object({ userId: z.string().uuid(), role: z.string() }) } },
    },
    async (request, reply) => {
      requireOicRole(request, OIC_MEMBERSHIP_ADMIN_ROLES, 'Solo director_oic puede dar de alta miembros OIC');
      const oicOrgId = request.oicOrgId!;
      const { userId: targetUserId, role } = request.body;

      try {
        await app.db.transaction(async (tx) => {
          await tx.query('set local role app_role');
          await tx.query("select set_config('app.current_org_id', $1, true)", [oicOrgId]);
          await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
          await tx.query('insert into oic_memberships (org_id, user_id, role) values ($1, $2, $3)', [
            oicOrgId,
            targetUserId,
            role,
          ]);
        });
      } catch (err) {
        const pgErr = err as { code?: string };
        if (pgErr.code === UNIQUE_VIOLATION) {
          throw new ConflictError('Ese usuario ya es miembro OIC de esta organización');
        }
        throw err;
      }

      reply.code(201);
      return { userId: targetUserId, role };
    }
  );

  // -------------------------------------------------------------------
  // Procedimientos vigilados (oic_watch_items).
  // -------------------------------------------------------------------
  server.post(
    '/watch-items',
    {
      preHandler: [app.authenticate, app.requireOicOrg],
      schema: { body: createWatchItemBodySchema, response: { 201: watchItemSchema } },
    },
    async (request, reply) => {
      requireOicRole(request, OIC_WRITE_ROLES, 'consulta_oic no puede dar de alta procedimientos vigilados');
      const oicOrgId = request.oicOrgId!;
      const { source, externalId, contractingBody, title, riskCategory, riskNote } = request.body;

      let row: Record<string, unknown>;
      try {
        const result = await app.db.transaction(async (tx) => {
          await tx.query('set local role app_role');
          await tx.query("select set_config('app.current_org_id', $1, true)", [oicOrgId]);
          await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
          return tx.query<Record<string, unknown>>(
            `insert into oic_watch_items (org_id, source, external_id, contracting_body, title, risk_category, risk_note, created_by)
             values ($1, $2, $3, $4, $5, coalesce($6, 'sin_clasificar'), $7, $8)
             returning *`,
            [oicOrgId, source, externalId, contractingBody ?? null, title, riskCategory ?? null, riskNote ?? null, request.userId]
          );
        });
        row = result.rows[0];
      } catch (err) {
        const pgErr = err as { code?: string };
        if (pgErr.code === UNIQUE_VIOLATION) {
          throw new ConflictError('Ya existe un procedimiento vigilado con ese source/externalId en esta organización');
        }
        throw err;
      }

      reply.code(201);
      return mapWatchItemRow(row);
    }
  );

  server.get(
    '/watch-items',
    {
      preHandler: [app.authenticate, app.requireOicOrg],
      schema: { querystring: watchItemListQuerySchema, response: { 200: watchItemListResponseSchema } },
    },
    async (request) => {
      const oicOrgId = request.oicOrgId!;
      const { cursor, limit } = request.query;
      const pageSize = parsePageSize(limit);
      const decoded = cursor ? decodeCursor(cursor) : null;

      const conditions: string[] = ['org_id = $1'];
      const params: unknown[] = [oicOrgId];
      if (decoded) {
        params.push(decoded.sortKey, decoded.id);
        conditions.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      params.push(pageSize + 1);

      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [oicOrgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query<Record<string, unknown>>(
          `select * from oic_watch_items where ${conditions.join(' and ')} order by created_at desc, id desc limit $${params.length}`,
          params
        );
      });

      const hasMore = rows.length > pageSize;
      const page = hasMore ? rows.slice(0, pageSize) : rows;
      const last = page[page.length - 1] as Record<string, unknown> | undefined;
      const nextCursor = hasMore && last ? encodeCursor(toIsoString(last.created_at), String(last.id)) : null;
      return { items: page.map(mapWatchItemRow), nextCursor };
    }
  );

  server.get(
    '/watch-items/:id',
    {
      preHandler: [app.authenticate, app.requireOicOrg],
      schema: { params: watchItemParamsSchema, response: { 200: watchItemSchema } },
    },
    async (request) => {
      const oicOrgId = request.oicOrgId!;
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [oicOrgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        // `org_id = $2` es defensa en profundidad EXPLÍCITA en la
        // aplicación (mismo criterio documentado en lib/authorize.ts):
        // RLS ya lo garantiza vía `org_id = app.current_org_id()`, pero
        // filtrarlo aquí también evita depender EXCLUSIVAMENTE de RLS para
        // que un id de otra organización compradora nunca aparezca, incluso
        // si algo corriera esta consulta fuera de una transacción con
        // contexto (p.ej. un bug futuro).
        return tx.query<Record<string, unknown>>('select * from oic_watch_items where id = $1 and org_id = $2', [
          request.params.id,
          oicOrgId,
        ]);
      });
      if (rows.length === 0) {
        throw new NotFoundError('Procedimiento vigilado no encontrado');
      }
      return mapWatchItemRow(rows[0]);
    }
  );

  server.patch(
    '/watch-items/:id',
    {
      preHandler: [app.authenticate, app.requireOicOrg],
      schema: { params: watchItemParamsSchema, body: updateWatchItemBodySchema, response: { 200: watchItemSchema } },
    },
    async (request) => {
      requireOicRole(request, OIC_WRITE_ROLES, 'consulta_oic no puede editar procedimientos vigilados');
      const oicOrgId = request.oicOrgId!;
      const { riskCategory, riskNote, status } = request.body;
      if (riskCategory === undefined && riskNote === undefined && status === undefined) {
        throw new BadRequestError('Nada que actualizar');
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      if (riskCategory !== undefined) {
        params.push(riskCategory);
        sets.push(`risk_category = $${params.length}`);
      }
      if (riskNote !== undefined) {
        params.push(riskNote);
        sets.push(`risk_note = $${params.length}`);
      }
      if (status !== undefined) {
        params.push(status);
        sets.push(`status = $${params.length}`);
      }
      params.push(request.params.id, oicOrgId);
      const idParamIndex = params.length - 1;
      const orgIdParamIndex = params.length;

      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [oicOrgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        // Mismo criterio de defensa en profundidad que el GET de arriba:
        // `org_id = $N` explícito además de la RLS real.
        return tx.query<Record<string, unknown>>(
          `update oic_watch_items set ${sets.join(', ')} where id = $${idParamIndex} and org_id = $${orgIdParamIndex} returning *`,
          params
        );
      });
      if (rows.length === 0) {
        throw new NotFoundError('Procedimiento vigilado no encontrado');
      }
      return mapWatchItemRow(rows[0]);
    }
  );
}
