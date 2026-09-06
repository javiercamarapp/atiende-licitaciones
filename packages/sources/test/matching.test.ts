import { describe, expect, it } from "vitest";
import { MatchingEngine } from "../src/matching/matching-engine.js";
import type { OrganizationProfile } from "../src/matching/types.js";
import { parseTenderRecord, type TenderRecord } from "../src/types/tender-record.js";

function record(overrides: Record<string, unknown> = {}): TenderRecord {
  return parseTenderRecord({
    source: "ocds-shcp",
    externalId: "T-1",
    title: "Adquisición de equipo de cómputo para escuelas rurales",
    contractingEntity: "Secretaría de Educación Pública",
    procedureType: "licitacion_publica",
    classifiers: [{ scheme: "UNSPSC", code: "43211500" }],
    budgetAmount: 2_000_000,
    currency: "MXN",
    dates: {},
    status: "published",
    attachments: [],
    state: "Puebla",
    snapshot: { fetchedAt: new Date(), rawHash: "a".repeat(64) },
    ...overrides,
  });
}

describe("MatchingEngine", () => {
  const engine = new MatchingEngine();

  it("perfil sin ningún criterio configurado da score 0 con explicación clara", () => {
    const result = engine.score(record(), { id: "org-1" });
    expect(result.score).toBe(0);
    expect(result.criteria[0].explanation).toMatch(/no define ningún criterio/i);
  });

  it("coincidencia total en todos los criterios configurados da score 100", () => {
    const profile: OrganizationProfile = {
      id: "org-1",
      classifierCodes: ["43211500"],
      keywords: ["equipo de cómputo"],
      entities: ["Secretaría de Educación"],
      budgetRange: { min: 1_000_000, max: 3_000_000 },
      states: ["Puebla"],
    };
    const result = engine.score(record(), profile);
    expect(result.score).toBe(100);
    expect(result.criteria).toHaveLength(5);
    for (const c of result.criteria) expect(c.score).toBeCloseTo(c.maxScore, 5);
  });

  it("ningún criterio configurado coincide da score 0 (no negativo)", () => {
    const profile: OrganizationProfile = {
      id: "org-1",
      classifierCodes: ["99999999"],
      keywords: ["construcción de carreteras"],
      entities: ["Petróleos Mexicanos"],
      budgetRange: { min: 10_000_000 },
      states: ["Sonora"],
    };
    const result = engine.score(record(), profile);
    expect(result.score).toBe(0);
  });

  it("solo redistribuye el peso entre los criterios configurados: un solo criterio coincidente da 100", () => {
    const profile: OrganizationProfile = { id: "org-1", keywords: ["equipo de cómputo"] };
    const result = engine.score(record(), profile);
    expect(result.score).toBe(100);
    expect(result.criteria).toHaveLength(1);
  });

  it("presupuesto ausente en la convocatoria da score neutro (no penaliza ni favorece)", () => {
    const profile: OrganizationProfile = { id: "org-1", budgetRange: { min: 1, max: 2 } };
    const result = engine.score(record({ budgetAmount: undefined }), profile);
    expect(result.score).toBe(50);
    expect(result.criteria[0].explanation).toMatch(/no disponible/i);
  });

  it("clasificador coincide por prefijo jerárquico del catálogo", () => {
    const profile: OrganizationProfile = { id: "org-1", classifierCodes: ["432115"] };
    const result = engine.score(record(), profile);
    expect(result.score).toBe(100);
  });

  it("palabra clave excluida anula el match aunque el resto coincida perfectamente", () => {
    const profile: OrganizationProfile = {
      id: "org-1",
      keywords: ["equipo de cómputo"],
      excludedKeywords: ["escuelas rurales"],
    };
    const result = engine.score(record(), profile);
    expect(result.score).toBe(0);
    expect(result.criteria.some((c) => c.score < 0)).toBe(true);
  });

  it("es determinista: mismo record y perfil producen siempre el mismo resultado", () => {
    const profile: OrganizationProfile = { id: "org-1", keywords: ["cómputo"], states: ["Puebla"] };
    const r1 = engine.score(record(), profile);
    const r2 = engine.score(record(), profile);
    expect(r1).toEqual(r2);
  });

  it("estado ausente en la convocatoria da score neutro para el criterio de estados", () => {
    const profile: OrganizationProfile = { id: "org-1", states: ["Jalisco"] };
    const result = engine.score(record({ state: undefined }), profile);
    expect(result.score).toBe(50);
  });

  it("respeta pesos personalizados pasados al constructor", () => {
    const customEngine = new MatchingEngine({ keywords: 100, classifiers: 0, budget: 0, entities: 0, states: 0 });
    const profile: OrganizationProfile = { id: "org-1", keywords: ["cómputo"], entities: ["No existe"] };
    const result = customEngine.score(record(), profile);
    // keywords pesa 100/100 tras la redistribución (entities pesa 0): coincide keywords, entities no coincide pero no resta.
    expect(result.score).toBe(100);
  });
});
