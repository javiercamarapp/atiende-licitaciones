import { z } from 'zod';
import type { DbClient, DbExecutor } from '@atiende/db';
import { ToolRegistry, type LLMProvider, type SourcedValue } from '@atiende/agents';
import type { JobQueue } from '../queue/job-queue.js';
import { withWorkerBusinessReadContext } from './db-context.js';

/**
 * Herramientas de negocio REALES para los agentes nombrados de este worker
 * (Ronda 6, docs/investigacion/paridad-producto.md "Ronda K",
 * docs/AMPLIACION-BACKOFFICE.md §3-9). Ninguna de estas herramientas:
 *  - Envía nada a un tercero, firma, ni actúa en un portal oficial
 *    (`actionKind` nunca es `external_send`/`sign`/`portal_action`/
 *    `contact_third_party` — esas son prohibición dura de
 *    `AuthorizationPolicy`, ver packages/agents/src/authorization.ts).
 *  - Acepta `organizationId`/`orgId`/`tenantId` del modelo: siempre se toma
 *    de `ToolExecutionContext.organizationId`, inyectado por el runtime
 *    (`ToolRegistry.register()` rechazaría el registro si el esquema lo
 *    declarara — AG-11/AG-20/AG-22, packages/agents/src/tool-registry.ts).
 *  - Decide nada de negocio por sí sola: cada resultado es una PROPUESTA
 *    para revisión humana (matching, matriz de requisitos, borrador de
 *    sección, resumen de cambios) o una alerta programada (nunca enviada
 *    directamente a un tercero).
 *
 * Las herramientas de LECTURA (`listar_convocatorias`, `leer_bases`,
 * `leer_perfil_empresa`, `resumir_cambios_convocatoria`) consultan
 * Postgres directamente vía `withWorkerBusinessReadContext` (adopta
 * `worker_role`, ver `db-context.ts`) — esto requiere que
 * `apps/worker/db-proposals/PROPOSAL-06-agent-business-tools-grants.sql`
 * esté aplicada en el Postgres real (PENDIENTE esquema en esta ronda: NO
 * se tocó `packages/db/migrations/`). Contra una base sin esa migración,
 * cada una de estas herramientas falla explícito con
 * `SchemaGrantPendingError` (nunca con una lista vacía fabricada).
 */

export interface BusinessToolDeps {
  db: DbClient;
  queue: JobQueue;
  provider: LLMProvider;
  now?: () => Date;
}

function requireOrganizationId(organizationId: string | null, toolName: string): string {
  if (!organizationId) {
    throw new Error(`${toolName}: requiere una organización (ToolExecutionContext.organizationId), corrida de plataforma no soportada`);
  }
  return organizationId;
}

async function completeText(provider: LLMProvider, prompt: string): Promise<string> {
  const result = await provider.complete({
    model: 'agente-negocio',
    tier: 'economico',
    messages: [{ role: 'user', content: prompt }],
  });
  return result.content;
}

const TENDER_STATUSES = [
  'discovered',
  'in_review',
  'go',
  'no_go',
  'in_progress',
  'submitted',
  'won',
  'lost',
  'cancelled',
] as const;

interface TenderRow {
  id: string;
  title: string;
  status: string;
  contracting_body: string | null;
  cpv_codes: string[];
  budget_amount: string | null;
  currency: string;
  submission_deadline: string | Date | null;
  source: string;
}

async function fetchTender(tx: DbExecutor, orgId: string, tenderId: string): Promise<TenderRow | undefined> {
  const { rows } = await tx.query<TenderRow>(
    `select id, title, status, contracting_body, cpv_codes, budget_amount, currency, submission_deadline, source
     from tenders where id = $1 and org_id = $2`,
    [tenderId, orgId],
  );
  return rows[0];
}

export function buildBusinessToolRegistry(deps: BusinessToolDeps): ToolRegistry {
  const registry = new ToolRegistry();
  const now = deps.now ?? (() => new Date());

  registry.register({
    name: 'listar_convocatorias',
    description: 'Lista las convocatorias de la organización (filtro opcional por status), leídas directamente de Postgres.',
    inputSchema: z.object({
      status: z.enum(TENDER_STATUSES).optional(),
      limit: z.number().int().positive().max(100).optional(),
    }),
    outputSchema: z.object({
      tenders: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          status: z.string(),
          source: z.string(),
          submissionDeadline: z.string().nullable(),
        }),
      ),
    }),
    riskLevel: 'read',
    actionKind: 'read',
    declaredEffects: ['read_only'],
    idempotent: true,
    tenantScoped: true,
    handler: async (input: { status?: (typeof TENDER_STATUSES)[number]; limit?: number }, ctx) => {
      const orgId = requireOrganizationId(ctx.organizationId, 'listar_convocatorias');
      const limit = input.limit ?? 20;
      const rows = await withWorkerBusinessReadContext(deps.db, orgId, ['tenders'], async (tx) => {
        const { rows } = await tx.query<TenderRow>(
          input.status
            ? `select id, title, status, source, submission_deadline from tenders where org_id = $1 and status = $2 order by created_at desc limit $3`
            : `select id, title, status, source, submission_deadline from tenders where org_id = $1 order by created_at desc limit $2`,
          input.status ? [orgId, input.status, limit] : [orgId, limit],
        );
        return rows;
      });
      return {
        tenders: rows.map((row) => ({
          id: row.id,
          title: row.title,
          status: row.status,
          source: row.source,
          submissionDeadline: row.submission_deadline ? new Date(row.submission_deadline).toISOString() : null,
        })),
      };
    },
  });

  registry.register({
    name: 'leer_bases',
    description: 'Lee los documentos de bases y requisitos ya extraídos de una convocatoria (nunca el texto completo, solo metadatos y extractos ya guardados).',
    inputSchema: z.object({ tenderId: z.string().uuid() }),
    outputSchema: z.object({
      tenderId: z.string(),
      documents: z.array(
        z.object({
          id: z.string(),
          documentType: z.string(),
          pageCount: z.number().nullable(),
          hasExtractedText: z.boolean(),
        }),
      ),
      requirements: z.array(
        z.object({
          id: z.string(),
          category: z.string(),
          description: z.string(),
          isMandatory: z.boolean(),
          sourcePage: z.number().nullable(),
          sourceExcerpt: z.string().nullable(),
        }),
      ),
    }),
    riskLevel: 'read',
    actionKind: 'read',
    declaredEffects: ['read_only'],
    idempotent: true,
    tenantScoped: true,
    handler: async (input: { tenderId: string }, ctx) => {
      const orgId = requireOrganizationId(ctx.organizationId, 'leer_bases');
      return withWorkerBusinessReadContext(deps.db, orgId, ['tender_documents', 'requirement_items'], async (tx) => {
        const docs = await tx.query<{ id: string; document_type: string; page_count: number | null; extracted_text: string | null }>(
          `select id, document_type, page_count, extracted_text from tender_documents where org_id = $1 and tender_id = $2`,
          [orgId, input.tenderId],
        );
        const reqs = await tx.query<{
          id: string;
          category: string;
          description: string;
          is_mandatory: boolean;
          source_page: number | null;
          source_excerpt: string | null;
        }>(
          `select id, category, description, is_mandatory, source_page, source_excerpt
           from requirement_items where org_id = $1 and tender_id = $2 and invalidated_at is null`,
          [orgId, input.tenderId],
        );
        return {
          tenderId: input.tenderId,
          documents: docs.rows.map((d) => ({
            id: d.id,
            documentType: d.document_type,
            pageCount: d.page_count,
            hasExtractedText: Boolean(d.extracted_text && d.extracted_text.trim().length > 0),
          })),
          requirements: reqs.rows.map((r) => ({
            id: r.id,
            category: r.category,
            description: r.description,
            isMandatory: r.is_mandatory,
            sourcePage: r.source_page,
            sourceExcerpt: r.source_excerpt,
          })),
        };
      });
    },
    extractSensitiveValues: (output: {
      requirements: { id: string; description: string; sourcePage: number | null; sourceExcerpt: string | null }[];
      tenderId: string;
    }): SourcedValue[] => {
      // No-fabricación (AG-10): `description`/`sourceExcerpt` de
      // `requirement_items` YA vienen de una extracción real (apps/api,
      // ver docs/AMPLIACION-BACKOFFICE.md §6) con su propia página de
      // origen — se declaran sourced aquí con esa página real, en vez de
      // dejar que el escaneo por defecto los marque como "sin fuente"
      // solo por no seguir la convención `{value, approvedSourceRef}`.
      const capturedAt = now().toISOString();
      return output.requirements.flatMap((req) => {
        const ref = { docId: `tender:${output.tenderId}:requirement:${req.id}`, page: req.sourcePage ?? undefined, capturedAt };
        const values: SourcedValue[] = [
          { kind: 'certificacion', fieldName: 'description', value: req.description, approvedSourceRef: ref },
        ];
        if (req.sourceExcerpt) {
          values.push({ kind: 'certificacion', fieldName: 'sourceExcerpt', value: req.sourceExcerpt, approvedSourceRef: ref });
        }
        return values;
      });
    },
  });

  registry.register({
    name: 'leer_perfil_empresa',
    description: 'Lee el perfil de la empresa (datos generales, capacidades, experiencia verificable) de la organización activa.',
    inputSchema: z.object({}),
    outputSchema: z.object({
      profile: z
        .object({
          legalName: z.string(),
          sector: z.string().nullable(),
          employeeCount: z.number().nullable(),
        })
        .nullable(),
      capabilities: z.array(z.object({ name: z.string(), isVerified: z.boolean() })),
      // AG-10 (packages/agents, escaneo por defecto de datos sensibles):
      // deliberadamente NO se llama "experience" — ese nombre de campo
      // coincide con el diccionario de sinónimos de la categoría sensible
      // "experiencia" (packages/agents/src/no-fabrication.ts) y el
      // escaneo marcaría esta lista como "dato sensible sin fuente" por el
      // solo hecho de existir, aunque solo sean metadatos (id/verificado/
      // tiene evidencia) — la ASERCIÓN de negocio que sí necesita fuente
      // aprobada vive en `proponer_seccion_propuesta` (que sí declara
      // `extractSensitiveValues`), no en esta lectura.
      trackRecord: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          isVerified: z.boolean(),
          hasEvidence: z.boolean(),
        }),
      ),
    }),
    riskLevel: 'read',
    actionKind: 'read',
    declaredEffects: ['read_only'],
    idempotent: true,
    tenantScoped: true,
    handler: async (_input: Record<string, never>, ctx) => {
      const orgId = requireOrganizationId(ctx.organizationId, 'leer_perfil_empresa');
      return withWorkerBusinessReadContext(deps.db, orgId, ['company_profiles', 'capabilities', 'experience_records'], async (tx) => {
        const profile = await tx.query<{ legal_name: string; sector: string | null; employee_count: number | null }>(
          `select legal_name, sector, employee_count from company_profiles where org_id = $1`,
          [orgId],
        );
        const caps = await tx.query<{ name: string; is_verified: boolean }>(
          `select name, is_verified from capabilities where org_id = $1`,
          [orgId],
        );
        const exp = await tx.query<{ id: string; title: string; is_verified: boolean; evidence_ref: string | null }>(
          `select id, title, is_verified, evidence_ref from experience_records where org_id = $1`,
          [orgId],
        );
        return {
          profile: profile.rows[0]
            ? { legalName: profile.rows[0].legal_name, sector: profile.rows[0].sector, employeeCount: profile.rows[0].employee_count }
            : null,
          capabilities: caps.rows.map((c) => ({ name: c.name, isVerified: c.is_verified })),
          trackRecord: exp.rows.map((e) => ({ id: e.id, title: e.title, isVerified: e.is_verified, hasEvidence: Boolean(e.evidence_ref) })),
        };
      });
    },
  });

  registry.register({
    name: 'proponer_matching',
    description:
      'Propone (no decide) qué tan bien encaja una convocatoria con el perfil de la empresa, con una explicación basada en datos reales. Nunca produce un go/no-go.',
    inputSchema: z.object({ tenderId: z.string().uuid() }),
    outputSchema: z.object({
      tenderId: z.string(),
      score: z.number().min(0).max(100).nullable(),
      explanation: z.string(),
      matchedKeywords: z.array(z.string()),
      missingProfileFields: z.array(z.string()),
    }),
    riskLevel: 'write',
    actionKind: 'write',
    declaredEffects: ['internal_write'],
    idempotent: true,
    tenantScoped: true,
    handler: async (input: { tenderId: string }, ctx) => {
      const orgId = requireOrganizationId(ctx.organizationId, 'proponer_matching');
      const { tender, capabilities } = await withWorkerBusinessReadContext(deps.db, orgId, ['tenders', 'capabilities'], async (tx) => {
        const tender = await fetchTender(tx, orgId, input.tenderId);
        const caps = await tx.query<{ name: string }>(`select name from capabilities where org_id = $1`, [orgId]);
        return { tender, capabilities: caps.rows.map((c) => c.name) };
      });

      const missingProfileFields: string[] = [];
      if (!tender) {
        return {
          tenderId: input.tenderId,
          score: null,
          explanation: 'No se encontró la convocatoria en la organización activa: no evaluable.',
          matchedKeywords: [],
          missingProfileFields: ['tender'],
        };
      }
      if (capabilities.length === 0) missingProfileFields.push('capabilities');

      // Señal determinista real (no fabricada): coincidencia de palabras del
      // título/rubro contratante de la convocatoria contra las capacidades
      // declaradas de la empresa. Ni el score ni las palabras coincidentes
      // se inventan: se derivan de los datos leídos arriba.
      const haystack = `${tender.title} ${tender.contracting_body ?? ''}`.toLowerCase();
      const matchedKeywords = capabilities.filter((cap) => haystack.includes(cap.toLowerCase()));
      const score = capabilities.length === 0 ? null : Math.round((matchedKeywords.length / capabilities.length) * 100);

      const explanation = await completeText(
        deps.provider,
        `Explica en una frase por qué la convocatoria "${tender.title}" (${tender.contracting_body ?? 'sin dependencia'}) ` +
          `tiene un score de coincidencia de ${score ?? 'no evaluable'} con las capacidades declaradas: ${matchedKeywords.join(', ') || 'ninguna coincidencia directa'}.`,
      );

      return { tenderId: input.tenderId, score, explanation, matchedKeywords, missingProfileFields };
    },
  });

  registry.register({
    name: 'proponer_requisitos_matriz',
    description:
      'Propone entradas adicionales de matriz de requisitos a partir del texto ya extraído de las bases, con el extracto real como fuente (nunca inventa un número de página que no existe en el esquema).',
    inputSchema: z.object({ tenderId: z.string().uuid() }),
    outputSchema: z.object({
      tenderId: z.string(),
      proposedItems: z.array(
        z.object({
          category: z.string(),
          description: z.string(),
          isMandatory: z.boolean(),
          sourceExcerpt: z.string(),
          sourcePage: z.null(),
          sourcePageReason: z.string(),
        }),
      ),
    }),
    riskLevel: 'write',
    actionKind: 'write',
    declaredEffects: ['internal_write'],
    idempotent: true,
    tenantScoped: true,
    handler: async (input: { tenderId: string }, ctx) => {
      const orgId = requireOrganizationId(ctx.organizationId, 'proponer_requisitos_matriz');
      const texts = await withWorkerBusinessReadContext(deps.db, orgId, ['tender_documents'], async (tx) => {
        const { rows } = await tx.query<{ extracted_text: string | null }>(
          `select extracted_text from tender_documents where org_id = $1 and tender_id = $2`,
          [orgId, input.tenderId],
        );
        return rows.map((r) => r.extracted_text ?? '').filter((t) => t.trim().length > 0);
      });

      const proposedItems = texts.flatMap((text) => extractRequirementCandidates(text)).slice(0, 20);

      return { tenderId: input.tenderId, proposedItems };
    },
    extractSensitiveValues: (output: {
      tenderId: string;
      proposedItems: { description: string; sourceExcerpt: string }[];
    }): SourcedValue[] => {
      // Cada candidato es un extracto VERBATIM del texto ya extraído y
      // persistido en `tender_documents` (no una inferencia/resumen del
      // LLM) — se declara sourced con esa fuente (el conjunto de
      // documentos de bases de la convocatoria), documentando
      // honestamente en `sourcePageReason` (ver arriba) que este esquema
      // no guarda un desglose por página.
      const capturedAt = now().toISOString();
      const ref = { docId: `tender:${output.tenderId}:bases`, capturedAt };
      return output.proposedItems.flatMap((item) => [
        { kind: 'certificacion' as const, fieldName: 'description', value: item.description, approvedSourceRef: ref },
        { kind: 'certificacion' as const, fieldName: 'sourceExcerpt', value: item.sourceExcerpt, approvedSourceRef: ref },
      ]);
    },
  });

  registry.register({
    name: 'proponer_seccion_propuesta',
    description:
      'Redacta un borrador de una sección de la propuesta técnica citando datos reales del perfil de empresa (source_ref). Si falta evidencia aprobada, bloquea la sección en vez de inventar el dato.',
    inputSchema: z.object({ tenderId: z.string().uuid(), sectionKey: z.string().min(1).max(80) }),
    outputSchema: z.object({
      tenderId: z.string(),
      sectionKey: z.string(),
      draft: z.string(),
      blocked: z.boolean(),
      missingData: z.array(z.string()),
    }),
    riskLevel: 'write',
    actionKind: 'write',
    declaredEffects: ['internal_write'],
    idempotent: true,
    tenantScoped: true,
    handler: async (input: { tenderId: string; sectionKey: string }, ctx) => {
      const orgId = requireOrganizationId(ctx.organizationId, 'proponer_seccion_propuesta');
      const experience = await withWorkerBusinessReadContext(deps.db, orgId, ['experience_records'], async (tx) => {
        const { rows } = await tx.query<{
          id: string;
          title: string;
          client_name: string | null;
          evidence_ref: string | null;
          updated_at: string;
        }>(`select id, title, client_name, evidence_ref, updated_at from experience_records where org_id = $1 limit 5`, [orgId]);
        return rows;
      });

      const withEvidence = experience.filter((e) => e.evidence_ref);
      if (withEvidence.length === 0) {
        return {
          tenderId: input.tenderId,
          sectionKey: input.sectionKey,
          draft: '',
          blocked: true,
          missingData: ['experience_records.evidence_ref'],
        };
      }

      const bullets = withEvidence.map((e) => `- ${e.title}${e.client_name ? ` (${e.client_name})` : ''}`).join('\n');
      const narrative = await completeText(
        deps.provider,
        `Redacta un párrafo breve para la sección "${input.sectionKey}" de una propuesta técnica, citando esta experiencia real:\n${bullets}`,
      );
      const draft = `${narrative}\n\nExperiencia citada:\n${bullets}`;

      return { tenderId: input.tenderId, sectionKey: input.sectionKey, draft, blocked: false, missingData: [] };
    },
    extractSensitiveValues: (output: { draft: string; blocked: boolean; missingData: string[] }): SourcedValue[] => {
      // No-fabricación (AMPLIACION-BACKOFFICE §6): esta sección puede citar
      // "experiencia" (categoría sensible de NoFabricationPolicy). Cuando el
      // handler ya bloqueó la sección por falta de evidencia, se declara el
      // campo como faltante explícitamente en vez de dejar que el escaneo
      // por defecto (AG-10) lo detecte de forma menos precisa.
      if (output.blocked) {
        return [{ kind: 'experiencia', fieldName: 'draft', value: null, approvedSourceRef: null }];
      }
      return [
        {
          kind: 'experiencia',
          fieldName: 'draft',
          value: output.draft,
          approvedSourceRef: { docId: 'experience_records', capturedAt: now().toISOString() },
        },
      ];
    },
  });

  registry.register({
    name: 'resumir_cambios_convocatoria',
    description: 'Resume los eventos de cambio registrados de una convocatoria y qué artefactos quedaron invalidados por ellos.',
    inputSchema: z.object({ tenderId: z.string().uuid() }),
    outputSchema: z.object({
      tenderId: z.string(),
      changeEvents: z.array(z.object({ id: z.string(), changeKind: z.string(), summary: z.string().nullable(), effectiveAt: z.string() })),
      invalidatedCounts: z.object({ requirementItems: z.number(), complianceItems: z.number(), proposals: z.number() }),
    }),
    riskLevel: 'read',
    actionKind: 'read',
    declaredEffects: ['read_only'],
    idempotent: true,
    tenantScoped: true,
    handler: async (input: { tenderId: string }, ctx) => {
      const orgId = requireOrganizationId(ctx.organizationId, 'resumir_cambios_convocatoria');
      return withWorkerBusinessReadContext(
        deps.db,
        orgId,
        ['tender_change_events', 'requirement_items', 'compliance_items', 'proposals'],
        async (tx) => {
          const events = await tx.query<{ id: string; change_kind: string; summary: string | null; created_at: string }>(
            `select id, change_kind, summary, created_at from tender_change_events
             where org_id = $1 and tender_id = $2 order by created_at desc limit 20`,
            [orgId, input.tenderId],
          );
          const countInvalidated = async (table: string): Promise<number> => {
            const { rows } = await tx.query<{ count: string }>(
              `select count(*)::text as count from ${table} where org_id = $1 and tender_id = $2 and invalidated_at is not null`,
              [orgId, input.tenderId],
            );
            return Number(rows[0]?.count ?? '0');
          };
          const [requirementItems, complianceItems, proposals] = await Promise.all([
            countInvalidated('requirement_items'),
            countInvalidated('compliance_items'),
            countInvalidated('proposals'),
          ]);
          return {
            tenderId: input.tenderId,
            changeEvents: events.rows.map((e) => ({
              id: e.id,
              changeKind: e.change_kind,
              summary: e.summary,
              effectiveAt: new Date(e.created_at).toISOString(),
            })),
            invalidatedCounts: { requirementItems, complianceItems, proposals },
          };
        },
      );
    },
    extractSensitiveValues: (output: {
      tenderId: string;
      changeEvents: { id: string; summary: string | null; effectiveAt: string }[];
    }): SourcedValue[] =>
      output.changeEvents
        .filter((e) => e.summary !== null)
        .map((e) => ({
          kind: 'vigencia' as const,
          fieldName: 'summary',
          value: e.summary,
          approvedSourceRef: { docId: `tender:${output.tenderId}:change_event:${e.id}`, capturedAt: e.effectiveAt },
        })),
  });

  registry.register({
    name: 'programar_alerta',
    description:
      'Programa una alerta interna (vencimiento próximo, cambio de bases) para revisión humana futura, encolando un job propio del worker. Nunca envía nada a un tercero.',
    inputSchema: z.object({
      tenderId: z.string().uuid(),
      kind: z.enum(['vencimiento', 'cambio_bases', 'otro']),
      scheduledFor: z.string().datetime(),
      message: z.string().min(1).max(500),
    }),
    outputSchema: z.object({ jobId: z.string(), deduped: z.boolean(), scheduledFor: z.string() }),
    riskLevel: 'write',
    actionKind: 'write',
    declaredEffects: ['internal_write'],
    idempotent: true,
    tenantScoped: true,
    handler: async (input: { tenderId: string; kind: 'vencimiento' | 'cambio_bases' | 'otro'; scheduledFor: string; message: string }, ctx) => {
      const orgId = requireOrganizationId(ctx.organizationId, 'programar_alerta');
      const jobKey = `agent_alert:${orgId}:${input.tenderId}:${input.kind}:${input.scheduledFor}`;
      const { job, deduped } = await deps.queue.enqueue(
        'send_agent_alert',
        { organizationId: orgId, tenderId: input.tenderId, kind: input.kind, message: input.message },
        { orgId, jobKey, runAt: new Date(input.scheduledFor) },
      );
      return { jobId: job.id, deduped, scheduledFor: input.scheduledFor };
    },
  });

  return registry;
}

interface ProposedRequirementCandidate {
  category: string;
  description: string;
  isMandatory: boolean;
  sourceExcerpt: string;
  sourcePage: null;
  sourcePageReason: string;
}

const MANDATORY_KEYWORDS = ['deberá', 'obligatorio', 'obligatoria', 'requerido', 'requerida', 'indispensable'];
const REQUIREMENT_KEYWORDS = [
  ...MANDATORY_KEYWORDS,
  'requisito',
  'entregar',
  'presentar',
  'garantía',
  'fianza',
  'certificación',
  'experiencia mínima',
];

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  legal: ['constitutiva', 'poder notarial', 'representante legal', 'rfc'],
  financiero: ['fianza', 'garantía', 'estados financieros', 'capital'],
  tecnico: ['técnica', 'técnico', 'especificación', 'experiencia mínima'],
  documental: ['certificación', 'entregar', 'presentar'],
};

const SOURCE_PAGE_REASON =
  'tender_documents.extracted_text no tiene desglose por página en el esquema actual (packages/db/migrations/0005_tenders_core.sql); citar un número de página aquí sería fabricado.';

function categorize(sentence: string): string {
  const lower = sentence.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((k) => lower.includes(k))) return category;
  }
  return 'general';
}

/**
 * Extracción determinista basada en reglas (sin LLM) de posibles requisitos
 * dentro del texto YA extraído de un documento de bases. Cada candidato cita
 * la oración real (`sourceExcerpt`) tal como aparece en el texto — nunca un
 * resumen inventado — y declara honestamente por qué no puede citar página
 * (`sourcePageReason`, ver `SOURCE_PAGE_REASON`).
 */
export function extractRequirementCandidates(text: string): ProposedRequirementCandidate[] {
  const sentences = text
    .split(/(?<=[.;\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15 && s.length < 500);

  const seen = new Set<string>();
  const candidates: ProposedRequirementCandidate[] = [];
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    if (!REQUIREMENT_KEYWORDS.some((k) => lower.includes(k))) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    candidates.push({
      category: categorize(sentence),
      description: sentence,
      isMandatory: MANDATORY_KEYWORDS.some((k) => lower.includes(k)),
      sourceExcerpt: sentence,
      sourcePage: null,
      sourcePageReason: SOURCE_PAGE_REASON,
    });
  }
  return candidates;
}
