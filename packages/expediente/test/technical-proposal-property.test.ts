import { describe, expect, it } from "vitest";
import { CompanyDataService, InMemoryCompanyDataResolver } from "../src/company-data.js";
import { TechnicalProposalBuilder } from "../src/technical-proposal.js";
import type { Obligatoriedad, RequirementItem, RequirementType } from "../src/requirement-matrix.js";

/**
 * EX-EXP-03/EX-EXP-12 (propiedad, no solo casos puntuales): "ningún
 * requisito desaparece" del pipeline de la propuesta técnica sin una razón
 * EXPLÍCITA y contabilizada. `fast-check` no está disponible en este
 * paquete (sin dependencias externas más allá de `jszip`/`vitest`, ver
 * `package.json`), así que la propiedad se verifica con 200 casos
 * ALEATORIOS DETERMINISTAS (PRNG con semilla fija — mismo resultado en
 * cualquier máquina/CI) en vez de ejemplos sueltos.
 *
 * Invariante verificada en cada uno de los 200 casos: para el conjunto de
 * requisitos de tipo relevante (tecnico/administrativo/legal/anexo),
 * `sections.length` (la "salida") nunca es menor que la cantidad de
 * requisitos que el propio contrato de `TechnicalProposalBuilder` declara
 * que NUNCA deben desaparecer sin sección — es decir,
 * `salida.length >= entrada.length` para `entrada` = requisitos
 * obligatorios, o condicionales que aplican, o condicionales cuya
 * aplicabilidad no fue evaluada explícitamente (fail-closed). Solo un
 * requisito `opcional`, o un `condicional` que el llamador marcó
 * EXPLÍCITAMENTE como no aplicable, puede quedar sin sección — y se
 * verifica que ESE conjunto de omisiones está contabilizado (no es una
 * desaparición muda): `sections.length + omitidosJustificados.length ===`
 * el total de requisitos de tipo relevante.
 */

// PRNG determinista (mulberry32): mismo resultado en cualquier corrida/CI.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RELEVANT_TYPES: RequirementType[] = ["tecnico", "administrativo", "legal", "anexo"];
const OBLIGATORIEDADES: Obligatoriedad[] = ["obligatorio", "opcional", "condicional"];

function emptyCompanyService(): CompanyDataService {
  return new CompanyDataService(new InMemoryCompanyDataResolver({}));
}

function randomRequirement(rand: () => number, index: number): RequirementItem {
  const obligatoriedad = OBLIGATORIEDADES[Math.floor(rand() * OBLIGATORIEDADES.length)];
  const type = RELEVANT_TYPES[Math.floor(rand() * RELEVANT_TYPES.length)];
  const hasEvidence = rand() < 0.4;
  const isBloqueado = rand() < 0.15;
  return {
    id: `req-prop-${index}`,
    text: `Requisito de prueba #${index} (${obligatoriedad}/${type})`,
    source: { documentId: "bases-prop", documentLabel: "Bases (propiedad)", page: 1 },
    obligatoriedad,
    type,
    responsibleRole: "licitador",
    deadline: null,
    requiredEvidence: hasEvidence ? ["evidencia_generica"] : [],
    status: isBloqueado ? "bloqueado" : "pendiente",
    extractedBy: "rule",
    confidence: 0.7,
  };
}

const SEEDS_AND_SIZES = Array.from({ length: 200 }, (_, i) => ({ seed: 1000 + i, size: 1 + (i % 8) }));

describe("TechnicalProposalBuilder — invariante de propiedad: ningún requisito desaparece sin razón explícita (EX-EXP-03/EX-EXP-12, 200 casos)", () => {
  it.each(SEEDS_AND_SIZES)("caso #%# (seed=$seed, n=$size): salida.length >= entrada-obligatoria.length y ningún requisito se pierde sin contabilizar", ({ seed, size }) => {
    const rand = mulberry32(seed);
    const requirements: RequirementItem[] = Array.from({ length: size }, (_, i) => randomRequirement(rand, i));

    // Declaración explícita de aplicabilidad SOLO para una fracción de los
    // condicionales sin evidencia (deja el resto deliberadamente "no
    // evaluado" para ejercitar también esa rama fail-closed).
    const conditionEvaluations: Record<string, boolean> = {};
    for (const req of requirements) {
      if (req.obligatoriedad === "condicional" && req.requiredEvidence.length === 0 && rand() < 0.66) {
        conditionEvaluations[req.id] = rand() < 0.5;
      }
    }

    const technical = new TechnicalProposalBuilder(emptyCompanyService()).build("empresa-prop", requirements, [], "2026-10-20T12:00:00-06:00", conditionEvaluations);

    const sectionIds = new Set(technical.sections.map((s) => s.requirementId));

    let mustHaveSectionCount = 0;
    let justifiedOmissionCount = 0;

    for (const req of requirements) {
      if (!RELEVANT_TYPES.includes(req.type)) continue; // filtrado por diseño, no es "desaparición"

      const isProceduralOmission =
        req.requiredEvidence.length === 0 &&
        (req.obligatoriedad === "opcional" ||
          (req.obligatoriedad === "condicional" && conditionEvaluations[req.id] === false));

      if (isProceduralOmission) {
        justifiedOmissionCount += 1;
        // Una omisión procedimental NUNCA debe dejar sección ni bloqueo.
        expect(sectionIds.has(req.id), `requisito "${req.id}" omitido procedimentalmente NO debía tener sección`).toBe(false);
        continue;
      }

      // Todo lo demás (obligatorio; condicional que aplica o no evaluado;
      // cualquier requisito CON evidencia, sea cual sea su obligatoriedad;
      // o bloqueado) DEBE tener sección — nunca desaparece.
      mustHaveSectionCount += 1;
      expect(sectionIds.has(req.id), `requisito "${req.id}" (obligatoriedad=${req.obligatoriedad}, evidencia=${req.requiredEvidence.length}) desapareció sin sección`).toBe(true);
    }

    // Invariante central: la salida nunca es menor que el conjunto de
    // requisitos que el contrato garantiza que no pueden desaparecer.
    expect(technical.sections.length).toBeGreaterThanOrEqual(mustHaveSectionCount);
    // Y nada se pierde SIN CONTABILIZAR: sección + omisión justificada cubre
    // el 100% de los requisitos de tipo relevante.
    const relevantCount = requirements.filter((r) => RELEVANT_TYPES.includes(r.type)).length;
    expect(technical.sections.length + justifiedOmissionCount).toBe(relevantCount);
  });
});
