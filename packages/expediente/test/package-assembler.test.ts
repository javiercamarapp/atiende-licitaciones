import { createHash } from "node:crypto";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { PackageAssembler, USER_RESPONSIBILITY_NOTICE, verifyManifest, type AssembleInput } from "../src/package-assembler.js";
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

/**
 * AE-06 (auditoría ronda 2, `docs/auditoria-2/api-expediente.md`): el
 * `sha256` de cada documento en el manifiesto debe coincidir con el sha256
 * REAL de los bytes del archivo — el mismo cálculo que un usuario obtiene
 * corriendo `sha256sum` sobre el archivo extraído del ZIP. Antes de esta
 * corrección, el manifiesto hasheaba `JSON.stringify(contenido)`, nunca los
 * bytes reales.
 */
describe("PackageAssembler — AE-06: sha256 del manifiesto sobre BYTES REALES, no JSON", () => {
  it("el sha256 de un documento en el manifiesto coincide con sha256 de node:crypto calculado directamente sobre los bytes UTF-8 del contenido", async () => {
    const assembler = new PackageAssembler();
    const content = "contenido técnico";
    const { manifest } = await assembler.assemble(baseInput({ documents: [{ documentId: "tecnica", label: "Propuesta técnica", required: true, filename: "tecnica.pdf", content, version: 1 }] }));

    const expected = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
    const entry = manifest.documents.find((d) => d.documentId === "tecnica")!;
    expect(entry.sha256).toBe(expected);
  });

  it("el sha256 de un documento binario (Uint8Array) coincide con sha256 de node:crypto sobre esos bytes exactos", async () => {
    const assembler = new PackageAssembler();
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const { manifest } = await assembler.assemble(baseInput({ documents: [{ documentId: "bin", label: "Binario", required: true, filename: "datos.bin", content: bytes, version: 1 }] }));

    const expected = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    const entry = manifest.documents.find((d) => d.documentId === "bin")!;
    expect(entry.sha256).toBe(expected);
  });

  it("verifyManifest(zip) confirma que el sha256 del manifiesto coincide con los bytes REALES releídos del ZIP (caso íntegro)", async () => {
    const assembler = new PackageAssembler();
    const { zip } = await assembler.assemble(baseInput());

    const result = await verifyManifest(zip);
    expect(result.ok).toBe(true);
    expect(result.mismatches).toHaveLength(0);
    expect(result.missingFromZip).toHaveLength(0);
  });

  it("verifyManifest(zip) detecta la alteración de UN SOLO BYTE del contenido de un documento dentro del ZIP", async () => {
    const assembler = new PackageAssembler();
    const { zip } = await assembler.assemble(baseInput());

    // Se reabre el ZIP y se corrompe un solo byte del archivo "tecnica.pdf"
    // (contenido original: "contenido técnico"), dejando el manifiesto
    // intacto -- exactamente el escenario que `verifyManifest` debe
    // detectar: alguien (o algo) alteró el contenido después de calcular el
    // manifiesto.
    const loaded = await JSZip.loadAsync(zip);
    const original = await loaded.file("tecnica.pdf")!.async("uint8array");
    const corrupted = Uint8Array.from(original);
    corrupted[0] = corrupted[0] ^ 0xff; // voltea el primer byte
    loaded.file("tecnica.pdf", corrupted);
    const corruptedZip = await loaded.generateAsync({ type: "uint8array" });

    const result = await verifyManifest(corruptedZip);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0].documentId).toBe("tecnica");
    expect(result.mismatches[0].expectedSha256).not.toBe(result.mismatches[0].actualSha256);
  });

  it("verifyManifest(zip) reporta missingFromZip si un documento 'present' en el manifiesto no tiene entrada real en el ZIP", async () => {
    const assembler = new PackageAssembler();
    const { zip } = await assembler.assemble(baseInput());

    const loaded = await JSZip.loadAsync(zip);
    loaded.remove("tecnica.pdf");
    const strippedZip = await loaded.generateAsync({ type: "uint8array" });

    const result = await verifyManifest(strippedZip);
    expect(result.ok).toBe(false);
    expect(result.missingFromZip).toContain("tecnica");
  });
});

/**
 * AE-07 (auditoría ronda 2): `assemble()` escribía
 * `zip.file(`${prefix}${doc.filename}`, doc.content)` sin sanear
 * `filename` -- un `filename` con `../`, ruta absoluta o separadores de
 * Windows sobrevivía literal como nombre de entrada del ZIP (Zip Slip
 * latente). Hoy `apps/api` solo pasa nombres fijos generados por el
 * servidor, pero la librería debe sanear igual por defensa en profundidad
 * ante cualquier llamador futuro.
 */
describe("PackageAssembler — AE-07: nombres de entrada de ZIP saneados (Zip Slip)", () => {
  it("un filename con '../../etc/passwd' nunca produce una entrada de ZIP con '..' ni con '/'", async () => {
    const assembler = new PackageAssembler();
    const { zip } = await assembler.assemble(
      baseInput({ documents: [{ documentId: "malicioso", label: "Doc", required: true, filename: "../../etc/passwd", content: "x", version: 1 }] }),
    );

    const loaded = await JSZip.loadAsync(zip);
    const fileNames = Object.keys(loaded.files);
    for (const name of fileNames) {
      expect(name).not.toContain("..");
      expect(name).not.toContain("/etc/");
    }
    // El contenido debe seguir siendo recuperable bajo algún nombre seguro derivado del último segmento ("passwd").
    expect(fileNames.some((f) => f.endsWith("passwd"))).toBe(true);
  });

  it("un filename con separadores de Windows ('C:\\\\x') nunca produce una entrada con ':' ni '\\\\'", async () => {
    const assembler = new PackageAssembler();
    const { zip } = await assembler.assemble(
      baseInput({ documents: [{ documentId: "windows", label: "Doc", required: true, filename: "C:\\x", content: "y", version: 1 }] }),
    );

    const loaded = await JSZip.loadAsync(zip);
    const fileNames = Object.keys(loaded.files);
    for (const name of fileNames) {
      expect(name).not.toContain(":");
      expect(name).not.toContain("\\");
    }
    const content = await loaded.file(fileNames.find((f) => f.endsWith("x"))!)!.async("string");
    expect(content).toBe("y");
  });

  it("un filename de 500 caracteres se acota a una longitud razonable en el nombre de entrada del ZIP", async () => {
    const assembler = new PackageAssembler();
    const longName = `${"a".repeat(500)}.pdf`;
    const { zip, manifest } = await assembler.assemble(
      baseInput({ documents: [{ documentId: "largo", label: "Doc", required: true, filename: longName, content: "z", version: 1 }] }),
    );

    const entry = manifest.documents.find((d) => d.documentId === "largo")!;
    expect(entry.filename.length).toBeLessThan(longName.length);
    expect(entry.filename.length).toBeLessThanOrEqual(200);

    const loaded = await JSZip.loadAsync(zip);
    expect(Object.keys(loaded.files)).toContain(entry.filename);
  });

  it("dos documentos cuyos filenames sanean al MISMO nombre reciben entradas distintas en el ZIP, sin perder contenido (colisión con sufijo determinista)", async () => {
    const assembler = new PackageAssembler();
    const documents = [
      { documentId: "doc-a", label: "A", required: true, filename: "../carpeta1/reporte.pdf", content: "contenido-A", version: 1 },
      { documentId: "doc-b", label: "B", required: true, filename: "..\\carpeta2\\reporte.pdf", content: "contenido-B", version: 1 },
    ];
    const { zip, manifest } = await assembler.assemble(baseInput({ documents }));

    const filenames = manifest.documents.map((d) => d.filename);
    expect(new Set(filenames).size).toBe(filenames.length); // sin colisiones en el manifiesto

    const loaded = await JSZip.loadAsync(zip);
    const entryA = manifest.documents.find((d) => d.documentId === "doc-a")!;
    const entryB = manifest.documents.find((d) => d.documentId === "doc-b")!;
    expect(entryA.filename).not.toBe(entryB.filename);
    expect(await loaded.file(entryA.filename)!.async("string")).toBe("contenido-A");
    expect(await loaded.file(entryB.filename)!.async("string")).toBe("contenido-B");

    // Determinismo: repetir el ensamblaje con el mismo input produce exactamente los mismos nombres.
    const second = await assembler.assemble(baseInput({ documents }));
    expect(second.manifest.documents.map((d) => d.filename)).toEqual(filenames);
  });
});
