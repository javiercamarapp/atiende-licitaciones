import type { FastifyInstance } from 'fastify';
import type { DbExecutor } from '@atiende/db';
import { toTenderRecord, toOrganizationProfile, computeMatch, type TenderRowForMatching } from '../../modules/matching/engine.js';
import { buildProfileAndEligibility, persistMatch, fetchAttachmentTexts } from '../../modules/matching/routes.js';
import { computeSemanticRelevance, buildProfileEmbeddingText, buildTenderEmbeddingText } from '../../modules/matching/semantic.js';
import { sendNewTenderMatchEmail, type MinimalUserWithPhone } from './triggers.js';
import { timestampToIso } from '../expediente/dates.js';

/**
 * REQ-181 (plantilla `new-tender-match`, categoría `tender_matches`): hasta
 * esta ronda, `sendNewTenderMatchEmail` (triggers.ts) existía lista pero sin
 * caller real -- el motor de matching (`modules/matching/engine.ts`) solo se
 * ejercía bajo demanda desde `GET /tenders`/`GET /tenders/:tenderId`
 * (páginas de la app, recalculadas en cada visita: NO es un evento de
 * negocio, sería mandar un correo cada vez que alguien abre la pantalla de
 * matching). El evento real y único de "una convocatoria nueva le llegó a
 * la organización" es la INGESTA (`POST /internal/tenders/ingest`, acción
 * `"created"` -- primera vez que esa organización ve esta convocatoria,
 * `internal-ingest.routes.ts`): esta función corre el MISMO motor de
 * matching ahí, justo una vez por convocatoria nueva por organización, y
 * solo manda el aviso si el resultado es un match real que vale la pena
 * (ver `MATCH_SCORE_THRESHOLD` abajo) -- nunca uno por cada convocatoria
 * ingerida sin importar qué tan irrelevante sea para el perfil de la
 * organización.
 *
 * `tender-match-digest` (el digesto de varios matches en un solo correo,
 * ver el comentario de `triggers.ts` junto a `sendTenderMatchDigestEmail`)
 * queda FUERA de esta conexión a propósito: el propio catálogo documenta
 * que el motor "decide cuál de las dos mandar según la ventana de
 * agregación configurada", pero ninguna ventana de agregación existe en el
 * esquema (`packages/db/migrations`) ni en `notification_preferences` --
 * inventar una política de agregación solo para tener algo que disparar
 * sería fabricar un evento de negocio que no existe, lo que esta ronda pide
 * explícitamente evitar. Documentado también en el reporte de esta tarea.
 */

/** Umbral de relevancia (misma escala 0-100 de `MatchingEngine.score`, ver `packages/sources/src/matching/matching-engine.ts`) a partir del cual un match se considera lo bastante bueno para justificar un correo -- por debajo de esto, `tender_matches` seguiría llenándose de convocatorias marginales para el perfil de la organización. Elegido como punto medio-alto deliberadamente conservador (más falsos negativos que falsos positivos: un aviso de más entrena a la organización a ignorar la categoría). */
const MATCH_SCORE_THRESHOLD = 60;

export interface NewTenderMatchNotificationInput {
  organizationId: string;
  tenderId: string;
}

interface OrgMemberRow {
  id: string;
  email: string;
  full_name: string | null;
  whatsapp_phone_e164: string | null;
}

function formatEstimatedValue(amount: string | number | null, currency: string): string {
  if (amount === null || amount === undefined) return 'Monto no especificado en la convocatoria';
  const numeric = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(numeric)) return 'Monto no especificado en la convocatoria';
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: currency || 'MXN', maximumFractionDigits: 2 }).format(numeric);
  } catch {
    // `currency` viene de `tenders.currency` (texto libre en el esquema de
    // ingesta, ver TODO de unificación en engine.ts) -- un código ISO-4217
    // inválido no debe tumbar el aviso completo, solo perder el símbolo.
    return `${numeric.toFixed(2)} ${currency || 'MXN'}`;
  }
}

/**
 * Corre el matching real de UNA convocatoria recién ingerida contra el
 * perfil de UNA organización, persiste el resultado (misma `persistMatch`
 * que usan las rutas de usuario) y, si el match es lo bastante relevante,
 * notifica a los miembros responsables. Se llama SIEMPRE en segundo plano
 * (`fireAndForgetMail`, ver `internal-ingest.routes.ts`) después de que el
 * INSERT de la convocatoria ya hizo commit -- un fallo aquí nunca revierte
 * ni bloquea la ingesta.
 */
export async function notifyNewTenderMatchToResponsibles(app: FastifyInstance, input: NewTenderMatchNotificationInput): Promise<void> {
  const { organizationId: orgId, tenderId } = input;

  const matched = await app.db.transaction(async (tx: DbExecutor) => {
    const tenderRes = await tx.query<TenderRowForMatching & { id: string; submission_deadline: string | Date | null; url: string | null }>(
      'select id, source, external_id, title, contracting_body, cpv_codes, budget_amount, currency, submission_deadline, url from tenders where id = $1 and org_id = $2',
      [tenderId, orgId]
    );
    const row = tenderRes.rows[0];
    if (!row) return null; // no debería ocurrir (se llama justo tras crearla), pero nunca se asume.

    const { profileInput, hardEligibility, missingProfileFields } = await buildProfileAndEligibility(tx, orgId);
    const record = toTenderRecord(row);
    const profile = toOrganizationProfile(profileInput);

    const attachmentTexts = await fetchAttachmentTexts(tx, orgId, tenderId);
    const semantic = await computeSemanticRelevance(
      tx,
      orgId,
      tenderId,
      buildProfileEmbeddingText(profileInput.keywords),
      buildTenderEmbeddingText({
        title: row.title,
        contractingBody: row.contracting_body,
        cpvCodes: row.cpv_codes,
        attachmentTexts,
      })
    );
    const result = computeMatch(record, profile, hardEligibility, missingProfileFields, semantic);

    await persistMatch(tx, orgId, tenderId, result);

    return { row, result };
  });

  if (!matched) return;
  const { row, result } = matched;

  if (result.relevance.score < MATCH_SCORE_THRESHOLD || result.eligibility.status === 'no_cumple') {
    return; // Persistido para consulta en `GET /tenders`, pero no lo bastante relevante para un correo.
  }

  const submissionDeadlineIso = timestampToIso(row.submission_deadline);
  if (!submissionDeadlineIso) {
    app.log.warn(
      { organizationId: orgId, tenderId },
      'Match nuevo relevante, pero la convocatoria no tiene fecha de cierre capturada: se omite el aviso (la plantilla exige una fecha real).'
    );
    return;
  }

  const { rows: members } = await app.db.query<OrgMemberRow>(
    `select u.id, u.email, u.full_name, u.whatsapp_phone_e164
     from memberships m
     join users u on u.id = m.user_id
     where m.org_id = $1 and m.status = 'active' and u.is_active = true`,
    [orgId]
  );
  if (members.length === 0) return;

  const tenderUrl = new URL(`/convocatorias/descubrimiento/${tenderId}`, app.config.publicUrl).toString();
  const contractingEntity = row.contracting_body ?? 'Entidad no especificada';
  const estimatedValue = formatEstimatedValue(row.budget_amount, row.currency);
  const matchScore = Math.round(result.relevance.score);

  for (const member of members) {
    const user: MinimalUserWithPhone = {
      id: member.id,
      email: member.email,
      fullName: member.full_name,
      whatsappPhone: member.whatsapp_phone_e164,
    };
    try {
      const outcome = await sendNewTenderMatchEmail(app, user, {
        organizationId: orgId,
        tenderId,
        tenderTitle: row.title,
        contractingEntity,
        matchScore,
        estimatedValue,
        submissionDeadlineIso,
        tenderUrl,
      });
      if (outcome.status !== 'sent' && outcome.status !== 'skipped_preferences' && outcome.status !== 'skipped_suppressed' && outcome.status !== 'already_sent') {
        app.log.warn(
          { status: outcome.status, userId: member.id, organizationId: orgId, tenderId },
          'El aviso de nuevo match no se mandó (best-effort; la ingesta ya se aplicó y no se ve afectada)'
        );
      }
    } catch (error) {
      app.log.error(
        { err: error instanceof Error ? error.message : String(error), userId: member.id, organizationId: orgId, tenderId },
        'No se pudo notificar el nuevo match a este miembro (best-effort, no impide notificar al resto)'
      );
    }
  }
}
