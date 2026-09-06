import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../src/budget-ledger.js";
import { BudgetExceededError } from "../src/errors.js";

describe("BudgetLedger", () => {
  it("reserva y consume dentro del límite configurado", () => {
    const ledger = new BudgetLedger();
    ledger.setLimit("org-1", 10);

    const reservation = ledger.reserve("org-1", 4);
    expect(ledger.getStatus("org-1")).toMatchObject({ limitUsd: 10, reservedUsd: 4, consumedUsd: 0, availableUsd: 6 });

    ledger.consume(reservation.id, 3.5);
    expect(ledger.getStatus("org-1")).toMatchObject({ reservedUsd: 0, consumedUsd: 3.5, availableUsd: 6.5 });
  });

  it("rechaza una reserva que excede el presupuesto disponible", () => {
    const ledger = new BudgetLedger();
    ledger.setLimit("org-1", 5);
    ledger.reserve("org-1", 4);

    expect(() => ledger.reserve("org-1", 2)).toThrow(BudgetExceededError);
    expect(ledger.getStatus("org-1").reservedUsd).toBe(4); // la reserva rechazada no debe afectar el ledger
  });

  it("libera una reserva sin consumirla", () => {
    const ledger = new BudgetLedger();
    ledger.setLimit("org-1", 5);
    const reservation = ledger.reserve("org-1", 4);
    ledger.release(reservation.id);
    expect(ledger.getStatus("org-1")).toMatchObject({ reservedUsd: 0, consumedUsd: 0, availableUsd: 5 });

    // liberar de nuevo (paso ya liberado) no debe duplicar el crédito disponible
    ledger.release(reservation.id);
    expect(ledger.getStatus("org-1").availableUsd).toBe(5);
  });

  it("aísla el presupuesto por organización", () => {
    const ledger = new BudgetLedger();
    ledger.setLimit("org-1", 10);
    ledger.setLimit("org-2", 1);

    ledger.reserve("org-1", 8);
    expect(() => ledger.reserve("org-2", 8)).toThrow(BudgetExceededError);
    expect(ledger.getStatus("org-2").availableUsd).toBe(1);
  });

  it("trata organizationId null como su propio ledger de plataforma", () => {
    const ledger = new BudgetLedger();
    ledger.setLimit(null, 2);
    ledger.reserve(null, 2);
    expect(() => ledger.reserve(null, 0.01)).toThrow(BudgetExceededError);
  });

  it("sin límite configurado el disponible es ilimitado (no rechaza)", () => {
    const ledger = new BudgetLedger();
    expect(() => ledger.reserve("org-nuevo", 1_000_000)).not.toThrow();
  });

  it("el error incluye organización, monto solicitado y disponible", () => {
    const ledger = new BudgetLedger();
    ledger.setLimit("org-1", 1);
    try {
      ledger.reserve("org-1", 5);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BudgetExceededError);
      const budgetError = error as BudgetExceededError;
      expect(budgetError.organizationId).toBe("org-1");
      expect(budgetError.requestedUsd).toBe(5);
      expect(budgetError.availableUsd).toBe(1);
    }
  });
});
