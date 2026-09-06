import { describe, expect, it } from "vitest";
import { CompanyDataService, InMemoryCompanyDataResolver, isResolved } from "../src/company-data.js";

const ASOF = "2026-10-20T12:00:00-06:00"; // fecha límite del acto (no "hoy")

describe("CompanyDataService (A6 dato ausente, REQ-158/REQ-166)", () => {
  it("reporta 'missing' explícito cuando el campo no existe, nunca infiere un valor", () => {
    const resolver = new InMemoryCompanyDataResolver({});
    const service = new CompanyDataService(resolver);

    const result = service.resolveDocumentByType("empresa-1", "opinion_32d", ASOF);
    expect(result.status).toBe("missing");
    if (result.status === "missing") {
      expect(result.field).toBe("documento:opinion_32d");
    }
    expect(isResolved(result)).toBe(false);
  });

  it("nunca produce status 'ok' cuando falta la referencia de fuente aprobada (no hay valor inventado)", () => {
    const resolver = new InMemoryCompanyDataResolver({
      capabilities: [
        { id: "cap-1", companyId: "empresa-1", name: "mantenimiento_industrial", description: "desc", approvalStatus: "pendiente_aprobacion" },
      ],
    });
    const service = new CompanyDataService(resolver);
    const result = service.resolveCapability("empresa-1", "mantenimiento_industrial");
    expect(result.status).toBe("blocked");
  });
});

describe("CompanyDataService (A7 documento vencido, REQ-022/REQ-023/REQ-143)", () => {
  it("bloquea un documento vencido a la fecha del acto, aunque siga vigente 'hoy'", () => {
    const resolver = new InMemoryCompanyDataResolver({
      documents: [
        {
          id: "doc-1",
          companyId: "empresa-1",
          type: "opinion_32d",
          label: "Opinión de cumplimiento 32-D",
          issuedAt: "2026-09-01T00:00:00-06:00",
          expiresAt: "2026-10-01T00:00:00-06:00", // vence antes del acto (2026-10-20)
          approvalStatus: "aprobado",
        },
      ],
    });
    const service = new CompanyDataService(resolver);
    const result = service.resolveDocumentByType("empresa-1", "opinion_32d", ASOF);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reason).toBe("documento_vencido");
    }
  });

  it("resuelve OK con source_ref cuando el documento está vigente a la fecha del acto", () => {
    const resolver = new InMemoryCompanyDataResolver({
      documents: [
        {
          id: "doc-1",
          companyId: "empresa-1",
          type: "opinion_32d",
          label: "Opinión de cumplimiento 32-D",
          issuedAt: "2026-09-01T00:00:00-06:00",
          expiresAt: "2026-11-01T00:00:00-06:00",
          approvalStatus: "aprobado",
        },
      ],
    });
    const service = new CompanyDataService(resolver);
    const result = service.resolveDocumentByType("empresa-1", "opinion_32d", ASOF);
    expect(result.status).toBe("ok");
    if (isResolved(result)) {
      expect(result.sourceRef.docId).toBe("doc-1");
    }
  });
});

describe("CompanyDataService (A8 precio no aprobado, REQ-029/REQ-157/REQ-164)", () => {
  it("bloquea una tarifa en estado pendiente_aprobacion", () => {
    const resolver = new InMemoryCompanyDataResolver({
      rates: [
        {
          id: "rate-1",
          companyId: "empresa-1",
          concept: "consultoria_hora",
          unit: "hora",
          unitPrice: "850.00",
          currency: "MXN",
          approvalStatus: "pendiente_aprobacion",
          validFrom: "2026-01-01T00:00:00-06:00",
          validUntil: null,
        },
      ],
    });
    const service = new CompanyDataService(resolver);
    const result = service.resolveApprovedRate("empresa-1", "consultoria_hora", ASOF);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") expect(result.reason).toBe("tarifa_no_aprobada");
  });

  it("bloquea una tarifa aprobada pero vencida a la fecha del acto", () => {
    const resolver = new InMemoryCompanyDataResolver({
      rates: [
        {
          id: "rate-1",
          companyId: "empresa-1",
          concept: "consultoria_hora",
          unit: "hora",
          unitPrice: "850.00",
          currency: "MXN",
          approvalStatus: "aprobado",
          validFrom: "2026-01-01T00:00:00-06:00",
          validUntil: "2026-09-01T00:00:00-06:00",
        },
      ],
    });
    const service = new CompanyDataService(resolver);
    const result = service.resolveApprovedRate("empresa-1", "consultoria_hora", ASOF);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") expect(result.reason).toBe("tarifa_vencida");
  });
});
