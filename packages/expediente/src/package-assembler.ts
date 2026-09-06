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
import { isoNow, sha256Bytes } from "./types.js";
import { requireValidHashedInputs, type HashedInputs } from "./proposal-version.js";

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
  /** sha256 hex de los BYTES REALES del archivo (AE-06) — coincide con `sha256sum` sobre el archivo extraído del ZIP. `null` si el documento no está presente. */
  sha256: string | null;
  version: number | null;
  /**
   * Nombre de entrada SANEADO (AE-07) con el que este documento aparece
   * dentro del ZIP (sin el prefijo `BORRADOR_`, que se antepone igual para
   * todas las entradas cuando `status === "draft"`). Nunca es el
   * `PackageDocumentInput.filename` crudo del llamador: ver
   * `sanitizeEntryFilename`/`buildSafeEntryFilenames`.
   */
  filename: string;
}

export interface PackageManifest {
  expedienteId: string;
  status: PackageStatus;
  generatedAt: string;
  documents: PackageManifestDocumentEntry[];
  checklist: ChecklistReport;
  approvals: Approval[];
  missing: string[];
  /** Motivos explícitos por los que el paquete quedó en "draft" (vacío si "ready"); REQ-162/REQ-163/EX-EXP-01. */
  draftReasons: string[];
  notice: string;
  watermark: string | null;
  /**
   * Requisitos condicionales/opcionales marcados explícitamente como "no
   * aplica" en la propuesta técnica (EX-EXP-19), reflejados también aquí
   * para que la decisión de omitir sea visible en el manifiesto final, no
   * solo en `TechnicalProposal.sections`. Vacío por defecto si el llamador
   * no pasa `notApplicableRequirements` en `AssembleInput` (p. ej. porque
   * este ensamblaje no incluye una propuesta técnica).
   */
  notApplicableRequirements: { requirementId: string; reason: string }[];
  /**
   * REQ-171 (ronda 5, `apps/api`): id de correlación de negocio del request
   * que ensambló este paquete, para que la traza "convocatoria -> matriz ->
   * propuesta -> paquete -> archivo" quede legible incluso leyendo
   * `manifest.json` DENTRO del ZIP (no solo la fila `package_manifests` de
   * la base de datos, que ya lo guarda por separado). Campo ADITIVO y
   * opcional: `undefined`/`null` para cualquier paquete ensamblado sin un
   * correlation_id conocido (p. ej. pruebas de `packages/expediente` que no
   * pasan por `apps/api`) -- nunca se fabrica un valor.
   */
  correlationId?: string | null;
}

export interface AssembleInput {
  expedienteId: string;
  documents: PackageDocumentInput[];
  checklist: ChecklistReport;
  approvals: Approval[];
  /** REQ-171: ver `PackageManifest.correlationId`. Opcional -- se propaga tal cual si se declara. */
  correlationId?: string | null;
  /**
   * `HashedInputs` sellado (EX-EXP-17) con el hash ACTUAL de los insumos
   * cubiertos por el alcance "expediente" (p. ej.
   * `ProposalVersionRegistry.latest().hash`, recalculado justo antes de
   * ensamblar — tarifas, documentos, datos de empresa, versión de bases).
   * Ya NO se acepta un `string` plano: debe venir de `sealInputs`/
   * `computeInputsHash`/`ProposalVersionRegistry.createVersion`, y
   * `buildManifest` lo verifica con `requireValidHashedInputs` antes de
   * usarlo (fail-closed ante un hash calculado a mano o insumos mutados
   * después de sellarse). El assembler compara el hash verificado contra el
   * `inputsHash` registrado en cada aprobación: si no coincide con el
   * actual NUNCA cuenta como válida (REQ-161/REQ-162/EX-EXP-01) — protege
   * contra que el llamador haya olvidado invalidar la aprobación (vía
   * `ApprovalWorkflow.revalidateAgainstCurrentHash`) tras un cambio de
   * insumos.
   */
  currentInputsHash: HashedInputs;
  /**
   * Requisitos "no aplica" de la propuesta técnica (EX-EXP-19), típicamente
   * `extractNotApplicableRequirements(technical)` — opcional: se refleja
   * en `PackageManifest.notApplicableRequirements` (vacío si se omite).
   */
  notApplicableRequirements?: { requirementId: string; reason: string }[];
}

/**
 * NOTA (REQ-159/REQ-163/EX-EXP-02): deliberadamente NO existe un campo
 * `isFullyApproved: boolean` en `AssembleInput`. Antes de esta corrección,
 * el assembler confiaba en un booleano calculado por el llamador (que podía
 * estar mal calculado, o simplemente forzado a `true`) sin verificar por sí
 * mismo el `scope` de la aprobación. Ahora "¿está aprobado?" se DERIVA
 * exclusivamente de `approvals` dentro de `buildManifest` — nunca se
 * declara desde afuera.
 */

export interface AssembleResult {
  manifest: PackageManifest;
  zip: Uint8Array;
  suggestedFileName: string;
}

/** Longitud máxima de un nombre de entrada de ZIP saneado (AE-07): acota nombres de usuario arbitrariamente largos. */
const MAX_ENTRY_FILENAME_LENGTH = 200;
/**
 * Elimina caracteres de control (incluyendo NUL, 0x00-0x1F y 0x7F) de
 * `name` — nunca válidos en un nombre de entrada de ZIP. Se recorre
 * carácter a carácter (en vez de una regex con un rango de control, que
 * `eslint(no-control-regex)` marca como sospechosa) para evitar cualquier
 * ambigüedad sobre qué se está excluyendo.
 */
function stripControlChars(name: string): string {
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

/**
 * Sanea un `filename` de ENTRADA antes de usarlo como nombre de entrada
 * dentro del ZIP (AE-07, Zip Slip): `PackageAssembler.assemble()` escribía
 * `zip.file(`${prefix}${doc.filename}`, doc.content)` sin sanear
 * `filename` — un valor con `../` o una ruta absoluta sobrevivía literal
 * como nombre de entrada del ZIP (Zip Slip clásico: un extractor ingenuo
 * que respete rutas relativas podría escribir fuera del directorio de
 * destino). Hoy `apps/api` solo pasa un `filename` fijo generado por el
 * servidor (`${section_key}.txt`), así que el ataque no es alcanzable vía
 * la integración actual — pero la librería debe ser segura POR SÍ MISMA
 * ante cualquier llamador futuro que sí pase un nombre de usuario sin
 * sanear primero.
 *
 * Reglas (fail-safe, nunca lanza — un nombre inválido cae al `fallback`):
 *  1. Se descarta cualquier componente de ruta: solo sobrevive el último
 *     segmento tras el separador `/` o `\` (así `"../../etc/passwd"` queda
 *     en `"passwd"` y `"C:\\x"` en `"x"` — ni siquiera hace falta detectar
 *     `".."` explícitamente para la mayoría de los casos, pero se limpia
 *     igual por defensa en profundidad, p. ej. `"..".repeat(n)` sin
 *     separador).
 *  2. Se eliminan caracteres de control (incluido NUL) y cualquier `".."`
 *     residual.
 *  3. Se reemplaza `:` (separador de unidad en Windows, o *stream* NTFS
 *     alterno) por `_`.
 *  4. Si el resultado queda vacío (o es solo `"."`), se usa `fallback`
 *     (determinista, basado en `documentId`).
 *  5. Se acota a `MAX_ENTRY_FILENAME_LENGTH`, preservando la extensión
 *     cuando es razonablemente corta.
 */
function sanitizeEntryFilename(rawFilename: string, fallback: string): string {
  const lastSlash = Math.max(rawFilename.lastIndexOf("/"), rawFilename.lastIndexOf("\\"));
  let name = lastSlash >= 0 ? rawFilename.slice(lastSlash + 1) : rawFilename;

  name = stripControlChars(name).split("..").join("");
  name = name.replace(/:/g, "_");
  name = name.trim();

  if (name.length === 0 || name === ".") {
    name = fallback;
  }

  if (name.length > MAX_ENTRY_FILENAME_LENGTH) {
    const dot = name.lastIndexOf(".");
    const hasShortExtension = dot > 0 && name.length - dot <= 20;
    if (hasShortExtension) {
      const ext = name.slice(dot);
      name = name.slice(0, MAX_ENTRY_FILENAME_LENGTH - ext.length) + ext;
    } else {
      name = name.slice(0, MAX_ENTRY_FILENAME_LENGTH);
    }
  }

  return name;
}

/**
 * Calcula, en el mismo orden que `documents`, un nombre de entrada de ZIP
 * SANEADO y sin colisiones para cada documento (AE-07). Las colisiones
 * (dos `filename` de entrada que sanean al mismo nombre — p. ej. dos rutas
 * distintas que solo difieren en el directorio, descartado por
 * `sanitizeEntryFilename`) se resuelven con un sufijo DETERMINISTA
 * derivado del propio `documentId` — nunca aleatorio ni dependiente del
 * orden de inserción en un `Set`/`Map`, para que el mismo `AssembleInput`
 * produzca siempre el mismo ZIP byte a byte.
 */
function buildSafeEntryFilenames(documents: PackageDocumentInput[]): string[] {
  const used = new Set<string>();
  const result: string[] = [];

  for (const doc of documents) {
    const fallback = `${sanitizeEntryFilename(doc.documentId, "documento") || "documento"}.bin`;
    const base = sanitizeEntryFilename(doc.filename, fallback);

    let candidate = base;
    if (used.has(candidate)) {
      const dot = base.lastIndexOf(".");
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : "";
      const idSuffix = sanitizeEntryFilename(doc.documentId, "doc");
      candidate = `${stem}__${idSuffix}${ext}`;
      let n = 2;
      while (used.has(candidate)) {
        candidate = `${stem}__${idSuffix}_${n}${ext}`;
        n++;
      }
    }

    used.add(candidate);
    result.push(candidate);
  }

  return result;
}

export class PackageAssembler {
  /** Construye el manifiesto sin generar el ZIP; útil para pruebas/inspección. */
  buildManifest(input: AssembleInput): PackageManifest {
    // EX-EXP-17: `currentInputsHash` debe ser un `HashedInputs` sellado por
    // `sealInputs`/`computeInputsHash` de proposal-version.ts, nunca un
    // `string` calculado a mano — `requireValidHashedInputs` lanza
    // `InvalidInputsHashError` (fail-closed) si no lo es, incluyendo el caso
    // de insumos mutados tras sellarse.
    const { hash: currentInputsHash } = requireValidHashedInputs(input.currentInputsHash, "AssembleInput.currentInputsHash (buildManifest())");
    const missing: string[] = [];
    // AE-07: nombres de entrada de ZIP saneados y sin colisiones, calculados
    // UNA vez y reutilizados tanto en el manifiesto como al escribir el ZIP
    // en `assemble()`, para que `verifyManifest` siempre encuentre la
    // entrada correcta.
    const safeFilenames = buildSafeEntryFilenames(input.documents);
    const documents: PackageManifestDocumentEntry[] = input.documents.map((doc, i) => {
      const present = doc.content !== undefined && doc.content !== null;
      if (doc.required && !present) missing.push(doc.documentId);
      return {
        documentId: doc.documentId,
        label: doc.label,
        required: doc.required,
        present,
        // AE-06: sha256 de los BYTES REALES del contenido (nunca de su
        // representación JSON) — coincide con `sha256sum` sobre el archivo
        // extraído del ZIP.
        sha256: present ? sha256Bytes(doc.content as Uint8Array | string) : null,
        version: doc.version ?? null,
        filename: safeFilenames[i],
      };
    });

    const checklistOk = input.checklist.overallStatus === "verde";
    const noMissing = missing.length === 0;
    // REQ-159/REQ-163/EX-EXP-02: "aprobado" se DERIVA aquí, nunca se acepta
    // como booleano declarado por el llamador — debe existir una aprobación
    // cuyo `scope` sea EXACTAMENTE "expediente" (una aprobación de
    // "documento"/"sección" nunca basta, sin importar cuántas haya).
    // REQ-161/REQ-162/EX-EXP-01: además, su `inputsHash` debe coincidir con
    // el hash ACTUAL de los insumos que el llamador acaba de recalcular; si
    // alguien cambió una tarifa después de aprobar y olvidó invalidar la
    // aprobación, el hash ya no calza y el assembler lo detecta aquí.
    // EX-EXP-14 (reverificación ronda 1): además de `scope === "expediente"`,
    // se exige que `scopeRef === "expediente"` — defensa en profundidad
    // independiente de la validación de `ApprovalWorkflow.approve()`: si
    // una `Approval` llegara aquí (p. ej. reconstruida desde `apps/api`) con
    // `scope: "expediente"` pero un `scopeRef` arbitrario, el assembler por
    // sí solo la rechaza igual, sin depender de que nadie más la validara.
    const hashValidExpedienteApproval = input.approvals.find(
      (a) => a.scope === "expediente" && a.scopeRef === "expediente" && a.status === "vigente" && a.inputsHash === currentInputsHash,
    );
    const approvedOk = hashValidExpedienteApproval !== undefined;

    // Regla dura REQ-163/REQ-159: "ready" únicamente cuando las tres
    // condiciones se cumplen simultáneamente. Cualquier combinación de
    // pendientes deja el paquete en "draft".
    const status: PackageStatus = checklistOk && noMissing && approvedOk ? "ready" : "draft";

    const draftReasons: string[] = [];
    if (status === "draft") {
      if (!checklistOk) draftReasons.push(`checklist_no_verde:${input.checklist.overallStatus}`);
      if (!noMissing) draftReasons.push(`documentos_faltantes:${missing.join(",")}`);
      if (!approvedOk) {
        const vigentesExpediente = input.approvals.filter((a) => a.scope === "expediente" && a.scopeRef === "expediente" && a.status === "vigente");
        if (vigentesExpediente.length === 0) {
          draftReasons.push("sin_aprobacion_vigente_de_alcance_expediente");
        } else {
          draftReasons.push(
            `aprobacion_vigente_con_hash_insumos_divergente:aprobado=${vigentesExpediente.map((a) => a.inputsHash).join("|")}:actual=${currentInputsHash}`,
          );
        }
      }
    }

    return {
      expedienteId: input.expedienteId,
      status,
      generatedAt: isoNow(),
      documents,
      checklist: input.checklist,
      approvals: input.approvals,
      missing,
      draftReasons,
      notice: USER_RESPONSIBILITY_NOTICE,
      watermark: status === "draft" ? "BORRADOR" : null,
      notApplicableRequirements: input.notApplicableRequirements ?? [],
      correlationId: input.correlationId ?? null,
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
          `Motivo(s) explícito(s): ${manifest.draftReasons.length > 0 ? manifest.draftReasons.join(" | ") : "ver checklist/missing arriba"}.`,
        ].join("\n"),
      );
    }

    // AE-07: se escribe con el nombre de entrada SANEADO ya calculado en
    // `manifest.documents[i].filename` (mismo orden que `input.documents`),
    // nunca con `doc.filename` crudo del llamador.
    for (let i = 0; i < input.documents.length; i++) {
      const doc = input.documents[i];
      if (doc.content === undefined || doc.content === null) continue;
      zip.file(`${prefix}${manifest.documents[i].filename}`, doc.content);
    }

    const zipBuffer = await zip.generateAsync({ type: "uint8array" });
    const suggestedFileName = `${prefix}expediente_${input.expedienteId}.zip`;

    return { manifest, zip: zipBuffer, suggestedFileName };
  }
}

export interface ManifestVerificationMismatch {
  documentId: string;
  expectedSha256: string;
  actualSha256: string;
}

export interface ManifestVerificationResult {
  ok: boolean;
  /** Documentos cuyo sha256 del manifiesto NO coincide con el sha256 real de los bytes extraídos del ZIP. */
  mismatches: ManifestVerificationMismatch[];
  /** Documentos que el manifiesto marca `present: true` pero cuya entrada no existe en el ZIP. */
  missingFromZip: string[];
}

/**
 * Verifica de forma INDEPENDIENTE (AE-06) que el `sha256` de cada documento
 * `present` en el manifiesto de un ZIP producido por `assemble()` coincide
 * con el sha256 REAL de los bytes de la entrada extraída — el mismo cálculo
 * que obtendría un usuario corriendo `sha256sum` sobre el archivo
 * extraído. Recalcula el hash desde cero con `sha256Bytes` sobre los bytes
 * releídos del propio ZIP; nunca confía en ningún valor ya calculado por
 * `assemble()`.
 *
 * No lanza ante una discrepancia: fail-visible, no fail-closed — devuelve
 * `ok: false` con el detalle exacto (`mismatches`/`missingFromZip`) para que
 * el llamador decida qué hacer (p. ej. rechazar la descarga, alertar).
 */
export async function verifyManifest(zip: Uint8Array): Promise<ManifestVerificationResult> {
  const loaded = await JSZip.loadAsync(zip);
  const manifestFile = loaded.file("manifiesto.json") ?? loaded.file("BORRADOR_manifiesto.json");
  if (!manifestFile) {
    throw new Error("verifyManifest: el ZIP no contiene manifiesto.json ni BORRADOR_manifiesto.json.");
  }
  const manifest = JSON.parse(await manifestFile.async("string")) as PackageManifest;
  const prefix = manifest.status === "draft" ? "BORRADOR_" : "";

  const mismatches: ManifestVerificationMismatch[] = [];
  const missingFromZip: string[] = [];

  for (const doc of manifest.documents) {
    if (!doc.present || doc.sha256 === null) continue;
    const entry = loaded.file(`${prefix}${doc.filename}`);
    if (!entry) {
      missingFromZip.push(doc.documentId);
      continue;
    }
    const bytes = await entry.async("uint8array");
    const actualSha256 = sha256Bytes(bytes);
    if (actualSha256 !== doc.sha256) {
      mismatches.push({ documentId: doc.documentId, expectedSha256: doc.sha256, actualSha256 });
    }
  }

  return { ok: mismatches.length === 0 && missingFromZip.length === 0, mismatches, missingFromZip };
}
