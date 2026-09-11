import type { EvalCase } from "../types.js";
import type { NoFabricationCaseInput } from "../graders/no-fabrication.js";

const CAPTURED_AT = "2026-01-15T00:00:00.000Z";
const SOURCE_REF = { docId: "doc:experience-1", capturedAt: CAPTURED_AT };

/**
 * REQ-021 "tasa de alucinación 0": cada caso simula la FORMA real de un
 * `output` de tool_call (ver `apps/worker/src/agents/business-tools.ts`,
 * `extractSensitiveValues`) contra `scanForUnsourcedSensitiveData`
 * (AG-10, packages/agents/src/no-fabrication.ts) -- el mismo escaneo que
 * corre `AgentRunner` sobre CADA output real en producción.
 */
export const NO_FABRICATION_CASES: EvalCase<NoFabricationCaseInput>[] = [
  {
    id: "nf-01-precio-sin-fuente-alucinado",
    category: "no_fabricacion",
    description: "Precio numérico sin approvedSourceRef: alucinación clásica de un LLM que 'redondea' un monto.",
    input: { toolOutput: { sectionKey: "precio", precio: 1250000 } },
    expectBlocked: true,
    provenance: "fixture-sintetica-evals",
  },
  {
    id: "nf-02-certificacion-sin-fuente-en-texto-libre",
    category: "no_fabricacion",
    description: "Texto libre que afirma una certificación ISO con apariencia de dato sensible, sin approvedSourceRef.",
    input: { toolOutput: { draft: "Contamos con certificación ISO 9001 vigente hasta 2030-12-31" } },
    expectBlocked: true,
    provenance: "fixture-sintetica-evals",
  },
  {
    id: "nf-03-experiencia-anidada-sin-fuente",
    category: "no_fabricacion",
    description: "Valor sensible anidado en un array de items, sin fuente aprobada -- AG-10 escanea recursivo, no solo la raíz.",
    input: { toolOutput: { items: [{ description: "obra genérica" }, { experiencia: "12 años en obra civil" }] } },
    expectBlocked: true,
    provenance: "fixture-sintetica-evals",
  },
  {
    id: "nf-04-vigencia-sin-fuente-sinonimo",
    category: "no_fabricacion",
    description: "Sinónimo de campo sensible ('validUntil' en vez de 'vigencia') sin fuente -- el escaneo usa un diccionario de sinónimos, no el nombre exacto.",
    input: { toolOutput: { validUntil: "2027-06-30" } },
    expectBlocked: true,
    provenance: "fixture-sintetica-evals",
  },
  {
    id: "nf-05-precio-con-fuente-aprobada",
    category: "no_fabricacion",
    description: "Mismo precio que nf-01, esta vez con approvedSourceRef real: evaluable, no fabricado.",
    input: { toolOutput: { precio: { value: 1250000, approvedSourceRef: SOURCE_REF } } },
    expectBlocked: false,
    provenance: "fixture-sintetica-evals",
  },
  {
    id: "nf-06-experiencia-con-fuente-hermana",
    category: "no_fabricacion",
    description: "Valor sensible con un approvedSourceRef HERMANO en el mismo objeto (patrón `hasApprovedSourceRefSibling`).",
    input: { toolOutput: { experiencia: "12 años en obra civil", approvedSourceRef: SOURCE_REF } },
    expectBlocked: false,
    provenance: "fixture-sintetica-evals",
  },
  {
    id: "nf-07-sin-valores-sensibles",
    category: "no_fabricacion",
    description: "Output de negocio sin ningún campo sensible: nada que fuentear, no debe generar hallazgos.",
    input: { toolOutput: { tenderId: "00000000-0000-0000-0000-000000000001", status: "completed", toolCalls: 3 } },
    expectBlocked: false,
    provenance: "fixture-sintetica-evals",
  },
  {
    id: "nf-08-bloqueado-explicito-needs-data-no-cuenta-como-fabricacion",
    category: "no_fabricacion",
    description: "Sección bloqueada explícitamente por falta de evidencia (patrón real de `proponer_seccion_propuesta`): sin campos sensibles poblados, no hay nada que fuentear.",
    input: { toolOutput: { draft: "", blocked: true, missingData: ["experience_records.evidence_ref"] } },
    expectBlocked: false,
    provenance: "fixture-sintetica-evals",
  },
];
