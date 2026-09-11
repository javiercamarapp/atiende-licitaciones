import { describe, expect, it } from "vitest";
import { FakeProvider } from "../src/llm/fake-provider.js";
import type { LLMProvider } from "../src/llm/provider.js";
import {
  ONBOARDING_FIELD_QUESTIONS,
  OPTIONAL_ONBOARDING_FIELDS,
  REQUIRED_ONBOARDING_FIELDS,
  computeOnboardingProgress,
  nextOnboardingQuestion,
  pickNextOnboardingField,
  type OnboardingKnownState,
} from "../src/onboarding.js";

const EMPTY_STATE: OnboardingKnownState = { hasOrganization: false };

const READY_REQUIRED_STATE: OnboardingKnownState = {
  hasOrganization: true,
  legalName: "Mi Empresa S.A. de C.V.",
  taxId: "MEM990101AB1",
  sector: "Construcción",
};

describe("Patrón #7 -- computeOnboardingProgress: la GUARDA determinista", () => {
  it("con ningún dato, los 4 campos obligatorios faltan y isComplete es false", () => {
    const progress = computeOnboardingProgress(EMPTY_STATE);
    expect(progress.missingRequired).toEqual(["organization", "legalName", "taxId", "sector"]);
    expect(progress.missingOptional).toEqual(["team", "document"]);
    expect(progress.isComplete).toBe(false);
  });

  it("nunca marca isComplete=true mientras falte UN SOLO campo obligatorio, uno por uno", () => {
    // Recorre los 4 obligatorios, agregándolos de a uno -- isComplete debe
    // seguir false hasta que el ÚLTIMO se complete.
    let state: OnboardingKnownState = { hasOrganization: false };
    for (const field of REQUIRED_ONBOARDING_FIELDS.slice(0, -1)) {
      state = applyField(state, field);
      expect(computeOnboardingProgress(state).isComplete, `tras completar "${field}" aún debe faltar algo`).toBe(false);
    }
    // Completa el último obligatorio: ahora sí.
    state = applyField(state, REQUIRED_ONBOARDING_FIELDS[REQUIRED_ONBOARDING_FIELDS.length - 1]);
    expect(computeOnboardingProgress(state).isComplete).toBe(true);
  });

  it("giro (sector) es obligatorio aquí aunque el wizard actual lo trate como opcional -- endurecido a propósito", () => {
    const state: OnboardingKnownState = { hasOrganization: true, legalName: "X", taxId: "Y" }; // sin sector
    const progress = computeOnboardingProgress(state);
    expect(progress.missingRequired).toEqual(["sector"]);
    expect(progress.isComplete).toBe(false);
  });

  it("un string vacío o solo espacios NO cuenta como dato capturado (nunca fabrica un valor)", () => {
    const state: OnboardingKnownState = { hasOrganization: true, legalName: "   ", taxId: "", sector: "Y" };
    const progress = computeOnboardingProgress(state);
    expect(progress.missingRequired).toEqual(["legalName", "taxId"]);
  });

  it("con los 4 obligatorios completos pero sin equipo/documento, isComplete=true y quedan 2 opcionales pendientes", () => {
    const progress = computeOnboardingProgress(READY_REQUIRED_STATE);
    expect(progress.isComplete).toBe(true);
    expect(progress.missingOptional).toEqual(["team", "document"]);
  });

  it("con TODO capturado (incluidos los opcionales), no falta nada", () => {
    const progress = computeOnboardingProgress({ ...READY_REQUIRED_STATE, teamInvited: true, firstDocumentUploaded: true });
    expect(progress.missingRequired).toEqual([]);
    expect(progress.missingOptional).toEqual([]);
    expect(progress.isComplete).toBe(true);
  });
});

describe("pickNextOnboardingField", () => {
  it("con nada capturado, pregunta primero por la organización (mismo orden que el wizard)", () => {
    expect(pickNextOnboardingField(EMPTY_STATE)).toBe("organization");
  });

  it("una vez completos los obligatorios, pasa a preguntar por el equipo (primer opcional)", () => {
    expect(pickNextOnboardingField(READY_REQUIRED_STATE)).toBe("team");
  });

  it("con todo completo, no queda nada que preguntar", () => {
    expect(pickNextOnboardingField({ ...READY_REQUIRED_STATE, teamInvited: true, firstDocumentUploaded: true })).toBeNull();
  });

  it("respeta el orden fijo de ONBOARDING_FIELD_ORDER incluso saltando campos ya sabidos", () => {
    const state: OnboardingKnownState = { hasOrganization: true, legalName: "X" }; // faltan taxId y sector
    expect(pickNextOnboardingField(state)).toBe("taxId");
  });
});

describe("ONBOARDING_FIELD_QUESTIONS", () => {
  it("tiene una pregunta canónica no vacía para cada campo obligatorio y opcional", () => {
    for (const field of [...REQUIRED_ONBOARDING_FIELDS, ...OPTIONAL_ONBOARDING_FIELDS]) {
      expect(ONBOARDING_FIELD_QUESTIONS[field]).toBeTruthy();
      expect(ONBOARDING_FIELD_QUESTIONS[field].length).toBeGreaterThan(5);
    }
  });
});

describe("nextOnboardingQuestion", () => {
  it("con el FakeProvider por defecto (sin script, marca [fake:...]) degrada al texto canónico -- nunca muestra la marca a la persona usuaria", async () => {
    const provider = new FakeProvider();
    const question = await nextOnboardingQuestion(provider, EMPTY_STATE);
    expect(question.field).toBe("organization");
    expect(question.source).toBe("canned");
    expect(question.text).toBe(ONBOARDING_FIELD_QUESTIONS.organization);
    expect(question.text).not.toContain("[fake:");
    expect(question.isComplete).toBe(false);
    expect(question.missingRequired).toEqual(["organization", "legalName", "taxId", "sector"]);
  });

  it("con un proveedor que SÍ redacta contenido real, usa ese texto y marca source=llm", async () => {
    const provider = new FakeProvider(() => ({
      content: "¡Hola! Para arrancar, ¿cómo se llama tu organización?",
      toolCalls: [],
      usage: { inputTokens: 20, outputTokens: 12 },
    }));
    const question = await nextOnboardingQuestion(provider, EMPTY_STATE);
    expect(question.source).toBe("llm");
    expect(question.text).toBe("¡Hola! Para arrancar, ¿cómo se llama tu organización?");
    // La decisión de QUÉ campo preguntar sigue siendo la determinista, no la del modelo.
    expect(question.field).toBe("organization");
  });

  it("si el proveedor lanza una excepción (red caída, credenciales inválidas), degrada al texto canónico sin romper el turno", async () => {
    const failingProvider: LLMProvider = {
      id: "failing",
      countryOfResidence: "US",
      supportsToolCalls: false,
      async complete() {
        throw new Error("network unreachable");
      },
      async *stream() {
        // Nunca se invoca en esta prueba (nextOnboardingQuestion solo usa
        // `complete`) -- se implementa con un `yield` real para satisfacer
        // el tipo `AsyncIterable<LLMStreamEvent>` sin infringir la regla
        // `require-yield` del linter.
        yield { type: "done" as const, usage: { inputTokens: 0, outputTokens: 0 } };
        throw new Error("no implementado en esta prueba");
      },
    };
    const question = await nextOnboardingQuestion(failingProvider, EMPTY_STATE);
    expect(question.source).toBe("canned");
    expect(question.text).toBe(ONBOARDING_FIELD_QUESTIONS.organization);
  });

  it("si el proveedor responde contenido vacío, degrada al texto canónico", async () => {
    const emptyProvider: LLMProvider = {
      id: "empty",
      countryOfResidence: "US",
      supportsToolCalls: false,
      async complete() {
        return { content: "   ", toolCalls: [], usage: { inputTokens: 1, outputTokens: 0 } };
      },
      async *stream() {
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const question = await nextOnboardingQuestion(emptyProvider, EMPTY_STATE);
    expect(question.source).toBe("canned");
  });

  it("cuando ya no falta ningún campo obligatorio ni opcional, devuelve field=null, isComplete=true y un texto de cierre -- SIEMPRE canned (nunca deja que el modelo declare el cierre)", async () => {
    const provider = new FakeProvider(() => ({
      content: "el modelo diría cualquier cosa aquí, se ignora",
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 5 },
    }));
    const complete: OnboardingKnownState = { ...READY_REQUIRED_STATE, teamInvited: true, firstDocumentUploaded: true };
    const question = await nextOnboardingQuestion(provider, complete);
    expect(question.field).toBeNull();
    expect(question.isComplete).toBe(true);
    expect(question.source).toBe("canned");
    expect(question.text).not.toBe("el modelo diría cualquier cosa aquí, se ignora");
  });

  it("cuando los obligatorios ya están completos pero falta un opcional, isComplete=true Y field apunta al opcional (no son excluyentes)", async () => {
    const provider = new FakeProvider();
    const question = await nextOnboardingQuestion(provider, READY_REQUIRED_STATE);
    expect(question.isComplete).toBe(true);
    expect(question.field).toBe("team");
  });
});

function applyField(state: OnboardingKnownState, field: (typeof REQUIRED_ONBOARDING_FIELDS)[number]): OnboardingKnownState {
  switch (field) {
    case "organization":
      return { ...state, hasOrganization: true };
    case "legalName":
      return { ...state, legalName: "Mi Empresa S.A. de C.V." };
    case "taxId":
      return { ...state, taxId: "MEM990101AB1" };
    case "sector":
      return { ...state, sector: "Construcción" };
    default:
      return state;
  }
}
