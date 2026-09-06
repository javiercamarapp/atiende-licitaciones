import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { PackageAssembler, USER_RESPONSIBILITY_NOTICE, type AssembleInput } from "../src/package-assembler.js";
import type { ChecklistReport } from "../src/integrity-checklist.js";
import type { Approval } from "../src/approval-workflow.js";
import { fakeHashedInputs } from "./helpers/hashed-inputs.js";

/** EX-EXP-17: `Approval.inputsHash`/`AssembleInput.currentInputsHash` ya no son un `string` plano — se derivan de un `HashedInputs` sellado real. */
const HASH_1 = fakeHashedInputs("hash-1");

const GREEN_CHECKLIST: ChecklistReport = {
  overallStatus: "verde",
  items: [
    { dimension: "formatos", status: "verde", detail: "ok", evidence: [] },
    { dimension: "limites", status: "verde", detail: "ok", evidence: [] },
    { dimension: "firmas", status: "verde", detail: "ok", evidence: [] },
    { dimension: "anexos_obligatorios", status: "verde", detail: "ok", evidence: [] },
    { dimension: "vigencias", status: "verde", detail: "ok", evidence: [] },
    { dimension: "calculos_economicos", status: "verde", detail: "ok", evidence: [] },
    { dimension: "consistencia_cruzada", status: "verde", detail: "ok", evidence: [] },
  ],
};

const RED_CHECKLIST: ChecklistReport = {
  ...GREEN_CHECKLIST,
  overallStatus: "rojo",
  items: GREEN_CHECKLIST.items.map((i) => (i.dimension === "anexos_obligatorios" ? { ...i, status: "rojo" as const } : i)),
};

function approvalVigente(scope: Approval["scope"] = "expediente"): Approval {
  return {
    id: "approval-1",
    scope,
    scopeRef: scope === "expediente" ? "expediente" : "documento:tecnica",
    approvedBy: "user-reviewer",
    approvedByRole: "reviewer",
    approvedAt: "2026-10-01T00:00:00-06:00",
    inputsHash: HASH_1.hash,
    status: "vigente",
  };
}

function baseInput(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    expedienteId: "exp-1",
    documents: [
      { documentId: "tecnica", label: "Propuesta técnica", required: true, filename: "tecnica.pdf", content: "contenido técnico", version: 1 },
      { documentId: "economica", label: "Propuesta económica", required: true, filename: "economica.pdf", content: "contenido económico", version: 1 },
    ],
    checklist: GREEN_CHECKLIST,
    approvals: [approvalVigente()],
    currentInputsHash: HASH_1,
    ...overrides,
  };
}

describe("PackageAssembler — A13 expediente completo descargable (REQ-048/REQ-159/REQ-161/REQ-163)", () => {
  it("genera manifiesto 'ready' y un ZIP real que se puede leer de vuelta con manifiesto, checklist y evidencia", async () => {
    const assembler = new PackageAssembler();
    const { manifest, zip, suggestedFileName } = await assembler.assemble(baseInput());

    expect(manifest.status).toBe("ready");
    expect(manifest.watermark).toBeNull();
    expect(manifest.missing).toHaveLength(0);
    expect(manifest.notice).toBe(USER_RESPONSIBILITY_NOTICE);
    expect(suggestedFileName).not.toContain("BORRADOR");

    const loaded = await JSZip.loadAsync(zip);
    const fileNames = Object.keys(loaded.files);
    expect(fileNames).toContain("manifiesto.json");
    expect(fileNames).toContain("checklist.json");
    expect(fileNames).toContain("AVISO.txt");
    expect(fileNames).toContain("tecnica.pdf");
    expect(fileNames).toContain("economica.pdf");
    expect(fileNames.some((f) => f.includes("BORRADOR"))).toBe(false);

    const manifestFromZip = JSON.parse(await loaded.file("manifiesto.json")!.async("string"));
    expect(manifestFromZip.status).toBe("ready");
    expect(manifestFromZip.documents).toHaveLength(2);
    expect(manifestFromZip.approvals[0].status).toBe("vigente");
    expect(manifestFromZip.notice).toBe(USER_RESPONSIBILITY_NOTICE);

    const checklistFromZip = JSON.parse(await loaded.file("checklist.json")!.async("string"));
    expect(checklistFromZip.overallStatus).toBe("verde");

    const aviso = await loaded.file("AVISO.txt")!.async("string");
    expect(aviso).toBe(USER_RESPONSIBILITY_NOTICE);

    const tecnicaContent = await loaded.file("tecnica.pdf")!.async("string");
    expect(tecnicaContent).toBe("contenido técnico");
  });

  it("nunca produce 'ready' por defecto: un assemble sin aprobaciones vigentes de alcance expediente es 'draft'", async () => {
    const assembler = new PackageAssembler();
    const { manifest } = await assembler.assemble(baseInput({ approvals: [] }));
    expect(manifest.status).toBe("draft");
  });
});

describe("PackageAssembler — A14 expediente incompleto nunca 'listo' (REQ-159/REQ-163)", () => {
  const combinations: Array<[string, Partial<AssembleInput>]> = [
    ["checklist en rojo", { checklist: RED_CHECKLIST }],
    [
      "documento obligatorio faltante",
      { documents: [{ documentId: "tecnica", label: "Propuesta técnica", required: true, filename: "tecnica.pdf", content: undefined }] },
    ],
    ["sin aprobación vigente de alcance expediente", { approvals: [] }],
    [
      "aprobación existente pero invalidada",
      {
        approvals: [{ ...approvalVigente(), status: "invalidada", invalidatedAt: "2026-10-05T00:00:00-06:00", invalidatedReason: "cambio" }],
      },
    ],
  ];

  it.each(combinations)("con %s, el paquete queda en 'draft' con marca BORRADOR en el ZIP", async (_label, overrides) => {
    const assembler = new PackageAssembler();
    const { manifest, zip, suggestedFileName } = await assembler.assemble(baseInput(overrides));

    expect(manifest.status).toBe("draft");
    expect(manifest.watermark).toBe("BORRADOR");
    expect(suggestedFileName).toContain("BORRADOR_");
    expect(manifest.draftReasons.length).toBeGreaterThan(0);

    const loaded = await JSZip.loadAsync(zip);
    const fileNames = Object.keys(loaded.files);
    expect(fileNames.some((f) => f.startsWith("BORRADOR_manifiesto"))).toBe(true);
    expect(fileNames).toContain("BORRADOR.txt");

    const manifestFromZip = JSON.parse(await loaded.file("BORRADOR_manifiesto.json")!.async("string"));
    expect(manifestFromZip.status).toBe("draft");
  });
});

describe("PackageAssembler — EX-EXP-01: invalidación automática por hash de insumos divergente (REQ-161/REQ-162)", () => {
  it("una aprobación con status 'vigente' pero inputsHash distinto del hash ACTUAL de insumos nunca produce 'ready', con motivo explícito", async () => {
    const assembler = new PackageAssembler();
    // La aprobación sigue "vigente" (nadie llamó recordChange manualmente),
    // pero el hash de insumos recalculado en este ensamblaje (p. ej. porque
    // una tarifa cambió después de la aprobación) ya no coincide.
    const { manifest } = await assembler.assemble(
      baseInput({ approvals: [approvalVigente()], currentInputsHash: fakeHashedInputs("hash-DISTINTO-tras-cambio-de-tarifa") }),
    );

    expect(manifest.status).toBe("draft");
    expect(manifest.watermark).toBe("BORRADOR");
    expect(manifest.draftReasons.some((r) => r.includes("hash_insumos_divergente"))).toBe(true);
  });

  it("cuando el hash actual SÍ coincide con el de la aprobación vigente, el paquete puede quedar 'ready'", async () => {
    const assembler = new PackageAssembler();
    const { manifest } = await assembler.assemble(baseInput({ currentInputsHash: HASH_1 }));
    expect(manifest.status).toBe("ready");
    expect(manifest.draftReasons).toHaveLength(0);
  });
});

describe("PackageAssembler — EX-EXP-02: 'ready' exige aprobación vigente de alcance 'expediente' (REQ-159/REQ-163)", () => {
  it("una única aprobación vigente de alcance 'documento' (con hash correcto) NUNCA produce 'ready': no existe forma de forzarlo desde afuera", async () => {
    const assembler = new PackageAssembler();
    const documentoApproval = approvalVigente("documento"); // scope: "documento", nunca "expediente"

    const { manifest } = await assembler.assemble(
      baseInput({ approvals: [documentoApproval], currentInputsHash: HASH_1 }),
    );

    expect(manifest.status).toBe("draft");
    expect(manifest.watermark).toBe("BORRADOR");
    expect(manifest.draftReasons.length).toBeGreaterThan(0);
  });

  /**
   * EX-EXP-14 (reverificación ronda 1, MEDIA): defensa en profundidad
   * INDEPENDIENTE de `ApprovalWorkflow.approve()` (que ya rechaza este caso
   * en origen desde EX-EXP-02). Si una `Approval` con `scope: "expediente"`
   * pero `scopeRef` arbitrario llegara al assembler por cualquier otra vía
   * (reconstrucción manual, datos legados, un bug futuro en `apps/api`),
   * `buildManifest` por sí solo debe rechazarla igual — nunca confiar en
   * que una sola capa la haya validado.
   */
  it("una aprobación con scope 'expediente' pero scopeRef arbitrario (construida a mano, sin pasar por approve()) NUNCA produce 'ready'", async () => {
    const assembler = new PackageAssembler();
    const approvalConScopeRefInconsistente: Approval = {
      ...approvalVigente("expediente"),
      scopeRef: "expediente-OTRO-EXPEDIENTE",
    };

    const { manifest } = await assembler.assemble(
      baseInput({ approvals: [approvalConScopeRefInconsistente], currentInputsHash: HASH_1 }),
    );

    expect(manifest.status).toBe("draft");
    expect(manifest.watermark).toBe("BORRADOR");
    expect(manifest.draftReasons.some((r) => r.includes("sin_aprobacion_vigente_de_alcance_expediente"))).toBe(true);
  });
});

/**
 * EX-EXP-17 (reverificación ronda 2, ALTA — mismo hilo que EX-EXP-01/11):
 * `buildManifest` aceptaba `currentInputsHash` como `string` plano, así que
 * un hash calculado a mano (sin relación real con ningún `ExpedienteInputs`)
 * producía `"ready"` sin protesta. Ahora exige un `HashedInputs` sellado y
 * lo verifica con `requireValidHashedInputs` (símbolo privado + recómputo).
 */
describe("PackageAssembler — EX-EXP-17: currentInputsHash exige un HashedInputs sellado, nunca un string suelto", () => {
  it("buildManifest lanza InvalidInputsHashError si currentInputsHash es un string plano (incluso uno 'correcto' en apariencia)", () => {
    const assembler = new PackageAssembler();
    expect(() =>
      assembler.buildManifest(
        baseInput({
          // @ts-expect-error EX-EXP-17: un string ya no es asignable a HashedInputs — ataque deliberado
          currentInputsHash: HASH_1.hash,
        }),
      ),
    ).toThrow(/InvalidInputsHashError|STRING PLANO/);
  });

  it("buildManifest lanza InvalidInputsHashError si currentInputsHash es un objeto {inputs, hash} reensamblado a mano, aunque use un InputsHash legítimo y TYPECHECKEE limpio (el símbolo privado no es falsificable, ni siquiera reusando un hash real)", () => {
    // Deliberadamente SIN @ts-expect-error: `{ inputs, hash }` con un
    // `InputsHash` legítimo (obtenido de HASH_1) satisface estructuralmente
    // el tipo público `HashedInputs` — esto demuestra por qué EX-EXP-17
    // exige una verificación en RUNTIME (símbolo privado), no solo el tipo:
    // TypeScript por sí solo no puede rechazar esta reconstrucción.
    const forged: import("../src/proposal-version.js").HashedInputs = { inputs: HASH_1.inputs, hash: HASH_1.hash };
    const assembler = new PackageAssembler();
    expect(() => assembler.buildManifest(baseInput({ currentInputsHash: forged }))).toThrow(/InvalidInputsHashError|sello interno/);
  });
});
