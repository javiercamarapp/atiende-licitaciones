import type { DbClient, OrgRole } from '@atiende/db';
import { GO_NO_GO_ROLES } from '../../modules/matching/go-no-go.routes.js';

export interface ResolvedWhatsAppActor {
  userId: string;
  orgId: string;
  role: OrgRole;
}

export type ResolveWhatsAppActorResult =
  | { ok: true; actor: ResolvedWhatsAppActor }
  | {
      ok: false;
      reason: 'tender_not_found' | 'phone_not_linked' | 'phone_ambiguous' | 'not_a_member' | 'role_not_allowed';
    };

/**
 * REQ-090: una firma de webhook válida (`verifyMetaWebhookSignature`) prueba
 * que el payload lo mandó Meta -- NUNCA que el número de teléfono que
 * escribió sea un usuario real de esta plataforma, ni que tenga permiso
 * para decidir Go/No-Go en la organización dueña de esa convocatoria. Este
 * es el mismo tipo de comprobación de coherencia que AM-03 exige para el
 * webhook de correo (`lib/mail/pg-outbox-lookup.ts`) -- aquí aplicado a
 * identidad y autorización en vez de a "¿le mandamos esto de verdad?".
 *
 * `db.query` DIRECTO (sin `set local role app_role`) para las DOS primeras
 * consultas de solo lectura -- misma excepción DELIBERADA y acotada,
 * documentada en `pg-outbox-lookup.ts`: en este punto todavía no sabemos
 * `orgId` (lo da la primera consulta), así que no hay ningún
 * `app.current_org_id` que fijar todavía. Ninguna de las dos escribe nada
 * ni expone más que lo estrictamente necesario para la siguiente decisión
 * (el `org_id` de UN tender por id exacto; si hay más de un usuario con el
 * mismo teléfono, NINGUNO se usa -- nunca se adivina).
 *
 * Nunca inserta ni decide nada de negocio -- eso lo hace
 * `decideGoNoGo` (`modules/matching/go-no-go.routes.ts`), dentro de una
 * transacción propia que SÍ fija `app.current_org_id`/`app.current_user_id`
 * con el resultado de esta función, para que RLS (0024) siga siendo la
 * última línea de defensa incluso si esta función tuviera un bug.
 */
export async function resolveGoNoGoActorFromPhone(
  db: DbClient,
  params: { fromPhoneE164: string; tenderId: string }
): Promise<ResolveWhatsAppActorResult> {
  const tenderRes = await db.query<{ org_id: string }>('select org_id from tenders where id = $1', [params.tenderId]);
  const orgId = tenderRes.rows[0]?.org_id;
  if (!orgId) return { ok: false, reason: 'tender_not_found' };

  const usersRes = await db.query<{ id: string }>(
    'select id from users where whatsapp_phone_e164 = $1 and is_active = true',
    [params.fromPhoneE164]
  );
  if (usersRes.rows.length === 0) return { ok: false, reason: 'phone_not_linked' };
  if (usersRes.rows.length > 1) return { ok: false, reason: 'phone_ambiguous' };
  const userId = usersRes.rows[0]!.id;

  const membershipRes = await db.query<{ role: OrgRole }>(
    "select role from memberships where org_id = $1 and user_id = $2 and status = 'active'",
    [orgId, userId]
  );
  const role = membershipRes.rows[0]?.role;
  if (!role) return { ok: false, reason: 'not_a_member' };
  if (!GO_NO_GO_ROLES.includes(role)) return { ok: false, reason: 'role_not_allowed' };

  return { ok: true, actor: { userId, orgId, role } };
}
