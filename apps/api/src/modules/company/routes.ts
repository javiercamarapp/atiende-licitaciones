import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MEMBERSHIP_ADMIN_ROLES, WRITE_ROLES } from '@atiende/db';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { requireOrgRole } from '../../lib/authorize.js';
import { recordFieldProvenance, getFieldProvenance } from '../../lib/provenance.js';
import { registerSimpleCrud } from '../../lib/company-crud.js';
import { decodeBase64Content, storeFile, computeDocumentStatus } from '../../lib/storage.js';
import {
  companyProfileUpsertSchema,
  companyProfileSchema,
  capabilityCreateSchema,
  capabilityUpdateSchema,
  capabilitySchema,
  experienceCreateSchema,
  experienceUpdateSchema,
  experienceSchema,
  productServiceCreateSchema,
  productServiceUpdateSchema,
  productServiceSchema,
  locationCreateSchema,
  locationUpdateSchema,
  locationSchema,
  registrationCreateSchema,
  registrationUpdateSchema,
  registrationSchema,
  signatoryCreateSchema,
  signatoryUpdateSchema,
  signatorySchema,
  restrictionCreateSchema,
  restrictionUpdateSchema,
  restrictionSchema,
  documentCreateSchema,
  documentSchema,
  rateCreateSchema,
  rateSchema,
} from './schemas.js';

function toCamelRow(row: Record<string, unknown>, mapping: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [camel, snake] of Object.entries(mapping)) {
    out[camel] = row[snake] ?? null;
  }
  return out;
}

export async function companyRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // -------------------------------------------------------------------------
  // company_profiles: singleton por organización (GET/PUT). Escritura
  // reservada a owner/admin (sensibilidad: razón social, RFC, facturación).
  // -------------------------------------------------------------------------
  server.get(
    '/profile',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { response: { 200: companyProfileSchema.nullable() } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query('select * from company_profiles where org_id = $1', [orgId]);
      });
      if (rows.length === 0) return null;
      return mapProfileRow(rows[0] as Record<string, unknown>);
    }
  );

  server.put(
    '/profile',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { body: companyProfileUpsertSchema, response: { 200: companyProfileSchema } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, MEMBERSHIP_ADMIN_ROLES, 'Solo owner/admin pueden editar el perfil de empresa');

      const b = request.body;
      const row = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);

        const before = await tx.query('select id from company_profiles where org_id = $1', [orgId]);

        const upserted = await tx.query(
          `insert into company_profiles (org_id, legal_name, trade_name, tax_id, description, sector, founded_year, employee_count, annual_revenue, website)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           on conflict (org_id) do update set
             legal_name = excluded.legal_name, trade_name = excluded.trade_name, tax_id = excluded.tax_id,
             description = excluded.description, sector = excluded.sector, founded_year = excluded.founded_year,
             employee_count = excluded.employee_count, annual_revenue = excluded.annual_revenue, website = excluded.website
           returning *`,
          [
            orgId,
            b.legalName,
            b.tradeName ?? null,
            b.taxId ?? null,
            b.description ?? null,
            b.sector ?? null,
            b.foundedYear ?? null,
            b.employeeCount ?? null,
            b.annualRevenue ?? null,
            b.website ?? null,
          ]
        );
        const profileId = upserted.rows[0].id as string;

        // Procedencia por campo real (no solo por fila) para el perfil
        // principal: cada campo editable registra su propio owner/source.
        for (const field of ['legalName', 'tradeName', 'taxId', 'description', 'sector', 'foundedYear', 'employeeCount', 'annualRevenue', 'website']) {
          if ((b as Record<string, unknown>)[field] !== undefined) {
            await recordFieldProvenance(tx, {
              orgId,
              entity: 'company_profiles',
              entityId: profileId,
              field,
              ownerUserId: userId,
              source: 'manual',
            });
          }
        }

        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: before.rows.length > 0 ? 'company_profile.update' : 'company_profile.create',
          entity: 'company_profiles',
          entityId: profileId,
          after: b,
          requestId: request.id,
        });

        return upserted.rows[0];
      });

      return mapProfileRow(row as Record<string, unknown>);
    }
  );

  server.get('/profile/provenance', { preHandler: [app.authenticate, app.requireOrg] }, async (request) => {
    const orgId = request.orgId!;
    const { rows } = await app.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
      await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
      return tx.query('select id from company_profiles where org_id = $1', [orgId]);
    });
    if (rows.length === 0) return [];
    return app.db.transaction((tx) =>
      getFieldProvenance(tx, { orgId, entity: 'company_profiles', entityId: (rows[0] as any).id })
    );
  });

  // -------------------------------------------------------------------------
  // Subrecursos CRUD simples (ver lib/company-crud.ts)
  // -------------------------------------------------------------------------
  registerSimpleCrud(app, {
    path: 'capabilities',
    table: 'capabilities',
    entity: 'capabilities',
    createSchema: capabilityCreateSchema,
    updateSchema: capabilityUpdateSchema,
    responseSchema: capabilitySchema,
    writeRoles: WRITE_ROLES,
    toColumns: (b: any) => ({
      ...(b.name !== undefined && { name: b.name }),
      ...(b.category !== undefined && { category: b.category }),
      ...(b.description !== undefined && { description: b.description }),
      ...(b.isVerified !== undefined && { is_verified: b.isVerified }),
      ...(b.evidenceRef !== undefined && { evidence_ref: b.evidenceRef }),
    }),
    fromRow: (r) =>
      toCamelRow(r, {
        id: 'id',
        name: 'name',
        category: 'category',
        description: 'description',
        isVerified: 'is_verified',
        evidenceRef: 'evidence_ref',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      }),
  });

  registerSimpleCrud(app, {
    path: 'experience',
    table: 'experience_records',
    entity: 'experience_records',
    createSchema: experienceCreateSchema,
    updateSchema: experienceUpdateSchema,
    responseSchema: experienceSchema,
    writeRoles: WRITE_ROLES,
    toColumns: (b: any) => ({
      ...(b.title !== undefined && { title: b.title }),
      ...(b.clientName !== undefined && { client_name: b.clientName }),
      ...(b.description !== undefined && { description: b.description }),
      ...(b.contractValue !== undefined && { contract_value: b.contractValue }),
      ...(b.currency !== undefined && { currency: b.currency }),
      ...(b.startDate !== undefined && { start_date: b.startDate }),
      ...(b.endDate !== undefined && { end_date: b.endDate }),
      ...(b.isVerified !== undefined && { is_verified: b.isVerified }),
      ...(b.evidenceRef !== undefined && { evidence_ref: b.evidenceRef }),
    }),
    fromRow: (r) => {
      const base = toCamelRow(r, {
        id: 'id',
        title: 'title',
        clientName: 'client_name',
        description: 'description',
        contractValue: 'contract_value',
        currency: 'currency',
        startDate: 'start_date',
        endDate: 'end_date',
        isVerified: 'is_verified',
        evidenceRef: 'evidence_ref',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      });
      // REQ-143: sin documento probatorio enlazado, "no verificable"; no
      // cuenta para elegibilidad ni matriz de requisitos (ver matching).
      base.verifiable = Boolean(r.evidence_ref);
      return base;
    },
  });

  registerSimpleCrud(app, {
    path: 'products-services',
    table: 'products_services',
    entity: 'products_services',
    createSchema: productServiceCreateSchema,
    updateSchema: productServiceUpdateSchema,
    responseSchema: productServiceSchema,
    writeRoles: WRITE_ROLES,
    toColumns: (b: any) => ({
      ...(b.name !== undefined && { name: b.name }),
      ...(b.category !== undefined && { category: b.category }),
      ...(b.description !== undefined && { description: b.description }),
    }),
    fromRow: (r) =>
      toCamelRow(r, {
        id: 'id',
        name: 'name',
        category: 'category',
        description: 'description',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      }),
  });

  registerSimpleCrud(app, {
    path: 'locations',
    table: 'locations',
    entity: 'locations',
    createSchema: locationCreateSchema,
    updateSchema: locationUpdateSchema,
    responseSchema: locationSchema,
    writeRoles: WRITE_ROLES,
    toColumns: (b: any) => ({
      ...(b.label !== undefined && { label: b.label }),
      ...(b.addressLine !== undefined && { address_line: b.addressLine }),
      ...(b.city !== undefined && { city: b.city }),
      ...(b.state !== undefined && { state: b.state }),
      ...(b.country !== undefined && { country: b.country }),
      ...(b.postalCode !== undefined && { postal_code: b.postalCode }),
      ...(b.isPrimary !== undefined && { is_primary: b.isPrimary }),
    }),
    fromRow: (r) =>
      toCamelRow(r, {
        id: 'id',
        label: 'label',
        addressLine: 'address_line',
        city: 'city',
        state: 'state',
        country: 'country',
        postalCode: 'postal_code',
        isPrimary: 'is_primary',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      }),
  });

  registerSimpleCrud(app, {
    path: 'registrations',
    table: 'registrations',
    entity: 'registrations',
    createSchema: registrationCreateSchema,
    updateSchema: registrationUpdateSchema,
    responseSchema: registrationSchema,
    writeRoles: MEMBERSHIP_ADMIN_ROLES,
    toColumns: (b: any) => ({
      ...(b.kind !== undefined && { kind: b.kind }),
      ...(b.value !== undefined && { value: b.value }),
      ...(b.issuingAuthority !== undefined && { issuing_authority: b.issuingAuthority }),
      ...(b.validFrom !== undefined && { valid_from: b.validFrom }),
      ...(b.validUntil !== undefined && { valid_until: b.validUntil }),
    }),
    fromRow: (r) =>
      toCamelRow(r, {
        id: 'id',
        kind: 'kind',
        value: 'value',
        issuingAuthority: 'issuing_authority',
        validFrom: 'valid_from',
        validUntil: 'valid_until',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      }),
  });

  registerSimpleCrud(app, {
    path: 'signatories',
    table: 'authorized_signatories',
    entity: 'authorized_signatories',
    createSchema: signatoryCreateSchema,
    updateSchema: signatoryUpdateSchema,
    responseSchema: signatorySchema,
    writeRoles: MEMBERSHIP_ADMIN_ROLES,
    toColumns: (b: any) => ({
      ...(b.fullName !== undefined && { full_name: b.fullName }),
      ...(b.roleTitle !== undefined && { role_title: b.roleTitle }),
      ...(b.idDocumentRef !== undefined && { id_document_ref: b.idDocumentRef }),
      ...(b.validFrom !== undefined && { valid_from: b.validFrom }),
      ...(b.validUntil !== undefined && { valid_until: b.validUntil }),
    }),
    fromRow: (r) =>
      toCamelRow(r, {
        id: 'id',
        fullName: 'full_name',
        roleTitle: 'role_title',
        idDocumentRef: 'id_document_ref',
        validFrom: 'valid_from',
        validUntil: 'valid_until',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      }),
  });

  registerSimpleCrud(app, {
    path: 'restrictions',
    table: 'restrictions',
    entity: 'restrictions',
    createSchema: restrictionCreateSchema,
    updateSchema: restrictionUpdateSchema,
    responseSchema: restrictionSchema,
    writeRoles: MEMBERSHIP_ADMIN_ROLES,
    toColumns: (b: any) => ({
      ...(b.kind !== undefined && { kind: b.kind }),
      ...(b.description !== undefined && { description: b.description }),
      ...(b.validUntil !== undefined && { valid_until: b.validUntil }),
    }),
    fromRow: (r) =>
      toCamelRow(r, {
        id: 'id',
        kind: 'kind',
        description: 'description',
        validUntil: 'valid_until',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      }),
  });

  // -------------------------------------------------------------------------
  // company_documents: metadatos + vigencia + archivo en disco (STORAGE_DIR,
  // sha256, sin S3). Escritura reservada a owner/admin.
  // -------------------------------------------------------------------------
  server.get(
    '/documents',
    { preHandler: [app.authenticate, app.requireOrg], schema: { response: { 200: z.array(documentSchema) } } },
    async (request) => {
      const orgId = request.orgId!;
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query('select * from company_documents where org_id = $1 order by created_at asc', [orgId]);
      });
      return rows.map((r) => mapDocumentRow(r as Record<string, unknown>));
    }
  );

  server.post(
    '/documents',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { body: documentCreateSchema, response: { 201: documentSchema } },
    },
    async (request, reply) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, MEMBERSHIP_ADMIN_ROLES, 'Solo owner/admin pueden subir documentos de empresa');

      const buffer = decodeBase64Content(request.body.contentBase64);
      const stored = await storeFile(app.config.storageDir, orgId, buffer);
      const status = computeDocumentStatus(request.body.validUntil ?? null);
      const id = randomUUID();

      const row = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
        const inserted = await tx.query(
          `insert into company_documents (id, org_id, document_type, storage_ref, file_hash, valid_from, valid_until, status)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
          [
            id,
            orgId,
            request.body.documentType,
            stored.relativePath,
            stored.sha256,
            request.body.validFrom ?? null,
            request.body.validUntil ?? null,
            status,
          ]
        );
        await recordFieldProvenance(tx, {
          orgId,
          entity: 'company_documents',
          entityId: id,
          field: '*',
          ownerUserId: userId,
          source: 'manual',
        });
        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: 'company_document.create',
          entity: 'company_documents',
          entityId: id,
          after: { documentType: request.body.documentType, sha256: stored.sha256, status },
          requestId: request.id,
        });
        return inserted.rows[0];
      });

      reply.code(201);
      return mapDocumentRow(row as Record<string, unknown>);
    }
  );

  server.delete(
    '/documents/:id',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, MEMBERSHIP_ADMIN_ROLES, 'Solo owner/admin pueden eliminar documentos de empresa');

      const deleted = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
        const before = await tx.query('select * from company_documents where id = $1 and org_id = $2', [
          request.params.id,
          orgId,
        ]);
        const res = await tx.query('delete from company_documents where id = $1 and org_id = $2', [
          request.params.id,
          orgId,
        ]);
        if (res.rowCount > 0) {
          await recordAudit(tx, {
            orgId,
            actorId: userId,
            action: 'company_document.delete',
            entity: 'company_documents',
            entityId: request.params.id,
            before: before.rows[0] ?? null,
            requestId: request.id,
          });
        }
        return res.rowCount;
      });
      if (deleted === 0) throw new NotFoundError('Documento no encontrado');
      return reply.code(204).send();
    }
  );

  // -------------------------------------------------------------------------
  // approved_rates: writer PROPONE (crea en 'draft'); owner/admin APRUEBA.
  // -------------------------------------------------------------------------
  server.get(
    '/rates',
    { preHandler: [app.authenticate, app.requireOrg], schema: { response: { 200: z.array(rateSchema) } } },
    async (request) => {
      const orgId = request.orgId!;
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query('select * from approved_rates where org_id = $1 order by created_at asc', [orgId]);
      });
      return rows.map((r) => mapRateRow(r as Record<string, unknown>));
    }
  );

  server.post(
    '/rates',
    { preHandler: [app.authenticate, app.requireOrg], schema: { body: rateCreateSchema, response: { 201: rateSchema } } },
    async (request, reply) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      // Propuesta: cualquier rol de escritura (incl. writer), nunca viewer.
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para proponer una tarifa');

      const b = request.body;
      const id = randomUUID();
      let row: Record<string, unknown>;
      try {
        row = await app.db.transaction(async (tx) => {
          await tx.query('set local role app_role');
          await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
          await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
          const inserted = await tx.query(
            `insert into approved_rates (id, org_id, item_code, description, unit, unit_price, currency, status, valid_from, valid_until)
             values ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9) returning *`,
            [
              id,
              orgId,
              b.itemCode,
              b.description,
              b.unit ?? 'unidad',
              b.unitPrice,
              b.currency ?? 'MXN',
              b.validFrom ?? null,
              b.validUntil ?? null,
            ]
          );
          await recordFieldProvenance(tx, {
            orgId,
            entity: 'approved_rates',
            entityId: id,
            field: '*',
            ownerUserId: userId,
            source: 'manual',
          });
          await recordAudit(tx, {
            orgId,
            actorId: userId,
            action: 'approved_rate.propose',
            entity: 'approved_rates',
            entityId: id,
            after: b,
            requestId: request.id,
          });
          return inserted.rows[0];
        });
      } catch (err) {
        const pgErr = err as { code?: string };
        if (pgErr.code === '23505') {
          throw new ConflictError('Ya existe una tarifa con ese item_code en esta organización');
        }
        throw err;
      }

      reply.code(201);
      return mapRateRow(row);
    }
  );

  server.post(
    '/rates/:id/approve',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ id: z.string().uuid() }), response: { 200: rateSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      // Aprobar es MÁS estricto que la DB (decision_roles incluye analyst):
      // la aplicación restringe la acción de aprobar específicamente a
      // owner/admin, tal como pide la ronda 2 ("aprobación por rol admin/owner").
      requireOrgRole(request, MEMBERSHIP_ADMIN_ROLES, 'Solo owner/admin pueden aprobar una tarifa');

      const row = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
        const before = await tx.query('select status from approved_rates where id = $1 and org_id = $2', [
          request.params.id,
          orgId,
        ]);
        const updated = await tx.query(
          `update approved_rates set status = 'approved', approved_by = $1, approved_at = now()
           where id = $2 and org_id = $3 returning *`,
          [userId, request.params.id, orgId]
        );
        if (updated.rows.length === 0) return null;
        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: 'approved_rate.approve',
          entity: 'approved_rates',
          entityId: request.params.id,
          before: before.rows[0] ?? null,
          after: { status: 'approved' },
          requestId: request.id,
        });
        return updated.rows[0];
      });
      if (!row) throw new NotFoundError('Tarifa no encontrada');
      return mapRateRow(row as Record<string, unknown>);
    }
  );

  server.post(
    '/rates/:id/reject',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ id: z.string().uuid() }), response: { 200: rateSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, MEMBERSHIP_ADMIN_ROLES, 'Solo owner/admin pueden rechazar/archivar una tarifa');

      const row = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
        const updated = await tx.query(
          `update approved_rates set status = 'archived' where id = $1 and org_id = $2 returning *`,
          [request.params.id, orgId]
        );
        if (updated.rows.length === 0) return null;
        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: 'approved_rate.reject',
          entity: 'approved_rates',
          entityId: request.params.id,
          after: { status: 'archived' },
          requestId: request.id,
        });
        return updated.rows[0];
      });
      if (!row) throw new NotFoundError('Tarifa no encontrada');
      return mapRateRow(row as Record<string, unknown>);
    }
  );
}

function mapProfileRow(r: Record<string, unknown>): any {
  return {
    id: r.id,
    legalName: r.legal_name,
    tradeName: r.trade_name,
    taxId: r.tax_id,
    description: r.description,
    sector: r.sector,
    foundedYear: r.founded_year,
    employeeCount: r.employee_count,
    annualRevenue: r.annual_revenue !== null ? Number(r.annual_revenue) : null,
    website: r.website,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapDocumentRow(r: Record<string, unknown>): any {
  const validUntil = (r.valid_until as string | null) ?? null;
  return {
    id: r.id,
    documentType: r.document_type,
    storageRef: r.storage_ref,
    fileHash: r.file_hash,
    validFrom: r.valid_from,
    validUntil,
    // Estado recalculado en cada lectura contra "hoy": nunca se confía en un
    // valor guardado que pudo quedar obsoleto (REQ-023/REQ-149: la
    // obsolescencia se muestra, nunca se oculta).
    status: computeDocumentStatus(validUntil),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapRateRow(r: Record<string, unknown>): any {
  return {
    id: r.id,
    itemCode: r.item_code,
    description: r.description,
    unit: r.unit,
    unitPrice: Number(r.unit_price),
    currency: r.currency,
    status: r.status,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
