import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { NotFoundError } from '../../lib/errors.js';
import {
  tenderListQuerySchema,
  tenderListResponseSchema,
  tenderSchema,
  tenderVersionSchema,
  tenderChangeEventSchema,
  sourceFreshnessSchema,
} from './schemas.js';

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof createdAt !== 'string' || typeof id !== 'string') return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function mapTenderRow(r: Record<string, unknown>): any {
  return {
    id: r.id,
    source: r.source,
    externalId: r.external_id,
    title: r.title,
    contractingBody: r.contracting_body,
    cpvCodes: r.cpv_codes ?? [],
    budgetAmount: r.budget_amount !== null && r.budget_amount !== undefined ? Number(r.budget_amount) : null,
    currency: r.currency,
    submissionDeadline: r.submission_deadline,
    publishedAt: r.published_at,
    url: r.url,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function tenderRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { querystring: tenderListQuerySchema, response: { 200: tenderListResponseSchema } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const { status, source, cursor, limit } = request.query;
      const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
      const pageSize = parsedLimit && parsedLimit >= 1 && parsedLimit <= 100 ? parsedLimit : 20;

      const conditions: string[] = ['org_id = $1'];
      const params: unknown[] = [orgId];
      if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }
      if (source) {
        params.push(source);
        conditions.push(`source = $${params.length}`);
      }
      const decoded = cursor ? decodeCursor(cursor) : null;
      if (decoded) {
        params.push(decoded.createdAt, decoded.id);
        conditions.push(`(created_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      params.push(pageSize + 1);

      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query(
          `select * from tenders where ${conditions.join(' and ')} order by created_at asc, id asc limit $${params.length}`,
          params
        );
      });

      const hasMore = rows.length > pageSize;
      const page = hasMore ? rows.slice(0, pageSize) : rows;
      const last = page[page.length - 1] as Record<string, unknown> | undefined;
      const nextCursor = hasMore && last ? encodeCursor(last.created_at as string, last.id as string) : null;

      return { items: page.map((r) => mapTenderRow(r as Record<string, unknown>)), nextCursor };
    }
  );

  server.get(
    '/:id',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ id: z.string().uuid() }), response: { 200: tenderSchema } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query('select * from tenders where id = $1 and org_id = $2', [request.params.id, orgId]);
      });
      if (rows.length === 0) throw new NotFoundError('Convocatoria no encontrada');
      return mapTenderRow(rows[0] as Record<string, unknown>);
    }
  );

  server.get(
    '/:id/versions',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ id: z.string().uuid() }), response: { 200: z.array(tenderVersionSchema) } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query(
          'select * from tender_versions where org_id = $1 and tender_id = $2 order by effective_at asc',
          [orgId, request.params.id]
        );
      });
      return rows.map((r: any) => ({
        id: r.id,
        changeKind: r.change_kind,
        sourceVersion: r.source_version,
        effectiveAt: r.effective_at,
        payload: r.payload,
        createdAt: r.created_at,
      }));
    }
  );

  server.get(
    '/:id/change-events',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ id: z.string().uuid() }), response: { 200: z.array(tenderChangeEventSchema) } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query(
          'select * from tender_change_events where org_id = $1 and tender_id = $2 order by created_at asc',
          [orgId, request.params.id]
        );
      });
      return rows.map((r: any) => ({
        id: r.id,
        changeKind: r.change_kind,
        tenderVersionId: r.tender_version_id,
        summary: r.summary,
        createdAt: r.created_at,
      }));
    }
  );

  // Frescura por fuente (REQ-149/REQ-150): disponible para cualquier usuario
  // autenticado, sin requerir X-Org-Id (la frescura de una fuente pública no
  // es un dato de tenant). Ver packages/db/migrations/0018_source_freshness.sql.
  server.get(
    '/sources/freshness',
    {
      preHandler: [app.authenticate],
      schema: { response: { 200: z.array(sourceFreshnessSchema) } },
    },
    async (request) => {
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query<{
          source_id: string;
          status: string;
          last_success_at: string | null;
          started_at: string;
          finished_at: string | null;
          attempts: number;
        }>('select * from app.source_freshness()');
      });
      const now = Date.now();
      return rows.map((r) => ({
        sourceId: r.source_id,
        status: r.status,
        lastSuccessAt: r.last_success_at,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        attempts: r.attempts,
        ageSeconds: r.last_success_at ? Math.floor((now - new Date(r.last_success_at).getTime()) / 1000) : null,
      }));
    }
  );
}
