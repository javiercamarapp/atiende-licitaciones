import { describe, expect, it } from "vitest";
import { isCategoryEnabled } from "../../src/preferences/filter";

describe("isCategoryEnabled", () => {
  it("las categorías obligatorias (account_security/internal) siempre pasan, incluso sin preferencias", () => {
    expect(isCategoryEnabled("account_security", undefined)).toBe(true);
    expect(isCategoryEnabled("internal", { tenderMatches: false })).toBe(true);
  });

  it("una categoría opcional sin preferencias definidas pasa (default: mandar)", () => {
    expect(isCategoryEnabled("tender_matches", undefined)).toBe(true);
    expect(isCategoryEnabled("weekly_summary", {})).toBe(true);
  });

  it("una categoría opcional apagada explícitamente (false) se bloquea", () => {
    expect(isCategoryEnabled("tender_matches", { tenderMatches: false })).toBe(false);
    expect(isCategoryEnabled("deadlines", { deadlines: false })).toBe(false);
  });

  it("una categoría opcional encendida explícitamente (true) pasa", () => {
    expect(isCategoryEnabled("post_award", { postAward: true })).toBe(true);
  });

  it("apagar una categoría no afecta a las demás", () => {
    const preferences = { tenderMatches: false, weeklySummary: false };
    expect(isCategoryEnabled("approvals", preferences)).toBe(true);
    expect(isCategoryEnabled("document_expiration", preferences)).toBe(true);
  });
});
