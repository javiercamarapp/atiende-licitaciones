import type { DbClient } from '@atiende/db';
import { WRITE_ROLES } from '@atiende/db';
import { MailService } from '@atiende/mail';
import type { JobHandler } from '../queue/types.js';
import { buildMailServiceForWorker } from '../mail/build-mail-service.js';

export interface SendExpedienteNotificationPayload {
  organizationId: string;
  tenderId: string;
}

export interface SendExpedienteNotificationHandlerDeps {
  db: DbClient;
  /** Inyectable para pruebas; por defecto `buildMailServiceForWorker({db})` (mismo patrón que `send-agent-alert.ts`). */
  mailService?: MailService;
  /** Base pública de `apps/web` para el CTA del correo. */
  publicUrl?: string;
  supportEmail?: string;
}

const DEFAULT_PUBLIC_URL = 'https://app.atiende.mx';
const DEFAULT_SUPPORT_EMAIL = 'soporte@atiende.mx';

interface TenderRow {
  id: string;
  title: string;
}

interface OrgMemberRow {
  id: string;
  email: string;
  full_name: string | null;
}

function displayName(user: { email: string; full_name: string | null }): string {
  return user.full_name?.trim() || user.email.split('@')[0];
}

/**
 * Handler del job `send_expediente_notification`, encolado por la
 * herramienta `notificar_expediente_listo` (nodo "Mensajero" del grafo de
 * orquestación, REQ-070: Radar→Analista→Redactor→Auditor→Mensajero). Igual
 * que `send-agent-alert.ts` (`programar_alerta` → `send_agent_alert`), la
 * herramienta de negocio SOLO encola este job (`actionKind: 'write'`,
 * `AuthorizationPolicy` prohíbe de forma dura cualquier tool con
 * `actionKind: 'external_send'`, ver packages/agents/src/authorization.ts)
 * -- es este handler, un JOB fuera del `AgentRunner`, el que manda el
 * correo real, a los miembros de la organización con rol de escritura (los
 * mismos roles que pueden aprobar/editar el expediente, `WRITE_ROLES`,
 * `@atiende/db`), usando la plantilla `pending-approval`
 * (`packages/mail/src/templates/catalog/pending-approval.tsx`) -- una
 * plantilla ya registrada en `packages/mail` desde REQ-181 pero que ningún
 * flujo real disparaba todavía (huérfana).
 *
 * Best-effort por miembro (mismo criterio que `send-agent-alert.ts`): un
 * fallo mandando el correo a UN miembro nunca lanza ni impide notificar al
 * resto. Si la convocatoria no existe (org_id no coincide, o fue borrada)
 * el job no falla -- no hay nada real que notificar, y reintentar no lo
 * arreglaría (WK-10).
 */
export function createSendExpedienteNotificationHandler(
  deps: SendExpedienteNotificationHandlerDeps,
): JobHandler<SendExpedienteNotificationPayload> {
  const mailService = deps.mailService ?? buildMailServiceForWorker({ db: deps.db }).mail;
  const publicUrl = deps.publicUrl ?? DEFAULT_PUBLIC_URL;
  const supportEmail = deps.supportEmail ?? DEFAULT_SUPPORT_EMAIL;

  return async (job, ctx) => {
    const { organizationId, tenderId } = job.payload;

    const tenderRes = await deps.db.query<TenderRow>('select id, title from tenders where id = $1 and org_id = $2', [
      tenderId,
      organizationId,
    ]);
    const tender = tenderRes.rows[0];
    if (!tender) {
      ctx.logger.warn(
        { organization_id: organizationId, tender_id: tenderId },
        'send_expediente_notification: convocatoria no encontrada, se omite el correo',
      );
      return;
    }

    const membersRes = await deps.db.query<OrgMemberRow>(
      `select u.id, u.email, u.full_name
       from memberships m
       join users u on u.id = m.user_id
       where m.org_id = $1 and m.status = 'active' and u.is_active = true and m.role::text = any($2::text[])`,
      [organizationId, WRITE_ROLES],
    );
    if (membersRes.rows.length === 0) {
      ctx.logger.warn(
        { organization_id: organizationId, tender_id: tenderId },
        'send_expediente_notification: la organización no tiene miembros activos con rol de escritura, se omite el correo',
      );
      return;
    }

    const approvalUrl = new URL('/preparacion/aprobaciones', publicUrl).toString();
    const preferencesUrl = new URL('/preferencias', publicUrl).toString();

    for (const member of membersRes.rows) {
      try {
        const outcome = await mailService.send({
          to: { email: member.email, userId: member.id, organizationId, status: 'active' },
          templateId: 'pending-approval',
          messageKey: `pending-approval:expediente:${member.id}:${tenderId}`,
          variables: {
            recipientName: displayName(member),
            appUrl: publicUrl,
            supportEmail,
            preferencesUrl,
            approvalType: 'expediente',
            contextLabel: tender.title,
            subjectLabel: 'Revisar y aprobar el expediente antes de continuar',
            requestedBy: 'Auditor automático (orquestador de agentes, REQ-070)',
            requestSummary:
              `El expediente de la convocatoria "${tender.title}" pasó los checks automáticos del auditor ` +
              '(matriz de requisitos con sección redactada y fuente citada para cada requisito obligatorio) ' +
              'y está listo para tu revisión antes de continuar.',
            approvalUrl,
          },
        });

        if (outcome.status !== 'sent' && outcome.status !== 'skipped_preferences' && outcome.status !== 'skipped_suppressed' && outcome.status !== 'already_sent') {
          ctx.logger.warn(
            { status: outcome.status, user_id: member.id, organization_id: organizationId, tender_id: tenderId },
            'send_expediente_notification: el correo no se mandó (best-effort)',
          );
        }
      } catch (error) {
        ctx.logger.error(
          { err: error instanceof Error ? error.message : String(error), user_id: member.id, organization_id: organizationId, tender_id: tenderId },
          'send_expediente_notification: no se pudo notificar a este miembro (best-effort, no impide notificar al resto)',
        );
      }
    }
  };
}
