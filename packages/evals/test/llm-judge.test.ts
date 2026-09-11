import { FakeProvider } from "@atiende/agents";
import { describe, expect, it } from "vitest";
import { FakeCalibratedJudge, OpenAILLMJudge, buildFakeWiredJudge, buildJudge, gradeWithJudge } from "../src/graders/llm-judge.js";
import type { EvalCase } from "../src/types.js";
import type { JudgeCaseInput } from "../src/graders/llm-judge.js";

const CASE: EvalCase<JudgeCaseInput> = {
  id: "jz-test",
  category: "juicio_calidad_redaccion",
  description: "caso de prueba del juez",
  input: { candidateText: "texto candidato", requiredFacts: ["hecho A"], sourceText: "fuente con hecho A" },
  expectBlocked: false,
  provenance: "test",
};

describe("buildJudge (mismo patrón que buildLlmProvider: Fake salvo credenciales)", () => {
  it("sin apiKey devuelve FakeCalibratedJudge (calibratedAgainstRealGoldSet=false)", () => {
    const judge = buildJudge(undefined);
    expect(judge).toBeInstanceOf(FakeCalibratedJudge);
    expect(judge.calibratedAgainstRealGoldSet).toBe(false);
  });

  it("con apiKey devuelve OpenAILLMJudge (real wiring, sigue sin calibrar contra el gold set)", () => {
    const judge = buildJudge("sk-test-no-real");
    expect(judge).toBeInstanceOf(OpenAILLMJudge);
    expect(judge.calibratedAgainstRealGoldSet).toBe(false);
  });
});

describe("FakeCalibratedJudge", () => {
  it("score=1 cuando no hay requiredFacts que verificar", async () => {
    const judge = new FakeCalibratedJudge();
    const verdict = await judge.judge({ candidateText: "x", requiredFacts: [], sourceText: "y" });
    expect(verdict.score).toBe(1);
    expect(verdict.verdict).toBe("pass");
  });
});

describe("OpenAILLMJudge (wiring real contra LLMProvider, sin red -- FakeProvider inyectado)", () => {
  it("parsea correctamente una respuesta JSON válida del proveedor", async () => {
    const provider = new FakeProvider(() => ({
      content: JSON.stringify({ score: 0.5, verdict: "fail", rationale: "falta una cita" }),
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const judge = new OpenAILLMJudge(provider);
    const verdict = await judge.judge(CASE.input);
    expect(verdict).toEqual({ score: 0.5, verdict: "fail", rationale: "falta una cita" });
  });

  it("trata una respuesta que no es JSON como fail/score 0 (nunca asume un veredicto favorable)", async () => {
    const provider = new FakeProvider(() => ({
      content: "esto no es JSON",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const judge = new OpenAILLMJudge(provider);
    const verdict = await judge.judge(CASE.input);
    expect(verdict.score).toBe(0);
    expect(verdict.verdict).toBe("fail");
    expect(verdict.rationale).toContain("esto no es JSON");
  });

  it("trata un JSON con forma inesperada (sin 'score'/'verdict' válidos) como fail/score 0", async () => {
    const provider = new FakeProvider(() => ({
      content: JSON.stringify({ ok: true }),
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const judge = new OpenAILLMJudge(provider);
    const verdict = await judge.judge(CASE.input);
    expect(verdict.score).toBe(0);
    expect(verdict.verdict).toBe("fail");
  });

  it("buildFakeWiredJudge() usa el FakeProvider determinista por defecto (contenido no-JSON) -> siempre fail/score 0", async () => {
    const judge = buildFakeWiredJudge();
    const verdict = await judge.judge(CASE.input);
    expect(verdict.score).toBe(0);
    expect(verdict.verdict).toBe("fail");
  });
});

describe("gradeWithJudge", () => {
  it("pass=true cuando blocked (score < minScore) coincide con expectBlocked", async () => {
    const provider = new FakeProvider(() => ({
      content: JSON.stringify({ score: 0.9, verdict: "pass", rationale: "ok" }),
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const judge = new OpenAILLMJudge(provider);
    const verdict = await gradeWithJudge(CASE, judge, 0.8);
    expect(verdict.pass).toBe(true);
    expect(verdict.score).toBe(0.9);
  });
});
