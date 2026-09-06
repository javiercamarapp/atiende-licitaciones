import { BudgetExceededError, InvalidAmountError } from "./errors.js";
import type { OrganizationId } from "./types.js";

/**
 * AG-08: valida que un monto sea un número finito y no negativo. Sin esto,
 * `-1000` pasaba `amountUsd > available` (incrementando el presupuesto
 * disponible en vez de gastarlo) y `NaN` pasaba silenciosamente (`NaN > x`
 * es siempre `false`), corrompiendo el ledger de forma permanente.
 * `Infinity` se rechaza también (no es un monto gastable real), salvo en
 * `setLimit()` donde representa deliberadamente "sin límite".
 */
function assertValidAmount(context: string, amount: number, options: { allowInfinity?: boolean } = {}): void {
  if (Number.isNaN(amount) || amount < 0) {
    throw new InvalidAmountError(context, amount);
  }
  if (!options.allowInfinity && !Number.isFinite(amount)) {
    throw new InvalidAmountError(context, amount);
  }
}

/**
 * Presupuesto/ledger por organización (REQ-128): reserva → consumo → límite,
 * rechaza si excede. En producción esto se respalda con
 * `llm_presupuesto_reserva` + `pg_advisory_xact_lock` (ver
 * docs/investigacion/likida-arquitectura.md); esta versión en memoria cubre
 * el contrato para packages/agents y sus pruebas.
 */
export interface BudgetReservation {
  id: string;
  organizationId: OrganizationId;
  reservedUsd: number;
  status: "reserved" | "consumed" | "released";
}

interface Ledger {
  limitUsd: number;
  reservedUsd: number;
  consumedUsd: number;
}

export class BudgetLedger {
  private readonly ledgers = new Map<string, Ledger>();
  private readonly reservations = new Map<string, BudgetReservation>();
  private counter = 0;

  private key(organizationId: OrganizationId): string {
    return organizationId ?? "platform";
  }

  private getOrCreateLedger(organizationId: OrganizationId): Ledger {
    const key = this.key(organizationId);
    let ledger = this.ledgers.get(key);
    if (!ledger) {
      ledger = { limitUsd: Number.POSITIVE_INFINITY, reservedUsd: 0, consumedUsd: 0 };
      this.ledgers.set(key, ledger);
    }
    return ledger;
  }

  setLimit(organizationId: OrganizationId, limitUsd: number): void {
    assertValidAmount("BudgetLedger.setLimit", limitUsd, { allowInfinity: true });
    this.getOrCreateLedger(organizationId).limitUsd = limitUsd;
  }

  getStatus(organizationId: OrganizationId): { limitUsd: number; reservedUsd: number; consumedUsd: number; availableUsd: number } {
    const ledger = this.getOrCreateLedger(organizationId);
    return {
      limitUsd: ledger.limitUsd,
      reservedUsd: ledger.reservedUsd,
      consumedUsd: ledger.consumedUsd,
      availableUsd: ledger.limitUsd - ledger.reservedUsd - ledger.consumedUsd,
    };
  }

  /** Reserva `amountUsd`; rechaza si excede el límite disponible. */
  reserve(organizationId: OrganizationId, amountUsd: number): BudgetReservation {
    assertValidAmount("BudgetLedger.reserve", amountUsd);
    const ledger = this.getOrCreateLedger(organizationId);
    const available = ledger.limitUsd - ledger.reservedUsd - ledger.consumedUsd;
    if (amountUsd > available) {
      throw new BudgetExceededError(organizationId, amountUsd, available);
    }
    ledger.reservedUsd += amountUsd;
    const id = `budget-${++this.counter}`;
    const reservation: BudgetReservation = { id, organizationId, reservedUsd: amountUsd, status: "reserved" };
    this.reservations.set(id, reservation);
    return reservation;
  }

  /** Convierte una reserva en consumo real (puede diferir del monto reservado). */
  consume(reservationId: string, actualUsd: number): void {
    assertValidAmount("BudgetLedger.consume", actualUsd);
    const reservation = this.mustGetReservation(reservationId);
    const ledger = this.getOrCreateLedger(reservation.organizationId);
    ledger.reservedUsd -= reservation.reservedUsd;
    ledger.consumedUsd += actualUsd;
    reservation.status = "consumed";
  }

  /** Libera una reserva sin consumirla (p. ej. la herramienta falló antes de gastar). */
  release(reservationId: string): void {
    const reservation = this.mustGetReservation(reservationId);
    if (reservation.status !== "reserved") return;
    const ledger = this.getOrCreateLedger(reservation.organizationId);
    ledger.reservedUsd -= reservation.reservedUsd;
    reservation.status = "released";
  }

  private mustGetReservation(reservationId: string): BudgetReservation {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw new Error(`Reserva de presupuesto desconocida: "${reservationId}"`);
    return reservation;
  }
}
