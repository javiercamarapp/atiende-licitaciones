import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DbExecutor, OrgRole } from '@atiende/db';
import { NotFoundError } from './errors.js';
import { recordAudit } from './audit.js';
import { requireOrgRole } from './authorize.js';
import { recordFieldProvenance, deleteFieldProvenance, getFieldProvenance } from './provenance.js';

/**
 * Fábrica de rutas CRUD "simples" (una tabla plana por organización, sin
 * relaciones anidadas) para las categorías del perfil de empresa (E2,
 * REQ-141) que comparten la misma forma: listar, crear, editar, borrar,
 * todo con procedencia por fila (ver lib/provenance.ts) y auditoría. Evita
 * repetir el mismo boilerplate 7 veces (capabilities, experience_records,
 * products_services, locations, registrations, authorized_signatories,
 * restrictions); company_profiles (singleton), company_documents (subida de
 * archivo) y approved_rates (flujo propuesta/aprobación) tienen forma propia
 * y se implementan por separado en modules/company/routes.ts.
 */
export interface SimpleCrudOptions<TCreate, TUpdate> {
  /** Ruta relativa dentro de /company, p.ej. 'capabilities'. */
  path: string;
  /** Nombre de la tabla SQL. */
  table: string;
  /** Nombre lógico de la entidad para field_provenance/audit_log. */
  entity: string;
  createSchema: z.ZodType<TCreate>;
  updateSchema: z.ZodType<TUpdate>;
  responseSchema: z.ZodTypeAny;
  /** Roles que pueden crear/editar/borrar (además de RLS, que es la última línea de defensa). */
  writeRoles: OrgRole[];
  /** Convierte el body validado en columnas SQL (nombre de columna -> valor). */
  toColumns: (body: TCreate | TUpdate) => Record<string, unknown>;
  /** Convierte una fila de la base (snake_case) a la forma de respuesta (camelCase). */
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Validación adicional específica de la entidad (más allá del schema de
   * Zod), corre DENTRO de la misma transacción -- ya con `set local role
   * app_role`/contexto de tenant aplicado, así que puede consultar otras
   * tablas de la organización con RLS real -- justo antes de insertar o
   * actualizar. Debe lanzar un `AppError` (p. ej. `ValidationAppError`,
   * 422) si el body no es válido; cualquier excepción aborta la
   * transacción (ROLLBACK) y nunca llega a tocar la tabla.
   */
  validate?: (columns: Record<string, unknown>, ctx: { tx: DbExecutor; orgId: string }) => Promise<void>;
}

export function registerSimpleCrud<TCreate, TUpdate>(
  app: FastifyInstance,
  opts: SimpleCrudOptions<TCreate, TUpdate>
): void {
  // Nota deliberada: NO se usa `app.withTypeProvider<ZodTypeProvider>()` aquí
  // (a diferencia del resto de módulos) porque esta fábrica es genérica sobre
  // `TCreate`/`TUpdate` y el compilador no puede unificar esos genéricos con
  // los tipos concretos que infiere `ZodTypeProvider` por ruta. La validación
  // en runtime sigue aplicándose igual: `validatorCompiler`/`serializerCompiler`
  // están registrados globalmente en `app` (ver app.ts), no dependen de usar
  // el type provider tipado en cada sitio de registro de ruta.
  const server = app;
  const idParams = z.object({ id: z.string().uuid() });

  server.get(
    `/${opts.path}`,
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { response: { 200: z.array(opts.responseSchema) } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query(`select * from ${opts.table} where org_id = $1 order by created_at asc`, [orgId]);
      });
      return rows.map((r) => opts.fromRow(r as Record<string, unknown>));
    }
  );

  server.post(
    `/${opts.path}`,
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { body: opts.createSchema, response: { 201: opts.responseSchema } },
    },
    async (request: FastifyRequest, reply) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, opts.writeRoles);

      const columns = opts.toColumns(request.body as TCreate);
      const id = randomUUID();
      const colNames = ['id', 'org_id', ...Object.keys(columns)];
      const values = [id, orgId, ...Object.values(columns)];
      const placeholders = colNames.map((_, i) => `$${i + 1}`).join(', ');

      const row = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
        if (opts.validate) await opts.validate(columns, { tx, orgId });
        const inserted = await tx.query(
          `insert into ${opts.table} (${colNames.join(', ')}) values (${placeholders}) returning *`,
          values
        );
        await recordFieldProvenance(tx, {
          orgId,
          entity: opts.entity,
          entityId: id,
          field: '*',
          ownerUserId: userId,
          source: 'manual',
        });
        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: `${opts.entity}.create`,
          entity: opts.entity,
          entityId: id,
          after: columns,
          requestId: request.id, correlationId: request.correlationId,
        });
        return inserted.rows[0];
      });

      reply.code(201);
      return opts.fromRow(row as Record<string, unknown>);
    }
  );

  server.patch(
    `/${opts.path}/:id`,
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: idParams, body: opts.updateSchema, response: { 200: opts.responseSchema } },
    },
    async (request: FastifyRequest) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, opts.writeRoles);

      const id = (request.params as { id: string }).id;
      const columns = opts.toColumns(request.body as TUpdate);
      const keys = Object.keys(columns);
      if (keys.length === 0) {
        throw new NotFoundError('Nada que actualizar');
      }
      const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      const values = [id, ...Object.values(columns)];

      const row = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
        if (opts.validate) await opts.validate(columns, { tx, orgId });
        const before = await tx.query(`select * from ${opts.table} where id = $1 and org_id = $2`, [id, orgId]);
        const updated = await tx.query(
          `update ${opts.table} set ${setClause} where id = $1 and org_id = ${'$' + (values.length + 1)} returning *`,
          [...values, orgId]
        );
        if (updated.rows.length === 0) return null;
        await recordFieldProvenance(tx, {
          orgId,
          entity: opts.entity,
          entityId: id,
          field: '*',
          ownerUserId: userId,
          source: 'manual',
        });
        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: `${opts.entity}.update`,
          entity: opts.entity,
          entityId: id,
          before: before.rows[0] ?? null,
          after: columns,
          requestId: request.id, correlationId: request.correlationId,
        });
        return updated.rows[0];
      });

      if (!row) throw new NotFoundError(`${opts.entity} no encontrado`);
      return opts.fromRow(row as Record<string, unknown>);
    }
  );

  server.delete(
    `/${opts.path}/:id`,
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: idParams },
    },
    async (request: FastifyRequest, reply) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, opts.writeRoles);
      const id = (request.params as { id: string }).id;

      const deleted = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
        const before = await tx.query(`select * from ${opts.table} where id = $1 and org_id = $2`, [id, orgId]);
        const res = await tx.query(`delete from ${opts.table} where id = $1 and org_id = $2`, [id, orgId]);
        if (res.rowCount > 0) {
          await deleteFieldProvenance(tx, { orgId, entity: opts.entity, entityId: id });
          await recordAudit(tx, {
            orgId,
            actorId: userId,
            action: `${opts.entity}.delete`,
            entity: opts.entity,
            entityId: id,
            before: before.rows[0] ?? null,
            requestId: request.id, correlationId: request.correlationId,
          });
        }
        return res.rowCount;
      });

      if (deleted === 0) throw new NotFoundError(`${opts.entity} no encontrado`);
      return reply.code(204).send();
    }
  );

  // Exponer procedencia de una fila (REQ-142): quién y de dónde vino cada
  // dato, para que matching/expediente puedan excluir lo que no la tiene.
  server.get(
    `/${opts.path}/:id/provenance`,
    {
      preHandler: [app.authenticate, app.requireOrg],
    },
    async (request: FastifyRequest) => {
      const orgId = request.orgId!;
      const id = (request.params as { id: string }).id;
      return app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return getFieldProvenance(tx, { orgId, entity: opts.entity, entityId: id });
      });
    }
  );
}
