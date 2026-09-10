import type { FastifyInstance } from 'fastify';
import type { PackageManifest } from '@atiende/expediente';
import { sendSubmissionPackageReadyEmail, type MinimalUserWithPhone } from './triggers.js';

/**
 * REQ-181 (plantilla `submission-package-ready`): notifica a los miembros
 * responsables de la organización cuando `POST /tenders/:tenderId/package/
 * assemble` (`modules/expediente/package.routes.ts`) produce un manifiesto
 * cuyo `status` es REALMENTE `"ready"` -- nunca `"draft"` (ese estado lo
 * decide siempre `PackageAssembler.assemble`, nunca esta ruta, ver A13/A14
 * en el docstring del módulo). Llamar a esta función con un manifiesto
 * `"draft"` sería un error de programación del llamador, así que se afirma
 * explícitamente en vez de filtrar en silencio.
 *
 * "Responsable" de una convocatoria: mismo criterio ya documentado en
 * `tender-change-notify.ts` (REQ-155) -- el esquema no tiene un dueño por
 * convocatoria, así que "responsable" se traduce en TODOS los miembros
 * ACTIVOS de la organización dueña de esa convocatoria, con cuenta activa.
 * Reutiliza la MISMA consulta ahí documentada (deliberadamente no
 * exportada desde ese archivo para no acoplar dos flujos de negocio
 * distintos a una única función compartida que cambiaría por razones de
 * cualquiera de los dos).
 */
export interface SubmissionPackageReadyNotificationInput {
  organizationId: string;
  tenderId: string;
  tenderTitle: string;
  submissionDeadlineIso: string | null;
  manifest: PackageManifest;
}

interface OrgMemberRow {
  id: string;
  email: string;
  full_name: string | null;
  whatsapp_phone_e164: string | null;
}

export async function notifySubmissionPackageReadyToResponsibles(
  app: FastifyInstance,
  input: SubmissionPackageReadyNotificationInput
): Promise<void> {
  if (input.manifest.status !== 'ready') {
    throw new Error(
      `notifySubmissionPackageReadyToResponsibles: se llamó con un manifiesto "${input.manifest.status}" -- solo debe invocarse cuando PackageAssembler decidió "ready" (ver docstring).`
    );
  }
  // Sin fecha de cierre capturada (`tenders.submission_deadline` puede ser
  // NULL, p. ej. una convocatoria ingresada sin ese dato todavía): la
  // plantilla exige `submissionDeadlineIso` no vacío (ver
  // `SubmissionPackageReadyVariablesSchema`), así que sin un valor real no
  // hay un aviso HONESTO que mandar -- se omite (nunca se inventa una
  // fecha), igual que `sendTenderChangeEmail` omite campos opcionales
  // ausentes en vez de fabricarlos.
  if (!input.submissionDeadlineIso) {
    app.log.warn(
      { organizationId: input.organizationId, tenderId: input.tenderId },
      'Paquete listo para presentar, pero la convocatoria no tiene fecha de cierre capturada: se omite el aviso (la plantilla exige una fecha real).'
    );
    return;
  }

  const { rows: members } = await app.db.query<OrgMemberRow>(
    `select u.id, u.email, u.full_name, u.whatsapp_phone_e164
     from memberships m
     join users u on u.id = m.user_id
     where m.org_id = $1 and m.status = 'active' and u.is_active = true`,
    [input.organizationId]
  );
  if (members.length === 0) return;

  const documentCount = input.manifest.documents.filter((d) => d.present).length;
  if (documentCount <= 0) {
    // No debería ocurrir para un manifiesto "ready" (el checklist en verde
    // exige documentos presentes), pero `documentCount` es `positive()` en
    // el schema de la plantilla -- fallar honesto en logs en vez de mandar
    // un correo con datos imposibles.
    app.log.error(
      { organizationId: input.organizationId, tenderId: input.tenderId },
      'Manifiesto "ready" sin ningún documento presente: no se manda el aviso (dato inconsistente, revisar PackageAssembler).'
    );
    return;
  }

  const packageUrl = new URL('/entrega/paquete-descargable', app.config.publicUrl).toString();

  for (const member of members) {
    const user: MinimalUserWithPhone = {
      id: member.id,
      email: member.email,
      fullName: member.full_name,
      whatsappPhone: member.whatsapp_phone_e164,
    };
    try {
      const outcome = await sendSubmissionPackageReadyEmail(app, user, {
        organizationId: input.organizationId,
        tenderId: input.tenderId,
        tenderTitle: input.tenderTitle,
        documentCount,
        submissionDeadlineIso: input.submissionDeadlineIso,
        packageUrl,
      });
      if (outcome.status !== 'sent' && outcome.status !== 'skipped_preferences' && outcome.status !== 'skipped_suppressed' && outcome.status !== 'already_sent') {
        app.log.warn(
          { status: outcome.status, userId: member.id, organizationId: input.organizationId, tenderId: input.tenderId },
          'El aviso de paquete listo no se mandó (best-effort; el ensamblado ya se aplicó y no se ve afectado)'
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
        'No se pudo notificar el paquete listo a este miembro (best-effort, no impide notificar al resto)'
      );
    }
  }
}
