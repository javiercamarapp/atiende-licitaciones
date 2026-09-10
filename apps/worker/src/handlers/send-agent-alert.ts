import type { DbClient } from '@atiende/db';
import { MailService, type NotificationPreferences } from '@atiende/mail';
import type { JobHandler } from '../queue/types.js';
import { buildMailServiceForWorker } from '../mail/build-mail-service.js';

export interface SendAgentAlertPayload {
  organizationId: string;
  tenderId: string;
  kind: 'vencimiento' | 'cambio_bases' | 'otro';
  message: string;
}

export interface SendAgentAlertHandlerDeps {
  db: DbClient;
  /** Inyectable para pruebas; por defecto `buildMailServiceForWorker({db})` (mismo patrón que `mail-retry.ts`). */
  mailService?: MailService;
  /** Base pública de `apps/web` para el CTA del correo (`app.config.publicUrl` en `apps/api`, ver `config.ts`). */
  publicUrl?: string;
  supportEmail?: string;
}

const DEFAULT_PUBLIC_URL = 'https://app.atiende.mx';
const DEFAULT_SUPPORT_EMAIL = 'soporte@atiende.mx';

interface TenderRow {
  id: string;
  title: string;
  submission_deadline: string | Date | null;
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
 * Handler del job `send_agent_alert`, encolado por la herramienta
 * `programar_alerta` (`src/agents/business-tools.ts`, Ronda 6). Sigue
 * registrando la alerta en el log estructurado (para seguimiento humano,
 * sin cambios respecto de antes de esta ronda) y, para `kind ===
 * 'vencimiento'` (la única categoría de `programar_alerta` con una
 * plantilla de correo real asociada, `deadline-reminder` -- REQ-181),
 * ADEMÁS manda el correo real a los miembros activos de la organización.
 * `programar_alerta` en sí SIGUE sin enviar nada a un tercero (su docstring
 * no cambia): es este handler -- el JOB que la tool encola, no la tool
 * misma -- el que ahora sí lo hace, tal como pide la tarea.
 *
 * `kind === 'cambio_bases' | 'otro'` no tiene plantilla de correo definida
 * en este catálogo (un cambio de bases real ya se notifica por un camino
 * completamente distinto, ver `lib/mail/tender-change-notify.ts` en
 * `apps/api`, disparado desde la ingesta -- no desde este agente): esos dos
 * `kind`s conservan el comportamiento anterior de solo log, documentado
 * explícitamente en vez de fabricar una plantilla que no existe.
 *
 * Best-effort por diseño (mismo criterio que `notifyTenderChangeToResponsibles`
 * en `apps/api`): un fallo mandando el correo a un miembro nunca lanza (se
 * deja en el log) ni impide notificar al resto, y nunca hace fallar el job
 * -- el log de la alerta (arriba) ya es el rastro mínimo garantizado
 * incluso si el correo no se pudo mandar a nadie.
 */
export function createSendAgentAlertHandler(deps: SendAgentAlertHandlerDeps): JobHandler<SendAgentAlertPayload> {
  const mailService = deps.mailService ?? buildMailServiceForWorker({ db: deps.db }).mail;
  const publicUrl = deps.publicUrl ?? DEFAULT_PUBLIC_URL;
  const supportEmail = deps.supportEmail ?? DEFAULT_SUPPORT_EMAIL;

  return async (job, ctx) => {
    ctx.logger.warn(
      {
        organization_id: job.payload.organizationId,
        tender_id: job.payload.tenderId,
        alert_kind: job.payload.kind,
      },
      `ALERTA DE AGENTE: ${job.payload.message}`,
    );

    if (job.payload.kind !== 'vencimiento') return;

    const { organizationId, tenderId } = job.payload;

    const tenderRes = await deps.db.query<TenderRow>(
      'select id, title, submission_deadline from tenders where id = $1 and org_id = $2',
      [tenderId, organizationId],
    );
    const tender = tenderRes.rows[0];
    if (!tender) {
      ctx.logger.warn({ organization_id: organizationId, tender_id: tenderId }, 'deadline-reminder: convocatoria no encontrada, se omite el correo (solo queda el log de alerta de arriba)');
      return;
    }
    if (!tender.submission_deadline) {
      ctx.logger.warn({ organization_id: organizationId, tender_id: tenderId }, 'deadline-reminder: la convocatoria no tiene fecha de cierre capturada, se omite el correo');
      return;
    }

    const deadlineMs = new Date(tender.submission_deadline).getTime();
    const hoursRemainingRaw = (deadlineMs - Date.now()) / (60 * 60 * 1000);
    if (!Number.isFinite(hoursRemainingRaw) || hoursRemainingRaw <= 0) {
      ctx.logger.warn(
        { organization_id: organizationId, tender_id: tenderId, hours_remaining_raw: hoursRemainingRaw },
        'deadline-reminder: el plazo ya venció (o la fecha es inválida) para cuando corrió esta alerta, se omite el correo',
      );
      return;
    }
    const hoursRemaining = Math.max(1, Math.round(hoursRemainingRaw));

    const membersRes = await deps.db.query<OrgMemberRow>(
      `select u.id, u.email, u.full_name
       from memberships m
       join users u on u.id = m.user_id
       where m.org_id = $1 and m.status = 'active' and u.is_active = true`,
      [organizationId],
    );
    if (membersRes.rows.length === 0) return;

    const actionUrl = new URL(`/convocatorias/descubrimiento/${tenderId}`, publicUrl).toString();
    const preferencesUrl = new URL('/preferencias', publicUrl).toString();

    for (const member of membersRes.rows) {
      try {
        // `unsubscribeUrl` (BaseVariablesSchema) es OPCIONAL: se omite a
        // propósito -- el `MailService` de `apps/worker` se construye
        // deliberadamente SIN `linkSigner` (ver docstring de
        // `build-mail-service.ts`: nunca firma un enlace nuevo, solo
        // reenvía variables ya firmadas por `apps/api`), así que este
        // correo no puede ofrecer baja de un clic firmada. `preferencesUrl`
        // (sin firmar, la misma pantalla genérica que usa `apps/api`) sí se
        // incluye.
        const prefRes = await deps.db.query<{ deadlines: boolean }>(
          'select deadlines from notification_preferences where user_id = $1',
          [member.id],
        );
        const preferences: NotificationPreferences | undefined = prefRes.rows[0] ? { deadlines: prefRes.rows[0].deadlines } : undefined;

        const outcome = await mailService.send({
          to: { email: member.email, userId: member.id, organizationId, status: 'active' },
          templateId: 'deadline-reminder',
          messageKey: `deadline-reminder:${member.id}:${tenderId}`,
          preferences,
          variables: {
            recipientName: displayName(member),
            appUrl: publicUrl,
            supportEmail,
            preferencesUrl,
            tenderTitle: tender.title,
            submissionDeadlineIso: new Date(tender.submission_deadline).toISOString(),
            hoursRemaining,
            actionUrl,
          },
        });

        if (outcome.status !== 'sent' && outcome.status !== 'skipped_preferences' && outcome.status !== 'skipped_suppressed' && outcome.status !== 'already_sent') {
          ctx.logger.warn(
            { status: outcome.status, user_id: member.id, organization_id: organizationId, tender_id: tenderId },
            'deadline-reminder: el correo no se mandó (best-effort; la alerta ya quedó registrada en el log de arriba)',
          );
        }
      } catch (error) {
        ctx.logger.error(
          { err: error instanceof Error ? error.message : String(error), user_id: member.id, organization_id: organizationId, tender_id: tenderId },
          'deadline-reminder: no se pudo notificar a este miembro (best-effort, no impide notificar al resto)',
        );
      }
    }
  };
}
