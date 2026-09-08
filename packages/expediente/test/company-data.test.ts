import { describe, expect, it } from "vitest";
import { CompanyDataService, InMemoryCompanyDataResolver, isResolved, type ApprovedRate, type CompanyExperienceRecord } from "../src/company-data.js";

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

describe("CompanyDataService — EX-EXP-07: aserción runtime de moneda (REQ-160)", () => {
  it("lanza un error explícito si una tarifa llega con currency distinta de 'MXN' (p. ej. JSON no tipado de Postgres)", () => {
    // `ApprovedRate.currency` es "MXN" solo a nivel de TIPOS; un adaptador
    // real con JSON no tipado podría colar otro valor. Se simula con un
    // cast, exactamente el escenario que reprodujo la auditoría.
    const rateWithWrongCurrency = {
      id: "rate-1",
      companyId: "empresa-1",
      concept: "consultoria_hora",
      unit: "hora",
      unitPrice: "850.00",
      currency: "USD",
      approvalStatus: "aprobado",
      validFrom: "2026-01-01T00:00:00-06:00",
      validUntil: null,
    } as unknown as ApprovedRate;

    const resolver = new InMemoryCompanyDataResolver({ rates: [rateWithWrongCurrency] });
    const service = new CompanyDataService(resolver);
    expect(() => service.resolveApprovedRate("empresa-1", "consultoria_hora", ASOF)).toThrow(/MXN/);
  });
});

describe("CompanyDataService.resolveExperience — REQ-143: aserción runtime de evidenceDocId", () => {
  it("resuelve OK cuando evidenceDocId apunta a un documento real y existente en la bóveda documental", () => {
    const resolver = new InMemoryCompanyDataResolver({
      documents: [
        {
          id: "doc-evidencia-1",
          companyId: "empresa-1",
          type: "contrato_cliente",
          label: "Contrato con cliente X",
          issuedAt: "2025-01-01T00:00:00-06:00",
          expiresAt: null,
          approvalStatus: "aprobado",
        },
      ],
      experience: [
        {
          id: "exp-1",
          companyId: "empresa-1",
          description: "Mantenimiento industrial para cliente X",
          evidenceDocId: "doc-evidencia-1",
          approvalStatus: "aprobado",
        },
      ],
    });
    const service = new CompanyDataService(resolver);
    const result = service.resolveExperience("empresa-1", "exp-1");
    expect(result.status).toBe("ok");
    if (isResolved(result)) {
      expect(result.sourceRef.docId).toBe("doc-evidencia-1");
    }
  });

  it("bloquea (no resuelve OK) una experiencia cuyo evidenceDocId no corresponde a ningún documento de la bóveda documental", () => {
    // El documento referenciado nunca se cargó en el resolver (p. ej. se
    // borró, o nunca existió) -- `evidenceDocId` sigue siendo un `string`
    // válido a nivel de tipos, pero no hay evidencia REAL detrás.
    const resolver = new InMemoryCompanyDataResolver({
      documents: [],
      experience: [
        {
          id: "exp-1",
          companyId: "empresa-1",
          description: "Mantenimiento industrial para cliente X",
          evidenceDocId: "doc-que-no-existe",
          approvalStatus: "aprobado",
        },
      ],
    });
    const service = new CompanyDataService(resolver);
    const result = service.resolveExperience("empresa-1", "exp-1");
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reason).toBe("evidencia_no_verificable");
      expect(result.detail).toMatch(/doc-que-no-existe/);
    }
    expect(isResolved(result)).toBe(false);
  });

  it("bloquea una experiencia con evidenceDocId vacío colado por un payload que burla el tipo (as unknown as)", () => {
    // `CompanyExperienceRecord.evidenceDocId` es `string` NO opcional a
    // nivel de tipos -- pero un payload construido con un cast (el mismo
    // escenario que un JSON no tipado de Postgres, o un cuerpo HTTP
    // deserializado sin pasar por el schema de creación) puede colar una
    // cadena vacía sin que el compilador lo note.
    const experienceWithFabricatedEvidence = {
      id: "exp-1",
      companyId: "empresa-1",
      description: "Mantenimiento industrial para cliente X",
      evidenceDocId: "",
      approvalStatus: "aprobado",
    } as unknown as CompanyExperienceRecord;

    const resolver = new InMemoryCompanyDataResolver({
      documents: [],
      experience: [experienceWithFabricatedEvidence],
    });
    const service = new CompanyDataService(resolver);
    const result = service.resolveExperience("empresa-1", "exp-1");
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reason).toBe("evidencia_no_verificable");
    }
    expect(isResolved(result)).toBe(false);
  });

  it("bloquea una experiencia con evidenceDocId ausente (undefined) colado por un payload sin tipar", () => {
    const experienceWithMissingEvidence = {
      id: "exp-1",
      companyId: "empresa-1",
      description: "Mantenimiento industrial para cliente X",
      approvalStatus: "aprobado",
      // evidenceDocId deliberadamente ausente: un `JSON.parse` de una fila
      // de Postgres sin `evidence_ref`, o un objeto armado a mano, nunca
      // pasaría el tipo en tiempo de compilación, pero SÍ puede llegar así
      // en runtime.
    } as unknown as CompanyExperienceRecord;

    const resolver = new InMemoryCompanyDataResolver({
      documents: [],
      experience: [experienceWithMissingEvidence],
    });
    const service = new CompanyDataService(resolver);
    const result = service.resolveExperience("empresa-1", "exp-1");
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reason).toBe("evidencia_no_verificable");
    }
  });
});
