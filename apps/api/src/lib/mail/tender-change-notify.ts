import type { FastifyInstance } from 'fastify';
import { sendTenderChangeEmail, type MinimalUserWithPhone } from './triggers.js';

/**
 * REQ-155: la invalidación en cascada de dependientes ante un cambio de
 * convocatoria (`app.invalidate_tender_dependents`, disparada por el INSERT
 * en `tender_change_events` -- ver `packages/db/migrations/
 * 0022_fix_db05_change_event_invalidation.sql` y
 * `modules/tenders/internal-ingest.routes.ts`) es real y está cerrada desde
 * E4/DB-05; lo único que faltaba era notificar explícitamente a los roles
 * responsables del cambio. Este módulo cierra esa brecha.
 *
 * "Responsable" de una convocatoria: el esquema (`packages/db`) no tiene un
 * dueño por convocatoria -- `tenders` es per-organización
 * (`unique(org_id, source, external_id)`, migración 0005), no per-usuario.
 * Por eso "los miembros de la organización que tienen esa convocatoria en
 * su expediente" se traduce, con el modelo de datos actual, en: TODOS los
 * miembros ACTIVOS (`memberships.status = 'active'`) de la organización
 * dueña de esa convocatoria, con cuenta activa (`users.is_active`) -- no
 * hay una asignación más fina (p. ej. "responsable de esta convocatoria en
 * particular") que filtrar. Si en el futuro se agrega esa asignación
 * granular, este es el único lugar que habría que tocar para adoptarla.
 */

const CHANGE_TYPE_BY_KIND: Record<string, 'version' | 'plazo' | 'otro'> = {
  deadline_change: 'plazo',
  amendment: 'version',
  annex: 'otro',
  clarification: 'otro',
  cancellation: 'otro',
  publication: 'otro',
};

const CHANGE_SUMMARY_BY_KIND: Record<string, string> = {
  deadline_change: 'La convocante modificó el plazo de presentación de propuestas.',
  amendment: 'La convocante publicó una nueva versión de las bases.',
  annex: 'La convocante agregó un anexo a las bases.',
  clarification: 'La convocante publicó una aclaración a las bases.',
  cancellation: 'La convocante canceló la convocatoria.',
  publication: 'La convocatoria tuvo una actualización.',
};

const DEFAULT_CHANGE_SUMMARY = CHANGE_SUMMARY_BY_KIND.publication;

export interface TenderChangeNotificationInput {
  organizationId: string;
  tenderId: string;
  /** `tender_versions.id` de ESTE cambio -- ver el comentario de `sendTenderChangeEmail` sobre `messageKey`. */
  versionId: string;
  tenderTitle: string;
  /** Uno de `CHANGE_KINDS` (`modules/tenders/schemas.ts`); cualquier valor no mapeado cae en "otro" (`DEFAULT_CHANGE_SUMMARY`), nunca se descarta el aviso por un `changeKind` inesperado. */
  changeKind: string;
  previousDeadlineIso?: string | null;
  newDeadlineIso?: string | null;
}

interface OrgMemberRow {
  id: string;
  email: string;
  full_name: string | null;
  whatsapp_phone_e164: string | null;
}

/**
 * Notifica (correo + WhatsApp) a los miembros responsables de la
 * organización tras un cambio real de convocatoria.
 *
 * REGLA DURA (misma que documenta `internal-ingest.routes.ts` en el punto
 * donde se llama a esta función): SIEMPRE se invoca DESPUÉS de que la
 * transacción de invalidación ya hizo commit, envuelta en
 * `fireAndForgetMail` -- así que un fallo aquí (lectura de miembros, correo,
 * WhatsApp) nunca puede revertir ni bloquear la invalidación real, que ya es
 * un hecho consumado, ni la respuesta HTTP de `/internal/tenders/ingest`.
 * Cada miembro se notifica en su propio `try/catch`: el fallo de uno (p. ej.
 * un correo inválido) no debe impedir que los demás sí reciban su aviso.
 */
export async function notifyTenderChangeToResponsibles(app: FastifyInstance, input: TenderChangeNotificationInput): Promise<void> {
  const { rows: members } = await app.db.query<OrgMemberRow>(
    `select u.id, u.email, u.full_name, u.whatsapp_phone_e164
     from memberships m
     join users u on u.id = m.user_id
     where m.org_id = $1 and m.status = 'active' and u.is_active = true`,
    [input.organizationId]
  );
  if (members.length === 0) return;

  const tenderUrl = new URL(`/convocatorias/descubrimiento/${input.tenderId}`, app.config.publicUrl).toString();
  const changeType = CHANGE_TYPE_BY_KIND[input.changeKind] ?? 'otro';
  const changeSummary = CHANGE_SUMMARY_BY_KIND[input.changeKind] ?? DEFAULT_CHANGE_SUMMARY;

  for (const member of members) {
    const user: MinimalUserWithPhone = {
      id: member.id,
      email: member.email,
      fullName: member.full_name,
      whatsappPhone: member.whatsapp_phone_e164,
    };
    try {
      const outcome = await sendTenderChangeEmail(app, user, {
        organizationId: input.organizationId,
        tenderId: input.tenderId,
        versionId: input.versionId,
        tenderTitle: input.tenderTitle,
        changeType,
        changeSummary,
        ...(input.previousDeadlineIso ? { previousDeadlineIso: input.previousDeadlineIso } : {}),
        ...(input.newDeadlineIso ? { newDeadlineIso: input.newDeadlineIso } : {}),
        tenderUrl,
      });
      // `sendTransactionalMail`/`MailService.send()` NUNCA lanza por un
      // resultado de negocio (variables inválidas, destinatario no
      // registrado, proveedor sin configurar, etc.) -- devuelve un
      // `SendOutcome` declarado, no una excepción (ver `mail-service.ts`).
      // `skipped_preferences`/`skipped_suppressed`/`already_sent`/`sent` son
      // resultados normales que no ameritan registro; cualquier otro
      // (`invalid_variables`, `unregistered_recipient`, `not_configured`,
      // `failed_permanent`, `dead`) sí se deja en el log -- si no, un aviso
      // que nunca sale por un bug de este módulo (p. ej. una fecha con
      // forma equivocada) sería indistinguible de uno que sí salió.
      if (outcome.status !== 'sent' && outcome.status !== 'skipped_preferences' && outcome.status !== 'skipped_suppressed' && outcome.status !== 'already_sent') {
        app.log.warn(
          { status: outcome.status, userId: member.id, organizationId: input.organizationId, tenderId: input.tenderId },
          'El aviso de cambio de convocatoria no se mandó (best-effort; la invalidación ya se aplicó y no se ve afectada)'
        );
      }
    } catch (error) {
      app.log.error(
        {
          err: error instanceof Error ? error.message : String(error),
          userId: member.id,
          organizationId: input.organizationId,
          tenderId: input.tenderId,
        },
        'No se pudo notificar el cambio de convocatoria a este miembro (best-effort; la invalidación ya se aplicó y no se ve afectada, y no impide notificar al resto)'
      );
    }
  }
}
