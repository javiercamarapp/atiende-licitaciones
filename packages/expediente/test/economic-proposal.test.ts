import { describe, expect, it } from "vitest";
import { CompanyDataService, InMemoryCompanyDataResolver } from "../src/company-data.js";
import { EconomicProposalBuilder } from "../src/economic-proposal.js";

const ASOF = "2026-10-20T12:00:00-06:00";

function buildResolver() {
  return new InMemoryCompanyDataResolver({
    rates: [
      {
        id: "rate-consultoria",
        companyId: "empresa-1",
        concept: "consultoria_hora",
        unit: "hora",
        unitPrice: "850.00",
        currency: "MXN",
        approvalStatus: "aprobado",
        validFrom: "2026-01-01T00:00:00-06:00",
        validUntil: null,
      },
      {
        id: "rate-viaticos",
        companyId: "empresa-1",
        concept: "viaticos",
        unit: "servicio",
        unitPrice: "1200.50",
        currency: "MXN",
        approvalStatus: "aprobado",
        validFrom: "2026-01-01T00:00:00-06:00",
        validUntil: null,
      },
      {
        id: "rate-pendiente",
        companyId: "empresa-1",
        concept: "capacitacion",
        unit: "curso",
        unitPrice: "5000.00",
        currency: "MXN",
        approvalStatus: "pendiente_aprobacion",
        validFrom: "2026-01-01T00:00:00-06:00",
        validUntil: null,
      },
    ],
  });
}

describe("EconomicProposalBuilder (A10 cálculo económico, REQ-029/REQ-030/REQ-160)", () => {
  it("calcula subtotal, IVA 16% y total de forma determinista con redondeo half-up", () => {
    const service = new CompanyDataService(buildResolver());
    const builder = new EconomicProposalBuilder(service, { ivaRate: 0.16 });

    const result = builder.build(
      "empresa-1",
      [
        { concept: "consultoria_hora", quantity: 40 },
        { concept: "viaticos", quantity: 2 },
      ],
      ASOF,
    );

    expect(result.blockedLineItems).toHaveLength(0);
    expect(result.totals).not.toBeNull();
    // 40 * 850.00 = 34000.00 ; 2 * 1200.50 = 2401.00 ; subtotal = 36401.00
    expect(result.totals?.subtotal).toBe("36401.00");
    // IVA 16% de 36401.00 = 5824.16
    expect(result.totals?.iva).toBe("5824.16");
    expect(result.totals?.total).toBe("42225.16");
    expect(result.totals?.totalInWords).toContain("SON:");
    expect(result.totals?.totalInWords).toContain("16/100");
  });

  it("la carta y el anexo económico reflejan el mismo total (consistencia cruzada, REQ-160)", () => {
    const service = new CompanyDataService(buildResolver());
    const builder = new EconomicProposalBuilder(service, { ivaRate: 0.16 });
    const result = builder.build("empresa-1", [{ concept: "consultoria_hora", quantity: 10 }], ASOF);

    expect(result.cartaText).toContain(result.totals!.total);
    expect(result.anexoText).toContain(result.totals!.total);
  });

  it("es reproducible: misma entrada produce exactamente el mismo resultado", () => {
    const service = new CompanyDataService(buildResolver());
    const builder = new EconomicProposalBuilder(service, { ivaRate: 0.16 });
    const requests = [{ concept: "consultoria_hora", quantity: 7 }];
    const r1 = builder.build("empresa-1", requests, ASOF);
    const r2 = builder.build("empresa-1", requests, ASOF);
    expect(r1.totals).toEqual(r2.totals);
  });
});

describe("EconomicProposalBuilder (A8 precio no aprobado, REQ-157/REQ-164)", () => {
  it("rechaza de punta a punta un concepto con tarifa pendiente de aprobación: no hay total parcial que lo omita en silencio", () => {
    const service = new CompanyDataService(buildResolver());
    const builder = new EconomicProposalBuilder(service, { ivaRate: 0.16 });

    const result = builder.build(
      "empresa-1",
      [
        { concept: "consultoria_hora", quantity: 10 },
        { concept: "capacitacion", quantity: 1 }, // pendiente_aprobacion
      ],
      ASOF,
    );

    expect(result.blockedLineItems).toHaveLength(1);
    expect(result.blockedLineItems[0].concept).toBe("capacitacion");
    // Regla dura: ante cualquier bloqueo, NO se genera un total parcial.
    expect(result.totals).toBeNull();
    expect(result.cartaText).toBeNull();
    expect(result.anexoText).toBeNull();
  });

  it("rechaza un concepto sin tarifa registrada en absoluto (dato ausente)", () => {
    const service = new CompanyDataService(buildResolver());
    const builder = new EconomicProposalBuilder(service, { ivaRate: 0.16 });
    const result = builder.build("empresa-1", [{ concept: "concepto_inexistente", quantity: 1 }], ASOF);
    expect(result.blockedLineItems[0].status).toBe("missing");
    expect(result.totals).toBeNull();
  });
});
