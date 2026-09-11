import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { nextOnboardingQuestion, type OnboardingFieldId, type OnboardingKnownState } from '@atiende/agents';
import { onboardingStateSchema, type OnboardingStateResponse } from './schemas.js';

/**
 * Patrón Likida/atiende.ai #7 (onboarding conversacional con guardas
 * deterministas): `apps/web/src/pages/onboarding/OnboardingPage.tsx` es hoy
 * un wizard rígido de 5 pasos fijos, sin ninguna interacción que adapte las
 * preguntas a lo que falta o ya se sabe del usuario. Este módulo es la
 * CAPA conversacional que pide el patrón: `GET /onboarding/state` calcula,
 * a partir de datos REALES (organización/perfil/equipo/documentos ya
 * persistidos, nunca simulados), qué falta y cuál es la siguiente pregunta
 * en lenguaje natural (`@atiende/agents::nextOnboardingQuestion`) -- la
 * GUARDA determinista de que el flujo nunca se marca "listo" mientras falte
 * organización/RFC/giro vive en `packages/agents/src/onboarding.ts`
 * (`computeOnboardingProgress`), no aquí ni en el LLM.
 *
 * Deliberadamente de SOLO LECTURA: reutiliza los mismos endpoints ya
 * reales, probados y auditados que el wizard actual usa para escribir
 * (`POST /organizations`, `PUT /company/profile`,
 * `POST /organizations/invitations`, `POST /company/documents`) -- este
 * endpoint solo le dice al cliente conversacional CUÁL de ellos llamar a
 * continuación (`nextAction`), en vez de duplicar esa lógica de escritura
 * (creación de organización, alta de invitación, subida de archivo) con
 * una segunda copia que habría que mantener sincronizada con la primera.
 */

const NEXT_ACTION_BY_FIELD: Record<OnboardingFieldId, { method: 'GET' | 'POST' | 'PUT'; path: string; hint: string }> = {
  organization: { method: 'POST', path: '/organizations', hint: 'Crea la organización con { name, slug }.' },
  legalName: { method: 'PUT', path: '/company/profile', hint: 'Guarda legalName (junto con taxId/sector si ya se conocen) en el perfil de empresa.' },
  taxId: { method: 'PUT', path: '/company/profile', hint: 'Guarda taxId (junto con legalName/sector si ya se conocen) en el perfil de empresa.' },
  sector: { method: 'PUT', path: '/company/profile', hint: 'Guarda sector (junto con legalName/taxId si ya se conocen) en el perfil de empresa.' },
  team: { method: 'POST', path: '/organizations/invitations', hint: 'Invita a una persona con { email, role }. Este paso es opcional.' },
  document: { method: 'POST', path: '/company/documents', hint: 'Sube el primer documento con { documentType, contentBase64 }. Este paso es opcional.' },
};

interface CompanyProfileRow {
  legal_name: string | null;
  tax_id: string | null;
  sector: string | null;
}

export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/state',
    {
      // Deliberadamente SIN `app.requireOrg`: a diferencia del resto de
      // `apps/api`, este endpoint debe responder también para quien
      // TODAVÍA no tiene ninguna organización (el primer turno de la
      // conversación es, precisamente, "¿cómo se llama tu organización?").
      preHandler: [app.authenticate],
      schema: { response: { 200: onboardingStateSchema } },
    },
    async (request): Promise<OnboardingStateResponse> => {
      const userId = request.userId!;
      const requestedOrgId = request.headers['x-org-id'];

      const { orgId, profile, teamInvited, firstDocumentUploaded } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);

        const orgs = await tx.query<{ org_id: string }>('select * from app.my_organizations()');
        const memberOrgIds = new Set(orgs.rows.map((r) => r.org_id));
        // Un X-Org-Id de una organización de la que NO se es miembro nunca
        // se usa -- se degrada al mismo criterio que sin encabezado (primera
        // organización propia, o ninguna). Mismo espíritu que `app.requireOrg`
        // (nunca confiar en un org_id del cliente sin verificar membresía),
        // pero SIN lanzar 403: este endpoint es informativo, no de escritura.
        const resolvedOrgId =
          typeof requestedOrgId === 'string' && memberOrgIds.has(requestedOrgId) ? requestedOrgId : (orgs.rows[0]?.org_id ?? null);

        if (!resolvedOrgId) {
          return { orgId: null, profile: null, teamInvited: false, firstDocumentUploaded: false };
        }

        await tx.query("select set_config('app.current_org_id', $1, true)", [resolvedOrgId]);

        const profileRows = await tx.query<CompanyProfileRow>(
          'select legal_name, tax_id, sector from company_profiles where org_id = $1',
          [resolvedOrgId]
        );
        const teamRows = await tx.query<{ team_invited: boolean }>(
          `select (
             exists (select 1 from invitations where org_id = $1)
             or (select count(*) from memberships where org_id = $1 and status = 'active') > 1
           ) as team_invited`,
          [resolvedOrgId]
        );
        const documentRows = await tx.query<{ has_document: boolean }>(
          'select exists (select 1 from company_documents where org_id = $1) as has_document',
          [resolvedOrgId]
        );

        return {
          orgId: resolvedOrgId,
          profile: profileRows.rows[0] ?? null,
          teamInvited: teamRows.rows[0]?.team_invited ?? false,
          firstDocumentUploaded: documentRows.rows[0]?.has_document ?? false,
        };
      });

      const knownState: OnboardingKnownState = {
        hasOrganization: orgId !== null,
        legalName: profile?.legal_name ?? null,
        taxId: profile?.tax_id ?? null,
        sector: profile?.sector ?? null,
        teamInvited,
        firstDocumentUploaded,
      };

      const question = await nextOnboardingQuestion(app.llmProvider, knownState);

      return {
        orgId,
        hasOrganization: knownState.hasOrganization,
        legalName: knownState.legalName ?? null,
        taxId: knownState.taxId ?? null,
        sector: knownState.sector ?? null,
        teamInvited: knownState.teamInvited ?? false,
        firstDocumentUploaded: knownState.firstDocumentUploaded ?? false,
        missingRequired: question.missingRequired,
        missingOptional: question.missingOptional,
        isComplete: question.isComplete,
        nextField: question.field,
        question: question.text,
        questionSource: question.source,
        nextAction: question.field ? { ...NEXT_ACTION_BY_FIELD[question.field] } : null,
      };
    }
  );
}
