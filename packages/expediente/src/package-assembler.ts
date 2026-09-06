/**
 * PackageAssembler (REQ-163): genera un `PackageManifest` (índice de
 * documentos exigidos, hashes, versiones, checklist snapshot, evidencia de
 * revisión, faltantes) y lo exporta a un ZIP real (jszip). Estado `draft`
 * (marca "BORRADOR" en nombre de archivo y manifiesto) o `ready` SOLO si el
 * checklist está completo, las aprobaciones vigentes cubren todo el
 * expediente y no hay bloqueos — nunca `ready` por defecto. El manifiesto
 * siempre incluye el aviso de que la presentación y firma las realiza el
 * usuario.
 */
import JSZip from "jszip";
import type { ChecklistReport } from "./integrity-checklist.js";
import type { Approval } from "./approval-workflow.js";
import { isoNow, sha256Hex } from "./types.js";

export const USER_RESPONSIBILITY_NOTICE =
  "La presentación y firma las realiza el usuario; el sistema no envía ofertas.";

export type PackageStatus = "draft" | "ready";

export interface PackageDocumentInput {
  documentId: string;
  label: string;
  required: boolean;
  /** `undefined`/`null` = documento no presente en el expediente todavía. */
  content?: Uint8Array | string;
  filename: string;
  version?: number;
}

export interface PackageManifestDocumentEntry {
  documentId: string;
  label: string;
  required: boolean;
  present: boolean;
  sha256: string | null;
  version: number | null;
}

export interface PackageManifest {
  expedienteId: string;
  status: PackageStatus;
  generatedAt: string;
  documents: PackageManifestDocumentEntry[];
  checklist: ChecklistReport;
  approvals: Approval[];
  missing: string[];
  notice: string;
  watermark: string | null;
}

export interface AssembleInput {
  expedienteId: string;
  documents: PackageDocumentInput[];
  checklist: ChecklistReport;
  approvals: Approval[];
  /** El expediente se considera aprobado de punta a punta si hay una aprobación vigente de alcance "expediente". */
  isFullyApproved: boolean;
}

export interface AssembleResult {
  manifest: PackageManifest;
  zip: Uint8Array;
  suggestedFileName: string;
}

export class PackageAssembler {
  /** Construye el manifiesto sin generar el ZIP; útil para pruebas/inspección. */
  buildManifest(input: AssembleInput): PackageManifest {
    const missing: string[] = [];
    const documents: PackageManifestDocumentEntry[] = input.documents.map((doc) => {
      const present = doc.content !== undefined && doc.content !== null;
      if (doc.required && !present) missing.push(doc.documentId);
      return {
        documentId: doc.documentId,
        label: doc.label,
        required: doc.required,
        present,
        sha256: present ? sha256Hex(typeof doc.content === "string" ? doc.content : Array.from(doc.content as Uint8Array)) : null,
        version: doc.version ?? null,
      };
    });

    const checklistOk = input.checklist.overallStatus === "verde";
    const noMissing = missing.length === 0;
    const approvedOk = input.isFullyApproved && input.approvals.some((a) => a.status === "vigente");

    // Regla dura REQ-163/REQ-159: "ready" únicamente cuando las tres
    // condiciones se cumplen simultáneamente. Cualquier combinación de
    // pendientes deja el paquete en "draft".
    const status: PackageStatus = checklistOk && noMissing && approvedOk ? "ready" : "draft";

    return {
      expedienteId: input.expedienteId,
      status,
      generatedAt: isoNow(),
      documents,
      checklist: input.checklist,
      approvals: input.approvals,
      missing,
      notice: USER_RESPONSIBILITY_NOTICE,
      watermark: status === "draft" ? "BORRADOR" : null,
    };
  }

  async assemble(input: AssembleInput): Promise<AssembleResult> {
    const manifest = this.buildManifest(input);
    const prefix = manifest.status === "draft" ? "BORRADOR_" : "";

    const zip = new JSZip();
    zip.file(`${prefix}manifiesto.json`, JSON.stringify(manifest, null, 2));
    zip.file(`${prefix}checklist.json`, JSON.stringify(manifest.checklist, null, 2));
    zip.file("AVISO.txt", USER_RESPONSIBILITY_NOTICE);

    if (manifest.status === "draft") {
      zip.file(
        "BORRADOR.txt",
        [
          "BORRADOR — este expediente NO está listo para presentar.",
          `Documentos faltantes: ${manifest.missing.length > 0 ? manifest.missing.join(", ") : "ninguno"}.`,
          `Checklist: ${manifest.checklist.overallStatus}.`,
        ].join("\n"),
      );
    }

    for (const doc of input.documents) {
      if (doc.content === undefined || doc.content === null) continue;
      zip.file(`${prefix}${doc.filename}`, doc.content);
    }

    const zipBuffer = await zip.generateAsync({ type: "uint8array" });
    const suggestedFileName = `${prefix}expediente_${input.expedienteId}.zip`;

    return { manifest, zip: zipBuffer, suggestedFileName };
  }
}
