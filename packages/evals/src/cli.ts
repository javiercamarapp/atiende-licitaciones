import { gradeAnticorruption } from "./graders/anticorruption.js";
import { gradeAuthorization } from "./graders/authorization.js";
import { buildJudge, gradeWithJudge } from "./graders/llm-judge.js";
import { gradeNoFabrication } from "./graders/no-fabrication.js";
import {
  ANTICORRUPTION_CASES,
  AUTHORIZATION_CASES,
  JUDGE_CASES,
  NO_FABRICATION_CASES,
  PROMPT_INJECTION_CASES,
} from "./cases/index.js";
import { formatGateReport, runEvalSuite } from "./runner.js";
import { GATE_THRESHOLDS } from "./thresholds.js";
import type { GateReport, GraderVerdict } from "./types.js";

/**
 * Punto de entrada REAL del gate (REQ-087/REQ-097/REQ-138): arma los
 * veredictos con los graders/casos reales de este paquete y corre
 * `runEvalSuite`. Extraído de `main()` para que sea testeable sin invocar
 * `process.exit` (ver test/cli.test.ts).
 */
export async function computeGateReport(openaiApiKey?: string): Promise<GateReport> {
  const judge = buildJudge(openaiApiKey);

  const verdicts: GraderVerdict[] = [
    ...ANTICORRUPTION_CASES.map((c) => gradeAnticorruption(c)),
    ...PROMPT_INJECTION_CASES.map((c) => gradeAnticorruption(c)),
    ...NO_FABRICATION_CASES.map((c) => gradeNoFabrication(c)),
    ...AUTHORIZATION_CASES.map((c) => gradeAuthorization(c)),
    ...(await Promise.all(JUDGE_CASES.map((c) => gradeWithJudge(c, judge, GATE_THRESHOLDS.find((t) => t.category === "juicio_calidad_redaccion")!.minPassRate)))),
  ];

  return runEvalSuite(verdicts, GATE_THRESHOLDS);
}

/** Corre el gate completo, imprime el reporte y devuelve el código de salida (0 = pasa, 1 = falla). Nunca llama `process.exit` por sí sola. */
export async function runCli(openaiApiKey?: string): Promise<number> {
  const report = await computeGateReport(openaiApiKey);
  console.log(formatGateReport(report));
  return report.overallStatus === "pass" ? 0 : 1;
}

/* v8 ignore start -- invocación real de proceso (process.exit), cubierta por evidencia manual (ver README/ACEPTACION), no por vitest. */
async function main(): Promise<void> {
  const code = await runCli(process.env.OPENAI_API_KEY);
  process.exit(code);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("evals-gate: fallo inesperado al correr el gate", error);
    process.exit(1);
  });
}
/* v8 ignore stop */
