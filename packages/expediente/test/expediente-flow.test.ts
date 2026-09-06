import JSZip from "jszip";
import { beforeEach, describe, expect, it } from "vitest";
import { ApprovalWorkflow, resetApprovalCounters } from "../src/approval-workflow.js";
import { CompanyDataService, InMemoryCompanyDataResolver } from "../src/company-data.js";
import { EconomicProposalBuilder } from "../src/economic-proposal.js";
import { IntegrityChecklist, type IntegrityChecklistInput } from "../src/integrity-checklist.js";
import { PackageAssembler } from "../src/package-assembler.js";
import { ProposalVersionRegistry } from "../src/proposal-version.js";
import {
  RequirementMatrixBuilder,
  RuleBasedExtractor,
  resetRequirementCounters,
  type RequirementItem,
} from "../src/requirement-matrix.js";
import { TechnicalProposalBuilder, type RequirementFulfillmentMapping } from "../src/technical-proposal.js";

/**
 * Flujo integrado end-to-end del expediente de participación: bases →
 * matriz de requisitos → datos de empresa → propuesta técnica/económica →
 * checklist de integridad → aprobación por rol → paquete final (ZIP real).
 * Cubre A6-A15 de docs/ACEPTACION.md ejercitando el flujo completo, no
 * helpers aislados ni mocks de integración.
 */

const ASOF = "2026-10-20T12:00:00-06:00"; // fecha límite de entrega de proposiciones (el "acto")
const COMPANY_ID = "empresa-1";

function buildBasesDocument() {
  return {
    documentId: "bases-v1",
    documentLabel: "Bases de la licitación",
    publishedAt: "2026-08-01T00:00:00-06:00",
    pages: [
      {
        page: 1,
        text: [
          "La entrega de proposiciones será a más tardar el 20 de octubre de 2026 a las 12:00 horas.",
          "El licitante deberá presentar la opinión de cumplimiento 32-D vigente del SAT.",
          "Es obligatorio presentar el Anexo 3 (currículum de la empresa) debidamente firmado.",
          "El licitante deberá presentar cotización económica conforme a la cláusula 9.1.",
        ].join(" "),
      },
    ],
  };
}

function buildHealthyCompanyResolver() {
  return new InMemoryCompanyDataResolver({
    profiles: [{ companyId: COMPANY_ID, legalName: "Servicios Integrales del Bajío SA de CV", rfc: "SIB010101AB1", approvalStatus: "aprobado" }],
    documents: [
      {
        id: "doc-32d",
        companyId: COMPANY_ID,
        type: "opinion_32d",
        label: "Opinión de cumplimiento 32-D",
        issuedAt: "2026-09-01T00:00:00-06:00",
        expiresAt: "2026-12-01T00:00:00-06:00",
        approvalStatus: "aprobado",
      },
    ],
    capabilities: [
      {
        id: "cap-curriculum",
        companyId: COMPANY_ID,
        name: "curriculum_empresa",
        description: "10 años de experiencia en mantenimiento industrial.",
        evidenceDocId: "doc-curriculum",
        approvalStatus: "aprobado",
      },
    ],
    rates: [
      {
        id: "rate-consultoria",
        companyId: COMPANY_ID,
        concept: "consultoria_hora",
        unit: "hora",
        unitPrice: "850.00",
        currency: "MXN",
        approvalStatus: "aprobado",
        validFrom: "2026-01-01T00:00:00-06:00",
        validUntil: null,
      },
    ],
    signers: [{ id: "signer-1", companyId: COMPANY_ID, name: "Juana Pérez", role: "representante_legal", authorized: true }],
  });
}

function buildMatrixMappings(requirements: RequirementItem[]): RequirementFulfillmentMapping[] {
  const curriculumReq = requirements.find((r) => r.text.includes("Anexo 3"));
  const documentReq = requirements.find((r) => r.text.includes("32-D"));
  const mappings: RequirementFulfillmentMapping[] = [];
  if (curriculumReq) {
    mappings.push({
      requirementId: curriculumReq.id,
      kind: "capability",
      refKey: "curriculum_empresa",
      statementText: (value) => `Se anexa el currículum de la empresa: ${(value as { description: string }).description}`,
    });
  }
  if (documentReq) {
    mappings.push({
      requirementId: documentReq.id,
      kind: "document",
      refKey: "opinion_32d",
      statementText: (value) => `Se anexa la opinión de cumplimiento 32-D vigente, folio ${(value as { id: string }).id}.`,
    });
  }
  return mappings;
}

describe("Flujo integrado del expediente de participación (A6-A15)", () => {
  beforeEach(() => {
    resetRequirementCounters();
    resetApprovalCounters();
  });

  it("A13: expediente completo, aprobado y validado produce un paquete 'ready' descargable con manifiesto, checklist y evidencia (ZIP real leído de vuelta)", async () => {
    // 1. Matriz de requisitos desde las bases reales.
    const matrixBuilder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items: requirements, conflicts } = await matrixBuilder.build([buildBasesDocument()]);
    expect(conflicts).toHaveLength(0);

    // 2. Datos de empresa APROBADOS y vigentes.
    const companyService = new CompanyDataService(buildHealthyCompanyResolver());

    // 3. Propuesta técnica trazable.
    const technicalBuilder = new TechnicalProposalBuilder(companyService);
    const mappings = buildMatrixMappings(requirements);
    const technical = technicalBuilder.build(COMPANY_ID, requirements, mappings, ASOF);
    expect(technical.blockers).toHaveLength(0);
    for (const section of technical.sections) {
      for (const statement of section.statements) {
        expect(statement.sourceRef.kind).toBe("company_data");
      }
    }

    // 4. Propuesta económica determinista.
    const economicBuilder = new EconomicProposalBuilder(companyService, { ivaRate: 0.16 });
    const economic = economicBuilder.build(COMPANY_ID, [{ concept: "consultoria_hora", quantity: 20 }], ASOF);
    expect(economic.totals).not.toBeNull();

    // 5. Versionado con hash de insumos.
    const versions = new ProposalVersionRegistry();
    const version = versions.createVersion({
      requirements,
      technical,
      economicTotals: economic.totals,
    });
    expect(version.version).toBe(1);
    expect(version.inputs.length).toBeGreaterThan(0);

    // 6. Checklist de integridad — todas las dimensiones en verde.
    const checklistInput: IntegrityChecklistInput = {
      files: [
        { filename: "propuesta_tecnica.pdf", extension: "pdf", sizeBytes: 500_000 },
        { filename: "propuesta_economica.pdf", extension: "pdf", sizeBytes: 200_000 },
      ],
      formatLimits: { allowedExtensions: ["pdf", "xlsx"], maxFileSizeBytes: 10_000_000, maxUploadSlots: 10 },
      requiredSignatures: [{ role: "representante_legal", userConfirmedSigned: true }],
      requiredAnnexes: requirements.filter((r) => r.type === "anexo" && r.obligatoriedad === "obligatorio"),
      presentAnnexRefs: requirements.filter((r) => r.type === "anexo").map((r) => r.topicKey ?? r.id),
      documentsToValidate: buildHealthyCompanyResolver()
        .getDocuments(COMPANY_ID)
        .map((document) => ({ document, asOfIso: ASOF })),
      economicResult: economic,
      crossDocumentTotals: [
        { documentLabel: "carta_propuesta", total: economic.totals!.total },
        { documentLabel: "anexo_economico", total: economic.totals!.total },
      ],
    };
    const checklist = new IntegrityChecklist().run(checklistInput);
    expect(checklist.overallStatus).toBe("verde");

    // 7. Aprobación por rol (reviewer, distinto de quien redactó/envió).
    const workflow = new ApprovalWorkflow();
    workflow.requestReview({ scopeRef: "expediente", actorId: "user-licitador", actorRole: "writer" });
    const approvalResult = workflow.approve({
      scope: "expediente",
      scopeRef: "expediente",
      actorId: "user-legal-reviewer",
      actorRole: "reviewer",
      inputsHash: version.hash,
    });
    expect(approvalResult.ok).toBe(true);
    expect(workflow.isFullyApproved()).toBe(true);

    // 8. Ensamblado del paquete final: debe quedar "ready". Antes de
    // ensamblar, se revalida la aprobación contra el hash ACTUAL (aquí no
    // cambió nada, así que no invalida nada) — este es el paso que
    // `apps/api` debe llamar en cada evaluación (REQ-162/EX-EXP-01).
    expect(workflow.isFullyApprovedForCurrentHash(version.hash)).toBe(true);
    const assembler = new PackageAssembler();
    const { manifest, zip, suggestedFileName } = await assembler.assemble({
      expedienteId: "expediente-2026-001",
      documents: [
        { documentId: "tecnica", label: "Propuesta técnica", required: true, filename: "propuesta_tecnica.pdf", content: JSON.stringify(technical), version: version.version },
        { documentId: "economica", label: "Propuesta económica", required: true, filename: "propuesta_economica.pdf", content: economic.anexoText!, version: version.version },
      ],
      checklist,
      approvals: workflow.listApprovals(),
      currentInputsHash: version.hash,
    });

    expect(manifest.status).toBe("ready");
    expect(manifest.missing).toHaveLength(0);
    expect(manifest.notice).toContain("no envía ofertas");
    expect(suggestedFileName).not.toContain("BORRADOR");

    // Verificación real de que el ZIP se puede leer de vuelta (no solo que se generó un buffer).
    const loadedZip = await JSZip.loadAsync(zip);
    const manifestBack = JSON.parse(await loadedZip.file("manifiesto.json")!.async("string"));
    expect(manifestBack.status).toBe("ready");
    expect(manifestBack.documents).toHaveLength(2);
    const checklistBack = JSON.parse(await loadedZip.file("checklist.json")!.async("string"));
    expect(checklistBack.overallStatus).toBe("verde");
    expect(Object.keys(loadedZip.files)).toEqual(expect.arrayContaining(["propuesta_tecnica.pdf", "propuesta_economica.pdf"]));
  });

  it("A14/A9: un anexo obligatorio faltante deja el checklist y el paquete en 'draft', nunca 'ready'", async () => {
    const matrixBuilder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items: requirements } = await matrixBuilder.build([buildBasesDocument()]);
    const companyService = new CompanyDataService(buildHealthyCompanyResolver());
    const economicBuilder = new EconomicProposalBuilder(companyService, { ivaRate: 0.16 });
    const economic = economicBuilder.build(COMPANY_ID, [{ concept: "consultoria_hora", quantity: 20 }], ASOF);

    const checklist = new IntegrityChecklist().run({
      files: [{ filename: "propuesta_tecnica.pdf", extension: "pdf", sizeBytes: 500_000 }],
      formatLimits: { allowedExtensions: ["pdf"], maxFileSizeBytes: 10_000_000, maxUploadSlots: 10 },
      requiredSignatures: [{ role: "representante_legal", userConfirmedSigned: true }],
      requiredAnnexes: requirements.filter((r) => r.type === "anexo" && r.obligatoriedad === "obligatorio"),
      presentAnnexRefs: [], // el Anexo 3 NO está presente
      documentsToValidate: [],
      economicResult: economic,
      crossDocumentTotals: [{ documentLabel: "carta", total: economic.totals!.total }],
    });

    expect(checklist.overallStatus).toBe("rojo");
    expect(checklist.items.find((i) => i.dimension === "anexos_obligatorios")?.status).toBe("rojo");

    const workflow = new ApprovalWorkflow();
    workflow.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: "h" });

    const assembler = new PackageAssembler();
    const { manifest, zip } = await assembler.assemble({
      expedienteId: "expediente-incompleto",
      documents: [{ documentId: "tecnica", label: "Propuesta técnica", required: true, filename: "tecnica.pdf", content: "x" }],
      checklist,
      approvals: workflow.listApprovals(),
      currentInputsHash: "h",
    });

    expect(manifest.status).toBe("draft");
    expect(manifest.watermark).toBe("BORRADOR");
    const loaded = await JSZip.loadAsync(zip);
    expect(Object.keys(loaded.files).some((f) => f.startsWith("BORRADOR_"))).toBe(true);
  });

  it("A7/A9 combinados: documento vencido bloquea la propuesta técnica y el checklist de vigencias, aun con todo lo demás correcto", async () => {
    const resolverConVencido = new InMemoryCompanyDataResolver({
      documents: [
        {
          id: "doc-32d-vencido",
          companyId: COMPANY_ID,
          type: "opinion_32d",
          label: "Opinión de cumplimiento 32-D",
          issuedAt: "2026-01-01T00:00:00-06:00",
          expiresAt: "2026-10-01T00:00:00-06:00", // vence antes del acto (20 de octubre)
          approvalStatus: "aprobado",
        },
      ],
      capabilities: [
        { id: "cap-curriculum", companyId: COMPANY_ID, name: "curriculum_empresa", description: "desc", evidenceDocId: "doc-curriculum", approvalStatus: "aprobado" },
      ],
    });
    const companyService = new CompanyDataService(resolverConVencido);
    const matrixBuilder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items: requirements } = await matrixBuilder.build([buildBasesDocument()]);
    const mappings = buildMatrixMappings(requirements);

    const technical = new TechnicalProposalBuilder(companyService).build(COMPANY_ID, requirements, mappings, ASOF);
    expect(technical.blockers.length).toBeGreaterThan(0);
    expect(technical.blockers.some((b) => b.field === "documento:opinion_32d")).toBe(true);

    const checklist = new IntegrityChecklist().run({
      files: [],
      formatLimits: { allowedExtensions: ["pdf"], maxFileSizeBytes: 10_000_000, maxUploadSlots: 10 },
      requiredSignatures: [],
      requiredAnnexes: [],
      presentAnnexRefs: [],
      documentsToValidate: [{ document: resolverConVencido.getDocuments(COMPANY_ID)[0], asOfIso: ASOF }],
      economicResult: null,
      crossDocumentTotals: [],
    });
    expect(checklist.items.find((i) => i.dimension === "vigencias")?.status).toBe("rojo");
    expect(checklist.overallStatus).toBe("rojo");
  });
});
