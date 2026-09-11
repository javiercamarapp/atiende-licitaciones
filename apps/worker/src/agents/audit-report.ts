import type { DbClient } from '@atiende/db';
import { withWorkerBusinessReadContext } from './db-context.js';

/**
 * REQ-070 (orquestador Radar→Analista→Redactor→Auditor→Mensajero): reporte
 * determinista del nodo "Auditor". Inspirado en REQ-037 ("5 puertas
 * deterministas antes de cualquier juez LLM": matriz completa, citas a
 * evidencia real, consistencia numérica, formato, coherencia
 * técnica-económica) pero DELIBERADAMENTE MÁS ACOTADO: solo implementa las
 * verificaciones computables hoy con los datos ya persistidos que este
 * worker puede leer (`proposals`/`proposal_sections`/`requirement_items`,
 * ver 0098/0099). REQ-037 sigue siendo su propio requisito con su propio
 * criterio de aceptación (`IntegrityChecklist`, packages/expediente, cubre
 * las 7 dimensiones completas sobre el PAQUETE final) -- este reporte NO
 * pretende sustituirlo, solo decide si el ORQUESTADOR continúa la cadena
 * automática hacia "Mensajero" o se detiene para revisión humana.
 *
 * `blocking`: motivos que impiden continuar la cadena automática (nunca se
 * dispara `mensajero_notificaciones` mientras `blocking.length > 0`).
 * `warnings`: señales reales que NO detienen la cadena pero sí quedan
 * documentadas en el resultado del agente para revisión humana.
 */
export interface AuditReport {
  tenderId: string;
  blocking: string[];
  warnings: string[];
  checkedAt: string;
}

interface ProposalSectionRow {
  section_key: string;
  content: string;
  sources: unknown;
}

const PENDING_CONTENT_PREFIX = 'PENDIENTE:';

/**
 * Calcula el `AuditReport` de una convocatoria a partir de datos REALES ya
 * persistidos -- nunca fabrica un resultado "verde" cuando falta
 * información: la ausencia de matriz/expediente/secciones es, en sí misma,
 * un motivo de bloqueo explícito (nunca un reporte vacío indistinguible de
 * "todo en orden").
 *
 * Se exporta como función pura (recibe `db`/`orgId`/`tenderId`/`now`, sin
 * estado) para que la use TANTO la herramienta de negocio
 * `auditar_expediente` (`business-tools.ts`, dentro del `AgentRunner`) COMO
 * el propio orquestador (`handlers/run-agent.ts`) al decidir si encadena
 * hacia `mensajero_notificaciones` -- `ToolCallTrace` (`packages/agents`)
 * nunca persiste el `output` crudo de un tool_call (solo su hash), así que
 * el orquestador no puede "leer" el resultado de la herramienta después de
 * que la corrida terminó; en vez de inventar un canal paralelo para pasar
 * ese dato, ambos llaman a la MISMA función determinista sobre la MISMA
 * base de datos.
 */
export async function computeAuditReport(db: DbClient, orgId: string, tenderId: string, now: () => Date): Promise<AuditReport> {
  const blocking: string[] = [];
  const warnings: string[] = [];

  const { tenderExists, mandatoryRequirementIds, sections } = await withWorkerBusinessReadContext(
    db,
    orgId,
    ['tenders', 'requirement_items', 'proposals', 'proposal_sections'],
    async (tx) => {
      const tenderRes = await tx.query<{ id: string }>(`select id from tenders where id = $1 and org_id = $2`, [tenderId, orgId]);
      const tenderExists = tenderRes.rows.length > 0;

      const reqRes = await tx.query<{ id: string }>(
        `select id from requirement_items where org_id = $1 and tender_id = $2 and is_mandatory = true and invalidated_at is null`,
        [orgId, tenderId],
      );

      const proposalRes = await tx.query<{ id: string }>(
        `select id from proposals where org_id = $1 and tender_id = $2 and invalidated_at is null order by created_at desc limit 1`,
        [orgId, tenderId],
      );

      let sections: ProposalSectionRow[] = [];
      if (proposalRes.rows[0]) {
        const sectionsRes = await tx.query<ProposalSectionRow>(
          `select section_key, content, sources from proposal_sections where org_id = $1 and proposal_id = $2`,
          [orgId, proposalRes.rows[0].id],
        );
        sections = sectionsRes.rows;
      }

      return {
        tenderExists,
        mandatoryRequirementIds: reqRes.rows.map((r) => r.id),
        // `undefined` cuando no hay ninguna propuesta vigente todavía --
        // distinto de "propuesta sin secciones" (`[]`).
        sections: proposalRes.rows[0] ? sections : undefined,
      };
    },
  );

  if (!tenderExists) {
    blocking.push('convocatoria_no_encontrada: no existe una convocatoria con este id en la organización activa');
    return { tenderId, blocking, warnings, checkedAt: now().toISOString() };
  }

  if (mandatoryRequirementIds.length === 0) {
    blocking.push('matriz_de_requisitos_vacia: no hay requisitos obligatorios activos (requirement_items) para auditar');
  }

  if (sections === undefined) {
    blocking.push('sin_expediente: no existe todavía una propuesta (proposals) para esta convocatoria');
  } else {
    const sectionByKey = new Map(sections.map((s) => [s.section_key, s]));

    for (const requirementId of mandatoryRequirementIds) {
      const key = `technical:${requirementId}`;
      const section = sectionByKey.get(key);
      if (!section) {
        blocking.push(`requisito_sin_seccion:${requirementId}`);
        continue;
      }
      if (section.content.startsWith(PENDING_CONTENT_PREFIX)) {
        blocking.push(`seccion_pendiente:${key}`);
      }
    }

    for (const section of sections) {
      if (section.content.startsWith(PENDING_CONTENT_PREFIX)) continue;
      const sources = Array.isArray(section.sources) ? section.sources : [];
      if (sources.length === 0) {
        blocking.push(`seccion_sin_fuente:${section.section_key}`);
      }
    }

    const hasEconomicCarta = sectionByKey.has('economic:carta');
    const hasEconomicAnexo = sectionByKey.has('economic:anexo');
    if (!hasEconomicCarta || !hasEconomicAnexo) {
      warnings.push('propuesta_economica_pendiente: aún no se generó la carta y/o el anexo económico de esta propuesta');
    }
  }

  return { tenderId, blocking, warnings, checkedAt: now().toISOString() };
}
