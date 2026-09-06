/**
 * ProposalVersion (REQ-161): versionado con hash de insumos. Cada versión
 * registra el hash de cada insumo utilizado (documento de bases, dato de
 * empresa, tarifa) para que, dado el hash, se puedan reconstruir
 * exactamente los insumos usados en esa versión.
 *
 * EX-EXP-01/EX-EXP-11 (reverificación ronda 1): antes, `createVersion`
 * aceptaba cualquier `Record<string, unknown>` que el llamador decidiera
 * pasarle — nada dentro del paquete garantizaba qué insumos entraban al
 * hash de alcance "expediente". Se reprodujo que sustituir un documento de
 * empresa o publicar una nueva versión de bases DESPUÉS de aprobar, sin que
 * el llamador los incluyera en el hash (el test oficial solo hasheaba
 * `economicTotals`), dejaba `isFullyApprovedForCurrentHash`/`manifest.status`
 * completamente ciegos al cambio. Ahora `createVersion`/`computeInputsHash`
 * exigen `ExpedienteInputs`: un conjunto CERRADO y OBLIGATORIO (versión de
 * bases, documentos de empresa usados con su vigencia, tarifas usadas,
 * datos de perfil, plantillas) que TypeScript fuerza a declarar completo —
 * el llamador ya NO puede "olvidar" un insumo ni pasar un hash arbitrario
 * calculado por su cuenta.
 */
import { isoNow, sha256Hex } from "./types.js";

export interface ProposalInputRecord {
  /** p. ej. "tender_version", "company_profile", "company_document:doc-32d", "rate:consultoria_hora" */
  key: string;
  hash: string;
}

export interface ProposalVersion {
  version: number;
  hash: string;
  createdAt: string;
  inputs: ProposalInputRecord[];
}

/** Documento de empresa efectivamente usado para redactar el expediente, con su vigencia (EX-EXP-11). */
export interface ExpedienteInputCompanyDocument {
  documentId: string;
  /** Hash (o cualquier valor que identifique unívocamente el contenido) del documento usado. */
  hash: string;
  /** ISO 8601 con offset explícito, o `null` si el documento no tiene vigencia definida. */
  vigenteHasta: string | null;
}

/** Tarifa efectivamente usada en la propuesta económica (EX-EXP-11). */
export interface ExpedienteInputRate {
  concept: string;
  hash: string;
}

/** Plantilla usada para redactar carta/anexos (EX-EXP-11). */
export interface ExpedienteInputTemplate {
  templateId: string;
  hash: string;
}

/**
 * Conjunto CERRADO y OBLIGATORIO de insumos de alcance "expediente"
 * (EX-EXP-01/EX-EXP-11): versión de bases, documentos de empresa usados
 * (con vigencia), tarifas usadas, datos de perfil usados y plantillas. Es
 * el ÚNICO tipo que `ProposalVersionRegistry.createVersion`/
 * `computeInputsHash` aceptan — TypeScript exige que las cinco categorías
 * estén presentes (los arreglos pueden estar vacíos si genuinamente no
 * aplican, pero el campo no puede omitirse), de modo que un llamador no
 * puede "olvidar" incluir un insumo ni construir el hash con un objeto
 * arbitrario de su elección.
 */
export interface ExpedienteInputs {
  /** Hash de la versión de bases/convocatoria vigente al construir la propuesta. */
  tenderVersionHash: string;
  /** Hash de los datos de perfil de empresa (razón social, RFC, firmantes, etc.) usados. */
  companyProfileHash: string;
  /** Documentos de empresa efectivamente usados para mapear requisitos. */
  companyDocuments: ExpedienteInputCompanyDocument[];
  /** Tarifas efectivamente usadas en la propuesta económica. */
  rates: ExpedienteInputRate[];
  /** Plantillas usadas para redactar carta/anexos. */
  templates: ExpedienteInputTemplate[];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`ExpedienteInputs.${field} es obligatorio y debe ser una cadena no vacía (EX-EXP-01/EX-EXP-11): recibido ${JSON.stringify(value)}.`);
  }
  return value;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`ExpedienteInputs.${field} es obligatorio y debe ser un arreglo (puede estar vacío, pero no omitirse) (EX-EXP-01/EX-EXP-11): recibido ${JSON.stringify(value)}.`);
  }
  return value;
}

interface InputComponent {
  key: string;
  /** Valor crudo tal cual se le pasa a `sha256Hex` para ese insumo (compartido entre `buildInputRecords` e `inputChanged`, para no duplicar la forma de hashear en dos sitios). */
  raw: unknown;
}

/**
 * Descompone, de forma determinista, un `ExpedienteInputs` validado en
 * runtime (no solo por tipos: un llamador en JS puro, o que burle
 * TypeScript con `any`, también queda cubierto) en sus insumos
 * individuales con clave estable. Es la ÚNICA función del paquete que
 * decide qué entra al hash de alcance "expediente" — ni `apps/api` ni
 * ningún otro consumidor puede pasar un hash calculado por fuera de aquí.
 */
function buildInputComponents(inputs: ExpedienteInputs): InputComponent[] {
  if (inputs === null || typeof inputs !== "object") {
    throw new Error("ExpedienteInputs debe ser un objeto con las 5 categorías obligatorias (EX-EXP-01/EX-EXP-11).");
  }
  const tenderVersionHash = requireString(inputs.tenderVersionHash, "tenderVersionHash");
  const companyProfileHash = requireString(inputs.companyProfileHash, "companyProfileHash");
  const companyDocuments = requireArray(inputs.companyDocuments, "companyDocuments") as ExpedienteInputCompanyDocument[];
  const rates = requireArray(inputs.rates, "rates") as ExpedienteInputRate[];
  const templates = requireArray(inputs.templates, "templates") as ExpedienteInputTemplate[];

  const components: InputComponent[] = [];
  components.push({ key: "tender_version", raw: tenderVersionHash });
  components.push({ key: "company_profile", raw: companyProfileHash });

  for (const doc of [...companyDocuments].sort((a, b) => a.documentId.localeCompare(b.documentId))) {
    components.push({
      key: `company_document:${requireString(doc.documentId, "companyDocuments[].documentId")}`,
      raw: { hash: requireString(doc.hash, "companyDocuments[].hash"), vigenteHasta: doc.vigenteHasta ?? null },
    });
  }
  for (const rate of [...rates].sort((a, b) => a.concept.localeCompare(b.concept))) {
    components.push({
      key: `rate:${requireString(rate.concept, "rates[].concept")}`,
      raw: { hash: requireString(rate.hash, "rates[].hash") },
    });
  }
  for (const tpl of [...templates].sort((a, b) => a.templateId.localeCompare(b.templateId))) {
    components.push({
      key: `template:${requireString(tpl.templateId, "templates[].templateId")}`,
      raw: { hash: requireString(tpl.hash, "templates[].hash") },
    });
  }

  return components.sort((a, b) => a.key.localeCompare(b.key));
}

function buildInputRecords(inputs: ExpedienteInputs): ProposalInputRecord[] {
  return buildInputComponents(inputs).map(({ key, raw }) => ({ key, hash: sha256Hex(raw) }));
}

/**
 * Hash canónico de TODOS los insumos de alcance "expediente" (EX-EXP-01/
 * EX-EXP-11/REQ-161). Única función soportada para producir el
 * `currentInputsHash` que consumen `ApprovalWorkflow`/`PackageAssembler`;
 * un hash construido a mano fuera de esta función (o de
 * `ProposalVersionRegistry.createVersion`, que la usa internamente) NO
 * tiene ninguna garantía de cubrir el conjunto completo de insumos.
 */
export function computeInputsHash(inputs: ExpedienteInputs): string {
  return sha256Hex(buildInputRecords(inputs));
}

export class ProposalVersionRegistry {
  private readonly versions: ProposalVersion[] = [];

  /**
   * Registra una nueva versión a partir del conjunto CERRADO y OBLIGATORIO
   * `ExpedienteInputs` (EX-EXP-01/EX-EXP-11): hashea cada insumo individual
   * y el conjunto completo vía `computeInputsHash`.
   */
  createVersion(inputs: ExpedienteInputs): ProposalVersion {
    const inputRecords = buildInputRecords(inputs);
    const version: ProposalVersion = {
      version: this.versions.length + 1,
      hash: computeInputsHash(inputs),
      createdAt: isoNow(),
      inputs: inputRecords,
    };
    this.versions.push(version);
    return version;
  }

  getVersion(version: number): ProposalVersion | undefined {
    return this.versions.find((v) => v.version === version);
  }

  latest(): ProposalVersion | undefined {
    return this.versions[this.versions.length - 1];
  }

  all(): ProposalVersion[] {
    return [...this.versions];
  }

  /**
   * Compara los insumos ACTUALES contra una versión registrada y devuelve
   * las claves (`"company_document:doc-32d"`, `"rate:consultoria_hora"`,
   * etc.) de los insumos que cambiaron desde entonces, incluyendo insumos
   * que existían antes y ya no están presentes. A diferencia de comparar
   * solo el hash combinado (que dice SI algo cambió), esta función usa
   * `inputChanged()` internamente para decir QUÉ cambió — útil para que
   * `apps/api` explique al usuario por qué se invalidó una aprobación.
   * Conecta `inputChanged()` a un flujo real (antes era código muerto,
   * 0 referencias — EX-EXP-01/EX-EXP-11).
   */
  changedInputsSince(version: ProposalVersion, currentInputs: ExpedienteInputs): string[] {
    const currentComponents = buildInputComponents(currentInputs);
    const currentKeys = new Set(currentComponents.map((c) => c.key));
    const changed = new Set<string>();

    for (const component of currentComponents) {
      if (ProposalVersionRegistry.inputChanged(version, component.key, component.raw)) {
        changed.add(component.key);
      }
    }
    // Un insumo que existía en la versión registrada y ya no está presente
    // (p. ej. un documento retirado) también cuenta como cambio.
    for (const recorded of version.inputs) {
      if (!currentKeys.has(recorded.key)) changed.add(recorded.key);
    }
    return [...changed].sort();
  }

  /** Recalcula el hash de un insumo dado y compara contra el registrado en `version` — permite detectar si cambió desde entonces. */
  static inputChanged(version: ProposalVersion, key: string, currentValue: unknown): boolean {
    const recorded = version.inputs.find((i) => i.key === key);
    if (!recorded) return true; // insumo nuevo, no existía en esa versión: se considera cambio
    return recorded.hash !== sha256Hex(currentValue);
  }
}
