import { describe, expect, it } from "vitest";
import {
  CHATGPT_APP_TOOL_DEFINITIONS,
  ChatGptAppFirmableDocumentLeakError,
  ChatGptAppToolNotAllowedError,
  assertAllowedChatGptAppTool,
  assertNoFirmableDocumentInToolOutput,
} from "../src/chatgpt-app.js";

describe("ChatGPT App — allowlist de herramientas (REQ-067)", () => {
  it("solo expone herramientas de LECTURA -- ni el nombre ni el título (lo que un modelo ve primero) sugieren escritura/firma/exportación", () => {
    // El nombre/título es lo que decide si un modelo "cree" que puede
    // ejecutar una acción; la descripción SÍ puede (y debe) mencionar estas
    // palabras para ACLARAR que están prohibidas ("nunca permite firmar,
    // aprobar ni exportar"), así que solo se exige la ausencia aquí, no en
    // la prosa completa de la descripción.
    const forbiddenWords = ["approve", "sign", "firm", "export", "package", "paquete", "submit", "envia", "delete", "eliminar", "reject", "recha", "write"];
    for (const tool of CHATGPT_APP_TOOL_DEFINITIONS) {
      const haystack = `${tool.name} ${tool.title}`.toLowerCase();
      for (const word of forbiddenWords) {
        expect(haystack.includes(word), `"${tool.name}" no debería mencionar "${word}" en nombre/título`).toBe(false);
      }
    }
    expect(CHATGPT_APP_TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([
      "get_approval_status",
      "get_compliance_matrix",
      "get_tender",
      "list_tenders",
    ]);
  });

  it("la descripción de cada herramienta declara explícitamente que es de solo lectura o nunca aprueba/firma/exporta", () => {
    for (const tool of CHATGPT_APP_TOOL_DEFINITIONS) {
      expect(tool.description.toLowerCase()).toMatch(/lectura|nunca/);
    }
  });

  it("acepta cualquier nombre del allowlist sin lanzar", () => {
    for (const tool of CHATGPT_APP_TOOL_DEFINITIONS) {
      expect(() => assertAllowedChatGptAppTool(tool.name)).not.toThrow();
    }
  });

  it("ADVERSARIAL: rechaza un intento de invocar una herramienta de aprobación/firma/exportación que nunca se registró", () => {
    for (const forbiddenName of ["approve", "expediente.approval.approve", "export_package", "sign_contract", "submit_proposal", "delete_tender"]) {
      expect(() => assertAllowedChatGptAppTool(forbiddenName)).toThrow(ChatGptAppToolNotAllowedError);
    }
  });

  it("el mensaje de rechazo no inventa una acción permitida que no existe", () => {
    try {
      assertAllowedChatGptAppTool("approve");
      throw new Error("no debió llegar aquí");
    } catch (err) {
      expect(err).toBeInstanceOf(ChatGptAppToolNotAllowedError);
      expect((err as ChatGptAppToolNotAllowedError).requestedName).toBe("approve");
      expect((err as Error).message).toMatch(/list_tenders|get_tender|get_approval_status/);
    }
  });
});

describe("ChatGPT App — guarda anti-filtración de documentos firmables (REQ-067)", () => {
  it("deja pasar una salida de lectura legítima (sin campos documentales)", () => {
    expect(() =>
      assertNoFirmableDocumentInToolOutput({
        items: [{ id: "t1", title: "Convocatoria X", status: "in_review", submissionDeadline: "2026-10-01T00:00:00.000Z" }],
      })
    ).not.toThrow();

    expect(() =>
      assertNoFirmableDocumentInToolOutput({
        state: "en_revision",
        approvals: [{ scope: "expediente", scopeRef: "expediente", approvedByRole: "reviewer", approvedAt: "2026-09-01T00:00:00.000Z", status: "vigente" }],
        comments: [{ scopeRef: "expediente", authorRole: "writer", text: "Falta anexo técnico", createdAt: "2026-09-01T00:00:00.000Z" }],
      })
    ).not.toThrow();

    expect(() =>
      assertNoFirmableDocumentInToolOutput({
        overallStatus: "ambar",
        items: [{ dimension: "formatos", result: "ambar", label: "Formato de archivo", notes: "Falta un anexo en PDF" }],
      })
    ).not.toThrow();
  });

  it("ADVERSARIAL: bloquea una salida que intenta colar una URL de documento firmable por nombre de campo", () => {
    expect(() => assertNoFirmableDocumentInToolOutput({ documentUrl: "https://storage.example/expediente-123.pdf" })).toThrow(
      ChatGptAppFirmableDocumentLeakError
    );
    expect(() => assertNoFirmableDocumentInToolOutput({ tender: { packageId: "pkg-1" } })).toThrow(ChatGptAppFirmableDocumentLeakError);
    expect(() => assertNoFirmableDocumentInToolOutput({ approvals: [{ signerName: "Juana Pérez" }] })).toThrow(ChatGptAppFirmableDocumentLeakError);
    expect(() => assertNoFirmableDocumentInToolOutput({ evidence: { evidenceDocId: "doc-1" } })).toThrow(ChatGptAppFirmableDocumentLeakError);
  });

  it("ADVERSARIAL: bloquea una salida cuyo VALOR es una ruta a un archivo firmable, aunque el nombre del campo sea inocuo", () => {
    expect(() => assertNoFirmableDocumentInToolOutput({ note: "ver anexo en /files/contrato-firmado.pdf" })).toThrow(
      ChatGptAppFirmableDocumentLeakError
    );
    expect(() => assertNoFirmableDocumentInToolOutput({ note: "paquete final: expediente.zip" })).toThrow(ChatGptAppFirmableDocumentLeakError);
  });

  it("no lanza falso positivo por una palabra parecida dentro de texto libre inocuo", () => {
    // "signature" gráfica no aparece, pero un comentario libre con la
    // palabra "firmado" en prosa (sin ruta de archivo ni campo documental)
    // no debe bloquear -- la guarda es sobre NOMBRES DE CAMPO y RUTAS DE
    // ARCHIVO, no sobre el lenguaje natural que un revisor pudo escribir.
    expect(() => assertNoFirmableDocumentInToolOutput({ text: "Recuerden que el contrato se firma después de la segunda aprobación." })).not.toThrow();
  });
});
