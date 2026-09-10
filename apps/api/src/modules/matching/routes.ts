import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { DbExecutor } from '@atiende/db';
import { NotFoundError } from '../../lib/errors.js';
import {
  toTenderRecord,
  toOrganizationProfile,
  evaluateHardEligibility,
  computeMatch,
  type FullMatchResult,
  type TenderRowForMatching,
} from './engine.js';
import { matchResultSchema, matchListResponseSchema } from './schemas.js';

/**
 * Construye el perfil de matching real (E5) a partir del perfil de empresa
 * ya capturado por E2 (capabilities/products_services/locations), dentro de
 * la MISMA transacción de tenant ya abierta por el llamador.
 *
 * Exportada (además de usarse en las dos rutas de este archivo) para que
 * `lib/mail/new-tender-match-notify.ts` calcule el MISMO matching real al
 * conectar la plantilla `new-tender-match` a la ingesta de convocatorias
 * (REQ-181) -- nunca un cómputo paralelo que pudiera divergir del que ve el
 * usuario en `GET /tenders`/`GET /tenders/:tenderId`.
 */
export async function buildProfileAndEligibility(
  tx: DbExecutor,
  orgId: string
): Promise<{
  profileInput: { keywords: string[]; states: string[] };
  hardEligibility: ReturnType<typeof evaluateHardEligibility>;
  missingProfileFields: string[];
}> {
  const missingProfileFields: string[] = [];

  const [capsRes, prodsRes, locsRes, docsRes, restrictionsRes, registrationsRes, provenanceRes] = await Promise.all([
    tx.query<{ name: string }>('select name from capabilities where org_id = $1', [orgId]),
    tx.query<{ name: string }>('select name from products_services where org_id = $1', [orgId]),
    tx.query<{ state: string | null }>('select state from locations where org_id = $1', [orgId]),
    tx.query<{ id: string; document_type: string; valid_until: string | null }>(
      'select id, document_type, valid_until from company_documents where org_id = $1',
      [orgId]
    ),
    tx.query<{ id: string; kind: string; valid_until: string | null }>(
      'select id, kind, valid_until from restrictions where org_id = $1',
      [orgId]
    ),
    tx.query<{ id: string }>('select id from registrations where org_id = $1 limit 1', [orgId]),
    // REQ-142: procedencia vinculante -- se carga de una sola vez para
    // decidir qué documentos/restricciones son UTILIZABLES en la
    // elegibilidad dura (ver `evaluateHardEligibility`/`fieldsWithoutProvenance`).
    tx.query<{ entity: string; entity_id: string }>(
      "select distinct entity, entity_id from field_provenance where org_id = $1 and entity in ('company_documents', 'restrictions')",
      [orgId]
    ),
  ]);

  const provenanceKeys = new Set(provenanceRes.rows.map((r) => `${r.entity}:${r.entity_id}`));
  const fieldsWithoutProvenance: string[] = [
    ...docsRes.rows.filter((d) => !provenanceKeys.has(`company_documents:${d.id}`)).map((d) => `documento:${d.document_type}`),
    ...restrictionsRes.rows.filter((r) => !provenanceKeys.has(`restrictions:${r.id}`)).map((r) => `restriccion:${r.kind}`),
  ];

  const keywords = [...capsRes.rows.map((r) => r.name), ...prodsRes.rows.map((r) => r.name)].filter(Boolean);
  const states = locsRes.rows.map((r) => r.state).filter((s): s is string => Boolean(s));

  if (keywords.length === 0) missingProfileFields.push('capabilities_or_products');
  if (states.length === 0) missingProfileFields.push('locations');

  const now = new Date();
  const expiredDocumentTypes = docsRes.rows
    .filter((d) => d.valid_until !== null && new Date(d.valid_until) < now)
    .map((d) => d.document_type);
  const hasPendingVerificationDocuments = docsRes.rows.some((d) => d.valid_until === null);

  const activeRestrictions = restrictionsRes.rows.filter((r) => r.valid_until === null || new Date(r.valid_until) >= now);

  const hardEligibility = evaluateHardEligibility({
    hasExpiredDocuments: expiredDocumentTypes.length > 0,
    expiredDocumentTypes,
    hasPendingVerificationDocuments,
    hasActiveRestrictions: activeRestrictions.length > 0,
    restrictionKinds: activeRestrictions.map((r) => r.kind),
    hasAnyRegistration: registrationsRes.rows.length > 0,
    fieldsWithoutProvenance,
  });

  return { profileInput: { keywords, states }, hardEligibility, missingProfileFields };
}

/** Exportada por el mismo motivo que `buildProfileAndEligibility` arriba: `new-tender-match-notify.ts` persiste el match calculado en la ingesta con la MISMA función (nunca un INSERT paralelo). */
export async function persistMatch(tx: DbExecutor, orgId: string, tenderId: string, result: FullMatchResult): Promise<void> {
  await tx.query(
    `insert into tender_matches (org_id, tender_id, score, criteria, explanation)
     values ($1, $2, $3, $4::jsonb, $5)
     on conflict do nothing`,
    [
      orgId,
      tenderId,
      result.relevance.score,
      JSON.stringify({ relevance: result.relevance.criteria, eligibility: result.eligibility }),
      `Relevancia ${result.relevance.score}/100; elegibilidad: ${result.eligibility.status}.`,
    ]
  );
  // No hay UNIQUE(org_id, tender_id) en el esquema (permite historial de
  // recálculos); por eso no se puede usar ON CONFLICT ... DO UPDATE aquí.
  // Se actualiza explícitamente la fila más reciente si ya existía una
  // para este (org, tender) en la misma corrida de matching, para no
  // acumular duplicados en el uso normal de "recalcular".
  await tx.query(
    `delete from tender_matches
     where org_id = $1 and tender_id = $2
       and id not in (
         select id from tender_matches where org_id = $1 and tender_id = $2 order by created_at desc limit 1
       )`,
    [orgId, tenderId]
  );
}

export async function matchingRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/tenders/:tenderId',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: matchResultSchema } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const result = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);

        const tenderRes = await tx.query<TenderRowForMatching & { id: string }>(
          'select id, source, external_id, title, contracting_body, cpv_codes, budget_amount, currency from tenders where id = $1 and org_id = $2',
          [request.params.tenderId, orgId]
        );
        if (tenderRes.rows.length === 0) return null;

        const { profileInput, hardEligibility, missingProfileFields } = await buildProfileAndEligibility(tx, orgId);
        const record = toTenderRecord(tenderRes.rows[0]);
        const profile = toOrganizationProfile(profileInput);
        const matched = computeMatch(record, profile, hardEligibility, missingProfileFields);

        await persistMatch(tx, orgId, request.params.tenderId, matched);

        return { tenderId: request.params.tenderId, ...matched };
      });

      if (!result) throw new NotFoundError('Convocatoria no encontrada');
      return result;
    }
  );

  server.get(
    '/tenders',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { response: { 200: matchListResponseSchema } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const items = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);

        const tendersRes = await tx.query<TenderRowForMatching & { id: string }>(
          'select id, source, external_id, title, contracting_body, cpv_codes, budget_amount, currency from tenders where org_id = $1 order by created_at asc limit 50',
          [orgId]
        );
        const { profileInput, hardEligibility, missingProfileFields } = await buildProfileAndEligibility(tx, orgId);
        const profile = toOrganizationProfile(profileInput);

        const results = [];
        for (const row of tendersRes.rows) {
          const record = toTenderRecord(row);
          const matched = computeMatch(record, profile, hardEligibility, missingProfileFields);
          await persistMatch(tx, orgId, row.id, matched);
          results.push({ tenderId: row.id, ...matched });
        }
        return results;
      });
      return { items };
    }
  );
}
