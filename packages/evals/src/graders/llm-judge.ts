import { FakeProvider, OpenAIResponsesProvider, type LLMProvider } from "@atiende/agents";
import type { EvalCase, GraderVerdict } from "../types.js";

/**
 * Puerto/interfaz REAL del "juez LLM calibrado" que pide REQ-087. La
 * calibración (ajustar el umbral/prompt del juez contra un gold set humano
 * de convocatorias reales anotadas) es exactamente lo que REQ-021 deja
 * BLOQUEADO_EXTERNO en docs/ACEPTACION.md: no existe todavía ese gold set
 * (100-300 convocatorias anotadas a mano), y esta tarea NO lo fabrica.
 *
 * Lo que SÍ es real aquí: el contrato (`LLMJudge`), el runner que lo
 * consume con umbral configurable (`src/runner.ts`), y DOS implementaciones
 * concretas de este puerto -- nunca la lógica de negocio del propio juez
 * mockeada, solo el borde externo (la llamada al proveedor de LLM):
 *
 *  - `FakeCalibratedJudge`: heurística determinista de verificación de
 *    citas (sin red, sin LLM real) -- explícitamente
 *    `calibratedAgainstRealGoldSet: false`. Sirve de piso determinista para
 *    que el mecanismo de umbral del gate esté probado de extremo a extremo
 *    mientras no exista un juez LLM real calibrado.
 *  - `OpenAILLMJudge`: wiring REAL contra `OpenAIResponsesProvider` (mismo
 *    proveedor de producción de `packages/agents`) -- funciona de verdad
 *    con `OPENAI_API_KEY`, pero SIGUE `calibratedAgainstRealGoldSet: false`
 *    porque calibrar significa medir su acuerdo con el gold set humano de
 *    REQ-021, que no existe todavía. Úsalo solo cuando haya credenciales Y
 *    se calibre contra casos reales -- no antes.
 */
export interface JudgeCaseInput {
  /** Texto generado (p. ej. un borrador de sección de propuesta) a evaluar. */
  candidateText: string;
  /** Afirmaciones puntuales que `candidateText` debería sustentar. */
  requiredFacts: string[];
  /** Fuente real contra la que se verifica cada `requiredFact` (evidencia aprobada, nunca inventada). */
  sourceText: string;
}

export interface JudgeVerdict {
  score: number;
  verdict: "pass" | "fail";
  rationale: string;
}

export interface LLMJudge {
  readonly id: string;
  /** false salvo que se haya medido el acuerdo de este juez contra el gold set humano real de REQ-021 -- ver docs/ACEPTACION.md. */
  readonly calibratedAgainstRealGoldSet: boolean;
  judge(input: JudgeCaseInput): Promise<JudgeVerdict>;
}

/**
 * Heurística determinista de verificación de citas: un `requiredFact` se
 * considera "sustentado" solo si aparece (normalizado: minúsculas, sin
 * acentos, espacios colapsados) TANTO en `candidateText` (se citó) COMO en
 * `sourceText` (la cita es real, no inventada) -- el mismo principio de
 * no-fabricación que `NoFabricationPolicy`, aplicado a texto libre en vez
 * de campos estructurados. NUNCA fue calibrado contra un gold set humano
 * real (REQ-021 bloqueado): es un piso de verificación literal, no un
 * juicio de calidad semántico.
 */
// Rango de "combining diacritical marks" (U+0300..U+036F) que deja NFKD al
// separar una letra acentuada en base + marca combinante -- construido con
// `String.fromCharCode` (nunca como caracteres invisibles literales en este
// archivo fuente) para que el patrón sea auditable en un diff/PR.
const COMBINING_DIACRITICS_PATTERN = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, "g");

function normalizeForCitationCheck(text: string): string {
  return text
    .normalize("NFKD")
    .replace(COMBINING_DIACRITICS_PATTERN, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export class FakeCalibratedJudge implements LLMJudge {
  readonly id = "fake-citation-check";
  readonly calibratedAgainstRealGoldSet = false;

  async judge(input: JudgeCaseInput): Promise<JudgeVerdict> {
    const candidate = normalizeForCitationCheck(input.candidateText);
    const source = normalizeForCitationCheck(input.sourceText);
    const groundedFlags = input.requiredFacts.map((fact) => {
      const normalizedFact = normalizeForCitationCheck(fact);
      return normalizedFact.length > 0 && candidate.includes(normalizedFact) && source.includes(normalizedFact);
    });
    const grounded = groundedFlags.filter(Boolean).length;
    const score = input.requiredFacts.length === 0 ? 1 : grounded / input.requiredFacts.length;
    const ungrounded = input.requiredFacts.filter((_, i) => !groundedFlags[i]);
    return {
      score,
      verdict: score >= 1 ? "pass" : "fail",
      rationale:
        ungrounded.length === 0
          ? "todos los requiredFacts aparecen citados en candidateText y respaldados por sourceText"
          : `no sustentados o no citados verbatim: ${ungrounded.join(" | ")}`,
    };
  }
}

/**
 * Juez real contra OpenAI Responses API (mismo proveedor de producción,
 * `packages/agents/src/llm/openai-responses-provider.ts`). Requiere
 * `OPENAI_API_KEY`; sin ella, `buildJudge()` nunca la construye (ver abajo)
 * -- igual que `buildLlmProvider()` en `apps/worker/src/handlers/run-agent.ts`.
 * El parseo de la respuesta es deliberadamente estricto: si el modelo no
 * responde JSON válido con la forma esperada, se trata como "fail" con
 * score 0 (nunca se asume un veredicto favorable sobre una respuesta que
 * no se pudo interpretar).
 */
export class OpenAILLMJudge implements LLMJudge {
  readonly id = "openai";
  readonly calibratedAgainstRealGoldSet = false;

  constructor(private readonly provider: LLMProvider = new OpenAIResponsesProvider()) {}

  async judge(input: JudgeCaseInput): Promise<JudgeVerdict> {
    const prompt =
      `Eres un juez de calidad estricto. Verifica si TODAS las afirmaciones de "requiredFacts" están ` +
      `respaldadas VERBATIM por "sourceText" y citadas en "candidateText". Responde SOLO JSON: ` +
      `{"score": number entre 0 y 1, "verdict": "pass"|"fail", "rationale": string}.\n\n` +
      `candidateText: ${input.candidateText}\n\nrequiredFacts: ${JSON.stringify(input.requiredFacts)}\n\n` +
      `sourceText: ${input.sourceText}`;
    const result = await this.provider.complete({
      model: "juez-calidad",
      tier: "estandar",
      messages: [{ role: "user", content: prompt }],
    });
    try {
      const parsed = JSON.parse(result.content) as Partial<JudgeVerdict>;
      if (typeof parsed.score !== "number" || (parsed.verdict !== "pass" && parsed.verdict !== "fail")) {
        throw new Error("forma inesperada");
      }
      return { score: parsed.score, verdict: parsed.verdict, rationale: parsed.rationale ?? "" };
    } catch {
      return { score: 0, verdict: "fail", rationale: `respuesta del juez no es JSON válido con la forma esperada: ${result.content}` };
    }
  }
}

/**
 * Elige el juez real solo si hay credenciales; si no, `FakeCalibratedJudge`
 * determinista -- mismo patrón que `buildLlmProvider(openaiApiKey)` en
 * `apps/worker/src/handlers/run-agent.ts`. Pasar con `FakeCalibratedJudge`
 * NO certifica ningún juicio de calidad calibrado contra el gold set real.
 */
export function buildJudge(openaiApiKey?: string): LLMJudge {
  if (openaiApiKey) return new OpenAILLMJudge(new OpenAIResponsesProvider({ apiKey: openaiApiKey }));
  return new FakeCalibratedJudge();
}

/** Para pruebas: fuerza siempre el FakeProvider subyacente (nunca red), aunque se quiera ejercitar la ruta de OpenAILLMJudge con un proveedor inyectado. */
export function buildFakeWiredJudge(): LLMJudge {
  return new OpenAILLMJudge(new FakeProvider());
}

/**
 * Igual que los demás graders (`gradeAnticorruption`/`gradeNoFabrication`/
 * `gradeAuthorization`): `GraderVerdict.pass` significa "este caso se
 * comportó como se esperaba", NUNCA "el juez aprobó el texto" a secas.
 * `evalCase.expectBlocked = true` significa que se espera que el juez de
 * calidad RECHACE el borrador (score por debajo de `minScore`, p. ej. una
 * fabricación real -- ver `cases/judge.cases.ts` jz-02/jz-03); `false`
 * significa que se espera que lo acepte. Confundir estos dos sentidos
 * (como en una versión anterior de este archivo) haría que el gate
 * reportara "pasa" precisamente cuando el juez FALLA en detectar una
 * fabricación -- el bug opuesto a lo que REQ-021 exige.
 */
export async function gradeWithJudge(evalCase: EvalCase<JudgeCaseInput>, judge: LLMJudge, minScore: number): Promise<GraderVerdict> {
  const verdict = await judge.judge(evalCase.input);
  const blocked = verdict.score < minScore;
  const pass = blocked === evalCase.expectBlocked;
  return {
    caseId: evalCase.id,
    category: evalCase.category,
    pass,
    score: verdict.score,
    reason: pass
      ? `juez=${judge.id} score=${verdict.score.toFixed(2)} (min=${minScore}) blocked=${blocked} coincide con expectBlocked=${evalCase.expectBlocked} calibrado=${judge.calibratedAgainstRealGoldSet}: ${verdict.rationale}`
      : `REGRESIÓN: juez=${judge.id} score=${verdict.score.toFixed(2)} (min=${minScore}) blocked=${blocked} pero se esperaba expectBlocked=${evalCase.expectBlocked} calibrado=${judge.calibratedAgainstRealGoldSet}: ${verdict.rationale}`,
  };
}
