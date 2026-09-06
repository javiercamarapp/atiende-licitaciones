/**
 * EconomicProposalBuilder (REQ-029/REQ-157/REQ-164): cálculo económico
 * 100% determinista sobre tarifas APROBADAS y vigentes a la fecha del acto.
 * Una tarifa no aprobada o vencida se rechaza (bloqueo), nunca se usa un
 * precio "de todos modos". Genera el mismo objeto de totales para la carta
 * y el anexo económico, garantizando consistencia estructural entre ambos
 * documentos (REQ-160 "consistencia cruzada").
 */
import type { CompanyDataService } from "./company-data.js";
import { isResolved } from "./company-data.js";
import { addCents, fromCents, multiplyQuantityHalfUp, multiplyRateHalfUp, sumCents, toCents, type DecimalString } from "./money.js";
import { centsToPesosWords } from "./number-to-words.js";
import type { SourceRef } from "./types.js";

export interface EconomicLineItemRequest {
  requirementId?: string;
  concept: string;
  quantity: number;
}

export interface EconomicLineItemResolved {
  concept: string;
  quantity: number;
  unitPriceCents: bigint;
  subtotalCents: bigint;
  sourceRef: SourceRef;
}

export interface EconomicLineItemBlocked {
  concept: string;
  status: "missing" | "blocked";
  detail: string;
}

export interface EconomicTotals {
  currency: "MXN";
  subtotal: DecimalString;
  ivaRate: number;
  iva: DecimalString;
  total: DecimalString;
  totalInWords: string;
}

export interface EconomicProposalResult {
  lineItems: EconomicLineItemResolved[];
  blockedLineItems: EconomicLineItemBlocked[];
  totals: EconomicTotals | null;
  /** Mismo objeto `totals` reflejado en dos "documentos" (carta y anexo) para probar consistencia estructural, no solo textual. */
  cartaText: string | null;
  anexoText: string | null;
}

export interface EconomicProposalConfig {
  ivaRate: number; // p. ej. 0.16
  /** Cota superior aceptada para `ivaRate` (por defecto `DEFAULT_MAX_IVA_RATE`); ajustable solo cuando el llamador lo justifique explícitamente. */
  maxIvaRate?: number;
}

/** Cota superior por defecto para `ivaRate` (EX-EXP-07): cubre IVA general (16%) y tasas reducidas/especiales razonables, sin permitir errores de unidades (p. ej. "16" en vez de "0.16") o tasas absurdas (250%). */
export const DEFAULT_MAX_IVA_RATE = 0.3;

/** Valida que `ivaRate` sea una tasa fraccionaria razonable en `[0, maxRate]` (EX-EXP-07): rechaza negativos, tasas > 100% y errores de unidades clásicos (16 en vez de 0.16). */
export function assertValidIvaRate(ivaRate: number, maxRate: number = DEFAULT_MAX_IVA_RATE): void {
  if (!Number.isFinite(ivaRate) || ivaRate < 0 || ivaRate > maxRate) {
    throw new Error(
      `ivaRate fuera de rango válido [0, ${maxRate}]: ${ivaRate}. Verifique que no sea un error de unidades (p. ej. "16" en vez de "0.16") ni una tasa absurda.`,
    );
  }
}

export class EconomicProposalBuilder {
  constructor(
    private readonly companyData: CompanyDataService,
    private readonly config: EconomicProposalConfig,
  ) {
    assertValidIvaRate(config.ivaRate, config.maxIvaRate ?? DEFAULT_MAX_IVA_RATE);
  }

  build(companyId: string, requests: EconomicLineItemRequest[], asOfIso: string): EconomicProposalResult {
    const lineItems: EconomicLineItemResolved[] = [];
    const blockedLineItems: EconomicLineItemBlocked[] = [];

    for (const request of requests) {
      const resolution = this.companyData.resolveApprovedRate(companyId, request.concept, asOfIso);
      if (!isResolved(resolution)) {
        blockedLineItems.push({
          concept: request.concept,
          status: resolution.status,
          detail: resolution.status === "missing" ? `No hay tarifa registrada para "${request.concept}".` : resolution.detail,
        });
        continue;
      }

      const rate = resolution.value;
      const unitPriceCents = toCents(rate.unitPrice);
      const subtotalCents = multiplyQuantityHalfUp(unitPriceCents, request.quantity);
      lineItems.push({
        concept: request.concept,
        quantity: request.quantity,
        unitPriceCents,
        subtotalCents,
        sourceRef: { kind: "company_data", refId: resolution.sourceRef.docId, capturedAt: resolution.sourceRef.capturedAt },
      });
    }

    if (blockedLineItems.length > 0 || lineItems.length === 0) {
      // Regla dura: si CUALQUIER concepto solicitado no resuelve a una tarifa
      // aprobada y vigente, la propuesta económica completa queda sin totales
      // (nunca un total parcial que omita en silencio el concepto bloqueado).
      return { lineItems, blockedLineItems, totals: null, cartaText: null, anexoText: null };
    }

    const subtotalCents = sumCents(lineItems.map((li) => li.subtotalCents));
    const ivaCents = multiplyRateHalfUp(subtotalCents, this.config.ivaRate);
    const totalCents = addCents(subtotalCents, ivaCents);

    const totals: EconomicTotals = {
      currency: "MXN",
      subtotal: fromCents(subtotalCents),
      ivaRate: this.config.ivaRate,
      iva: fromCents(ivaCents),
      total: fromCents(totalCents),
      totalInWords: centsToPesosWords(totalCents),
    };

    return {
      lineItems,
      blockedLineItems,
      totals,
      cartaText: renderCartaText(totals),
      anexoText: renderAnexoText(lineItems, totals),
    };
  }
}

function renderCartaText(totals: EconomicTotals): string {
  return [
    `Manifiesto bajo protesta de decir verdad que el importe total de mi propuesta es de $${totals.total} ${totals.currency} (IVA incluido).`,
    totals.totalInWords,
  ].join("\n");
}

function renderAnexoText(lineItems: EconomicLineItemResolved[], totals: EconomicTotals): string {
  const rows = lineItems
    .map((li) => `${li.concept} | cantidad: ${li.quantity} | precio unitario: $${fromCents(li.unitPriceCents)} | subtotal: $${fromCents(li.subtotalCents)}`)
    .join("\n");
  return [
    rows,
    `Subtotal: $${totals.subtotal}`,
    `IVA (${(totals.ivaRate * 100).toFixed(0)}%): $${totals.iva}`,
    `Total: $${totals.total} ${totals.currency}`,
    totals.totalInWords,
  ].join("\n");
}
