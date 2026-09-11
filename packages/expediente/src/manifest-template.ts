/**
 * ManifestTemplateRegistry (REQ-028): motor REAL de plantillas versionadas
 * para manifiestos "bajo protesta de decir verdad" — las declaraciones que
 * el representante legal del licitante firma ante el Estado (integridad, no
 * hallarse en los supuestos de conflicto de interés, veracidad de la
 * propuesta económica, etc.).
 *
 * Fuente: docs/REQUISITOS.md REQ-028 — "Manifiestos 'bajo protesta' solo
 * desde plantillas versionadas (`manifest.json` con base legal, variables
 * tipadas, semver, sha256); hueco sin dato = bloqueo rojo, nunca texto
 * inventado" (BLUEPRINT L616-619; rules-licitaciones.pdf §manifiestos).
 * Criterio verificable literal: "0 manifiestos sin `doc_id` de respaldo;
 * cambio de plantilla = gate `legal-doc` → needs-human".
 *
 * Diseño (cada plantilla ES un `manifest.json` real, `ManifestTemplateDefinition`):
 *  - `id` + `version` (semver, `MAYOR.MENOR.PARCHE`): identifican una
 *    plantilla de forma estable a través de sus revisiones. Una vez
 *    registrada, una versión NUNCA se muta in situ (`registerVersion`
 *    congela el objeto); cambiar el texto/base legal/variables exige
 *    registrar una versión NUEVA con semver estrictamente mayor a la más
 *    alta ya registrada para ese `id` — esta es la "migración de versión"
 *    del REQ-028, y `registerVersion` la hace cumplir lanzando si no.
 *  - `legalBasis`: cita de la base legal/fuente de la declaración. Nunca
 *    vacía — una plantilla sin fundamento legal citado es, por definición,
 *    "texto inventado".
 *  - `variables`: esquema TIPADO (`ManifestVariableSpec[]`) de los datos que
 *    el texto necesita — nunca un `Record<string, unknown>` suelto que deje
 *    que cualquier forma de dato "cuele". `render()` valida cada variable
 *    contra su tipo declarado.
 *  - `body`: el texto de la plantilla, con placeholders `{{nombreVariable}}`
 *    que deben corresponder 1:1 a `variables` (un placeholder que referencia
 *    una variable no declarada es un error de AUTORÍA de la plantilla —
 *    `registerVersion` lo rechaza en el momento del registro, no en cada
 *    render).
 *  - `reviewStatus`: **toda plantilla nace `"needs_human"`** — el gate
 *    `legal-doc` del REQ-028 — sin importar lo que declare el llamador de
 *    `registerVersion`. `render()` es fail-closed: rechaza (sin excepción,
 *    como `ManifestRenderResult.ok === false`) cualquier intento de generar
 *    texto a partir de una versión que no haya sido promovida explícitamente
 *    a `"approved"` vía `approveVersion()` por un humano autorizado. Este es
 *    el equivalente exacto, en este módulo, de "verificado_contra_real=false
 *    hasta que exista aprobación legal real": el motor es real y completo,
 *    pero NINGÚN texto legal de producción sale de aquí sin que un humano
 *    haya confirmado la base legal — ver README de este paquete.
 *  - `sha256`: hash real de `(legalBasis, variables, body)` normalizados,
 *    SIEMPRE recalculado por el registro (mismo patrón que `HashedInputs` en
 *    `proposal-version.ts`) — nunca aceptado como dato de entrada, para que
 *    nadie pueda declarar un sha256 "correcto en apariencia" para una
 *    plantilla que en realidad no coincide.
 *
 * `docId` de respaldo (criterio "0 manifiestos sin `doc_id` de respaldo"):
 * todo `ManifestRenderResult` exitoso trae `{templateId, templateVersion,
 * templateSha256}` — la terna que permite a cualquier auditor reconstruir
 * EXACTAMENTE qué plantilla, en qué versión legal, produjo ese texto.
 */
import { sha256Hex, stableStringify, assertExplicitOffset, formatMexicoCityDateTime } from "./types.js";

export type ManifestVariableType = "string" | "number" | "boolean" | "date" | "enum";

export interface ManifestVariableSpec {
  /** Nombre del placeholder en `body` (sin llaves), p. ej. "razonSocial". */
  name: string;
  type: ManifestVariableType;
  required: boolean;
  /** Solo válido (y obligatorio) para `type === "enum"`: valores permitidos, sin duplicados. */
  enumValues?: readonly string[];
  /**
   * Valor a usar cuando la variable no se proporciona y `required === false`.
   * Es parte de la plantilla APROBADA (decisión legal congelada junto con el
   * resto de la versión), nunca un valor inventado en tiempo de render.
   */
  defaultValue?: string | number | boolean;
  /** Solo para `type === "boolean"`: cómo renderizar `true`/`false` en el texto (default "Sí"/"No"). */
  trueLabel?: string;
  falseLabel?: string;
  /** Documentación para UI/auditoría — no afecta la validación. */
  description?: string;
}

export type ManifestTemplateReviewStatus = "needs_human" | "approved";

/** Entrada que el llamador provee a `registerVersion` — el `manifest.json` de una plantilla nueva. */
export interface ManifestTemplateInput {
  id: string;
  version: string;
  legalBasis: string;
  variables: ManifestVariableSpec[];
  body: string;
}

/** Lo que el registro guarda y expone: el input sellado + metadatos calculados/controlados por el registro. */
export interface ManifestTemplateDefinition extends Omit<ManifestTemplateInput, "variables"> {
  readonly variables: readonly Readonly<ManifestVariableSpec>[];
  readonly sha256: string;
  readonly reviewStatus: ManifestTemplateReviewStatus;
  readonly registeredAt: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
}

export interface ManifestDocId {
  templateId: string;
  templateVersion: string;
  templateSha256: string;
}

export type ManifestDataGapReason =
  | "template_not_found"
  | "template_not_approved"
  | "missing"
  | "wrong_type"
  | "invalid_enum_value";

export interface ManifestDataGap {
  /** Nombre de la variable con el hueco, o "__template__" si el problema es de resolución de plantilla, no de datos. */
  variable: string;
  reason: ManifestDataGapReason;
  detail: string;
}

export type ManifestRenderResult =
  | { ok: true; text: string; docId: ManifestDocId }
  | { ok: false; gaps: ManifestDataGap[] };

/** Referencia a una plantilla: versión exacta, o `"latest_approved"` (la versión `approved` de semver más alto para ese `id`). */
export type ManifestTemplateRef = { id: string; version: string } | { id: string; version: "latest_approved" };

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

function parseSemver(version: string): [number, number, number] {
  const match = SEMVER_PATTERN.exec(version.trim());
  if (!match) {
    throw new Error(
      `ManifestTemplateRegistry: version "${version}" no es un semver válido (se espera "MAYOR.MENOR.PARCHE", p. ej. "1.0.0").`,
    );
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** -1 si `a` < `b`, 0 si son iguales, 1 si `a` > `b`. Lanza si alguno no es semver válido. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const [amaj, amin, apat] = parseSemver(a);
  const [bmaj, bmin, bpat] = parseSemver(b);
  if (amaj !== bmaj) return amaj < bmaj ? -1 : 1;
  if (amin !== bmin) return amin < bmin ? -1 : 1;
  if (apat !== bpat) return apat < bpat ? -1 : 1;
  return 0;
}

function computeTemplateSha256(input: Pick<ManifestTemplateInput, "legalBasis" | "variables" | "body">): string {
  return sha256Hex(
    stableStringify({
      legalBasis: input.legalBasis,
      variables: input.variables,
      body: input.body,
    }),
  );
}

function extractPlaceholderNames(body: string): Set<string> {
  const names = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) names.add(match[1]);
  return names;
}

function validateDefinitionShape(input: ManifestTemplateInput): void {
  if (input.id.trim().length === 0) {
    throw new Error("ManifestTemplateRegistry.registerVersion: \"id\" no puede estar vacío.");
  }
  if (input.legalBasis.trim().length === 0) {
    throw new Error(
      `ManifestTemplateRegistry.registerVersion: plantilla "${input.id}@${input.version}" sin "legalBasis" — una plantilla sin base legal citada es, por definición, texto inventado (REQ-028).`,
    );
  }
  if (input.body.trim().length === 0) {
    throw new Error(`ManifestTemplateRegistry.registerVersion: plantilla "${input.id}@${input.version}" con "body" vacío.`);
  }
  parseSemver(input.version); // valida formato; lanza si es inválido.

  const seenNames = new Set<string>();
  for (const v of input.variables) {
    if (v.name.trim().length === 0) {
      throw new Error(`ManifestTemplateRegistry.registerVersion: plantilla "${input.id}@${input.version}" tiene una variable con "name" vacío.`);
    }
    if (seenNames.has(v.name)) {
      throw new Error(`ManifestTemplateRegistry.registerVersion: plantilla "${input.id}@${input.version}" declara la variable "${v.name}" más de una vez.`);
    }
    seenNames.add(v.name);
    if (v.type === "enum" && (!v.enumValues || v.enumValues.length === 0)) {
      throw new Error(`ManifestTemplateRegistry.registerVersion: variable "${v.name}" de tipo "enum" en "${input.id}@${input.version}" requiere "enumValues" no vacío.`);
    }
    if (v.type !== "enum" && v.enumValues) {
      throw new Error(`ManifestTemplateRegistry.registerVersion: variable "${v.name}" en "${input.id}@${input.version}" declara "enumValues" pero su tipo es "${v.type}", no "enum".`);
    }
    if (!v.required && v.defaultValue === undefined) {
      // Permitido: una variable opcional sin default simplemente se omite del
      // texto renderizado si el placeholder correspondiente no existe en el
      // cuerpo condicionalmente — pero como este motor no soporta bloques
      // condicionales, una variable opcional SIN default y CON placeholder en
      // el body dejaría un hueco irreconciliable en cada render. Se detecta
      // más abajo (unknownOrUnresolvable) comparando contra los placeholders
      // reales del body.
    }
  }

  const declaredNames = new Set(input.variables.map((v) => v.name));
  const placeholders = extractPlaceholderNames(input.body);
  const undeclaredPlaceholders = [...placeholders].filter((p) => !declaredNames.has(p));
  if (undeclaredPlaceholders.length > 0) {
    throw new Error(
      `ManifestTemplateRegistry.registerVersion: plantilla "${input.id}@${input.version}" referencia en "body" la(s) variable(s) no declarada(s) en "variables": ${undeclaredPlaceholders.join(", ")}.`,
    );
  }
  // Una variable opcional sin default que NO aparece en el body es benigna
  // (documental/futura); si aparece en el body, exigimos required=true o
  // defaultValue definido, para que render() nunca tenga que inventar texto.
  for (const v of input.variables) {
    if (!v.required && v.defaultValue === undefined && placeholders.has(v.name)) {
      throw new Error(
        `ManifestTemplateRegistry.registerVersion: variable "${v.name}" en "${input.id}@${input.version}" es opcional sin "defaultValue" pero aparece como placeholder en "body" — declárela required, o defina un defaultValue explícito (nunca se infiere uno en render()).`,
      );
    }
  }
}

function formatValue(spec: ManifestVariableSpec, value: string | number | boolean): { formatted: string } | { gap: ManifestDataGap } {
  switch (spec.type) {
    case "string": {
      if (typeof value !== "string" || value.trim().length === 0) {
        return { gap: { variable: spec.name, reason: "wrong_type", detail: `Se esperaba un string no vacío para "${spec.name}", se recibió ${JSON.stringify(value)}.` } };
      }
      return { formatted: value };
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { gap: { variable: spec.name, reason: "wrong_type", detail: `Se esperaba un número finito para "${spec.name}", se recibió ${JSON.stringify(value)}.` } };
      }
      return { formatted: String(value) };
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        return { gap: { variable: spec.name, reason: "wrong_type", detail: `Se esperaba un booleano para "${spec.name}", se recibió ${JSON.stringify(value)}.` } };
      }
      return { formatted: value ? spec.trueLabel ?? "Sí" : spec.falseLabel ?? "No" };
    }
    case "date": {
      if (typeof value !== "string") {
        return { gap: { variable: spec.name, reason: "wrong_type", detail: `Se esperaba una fecha ISO 8601 (string) para "${spec.name}", se recibió ${JSON.stringify(value)}.` } };
      }
      try {
        assertExplicitOffset(value, `variable "${spec.name}"`);
      } catch (err) {
        return { gap: { variable: spec.name, reason: "wrong_type", detail: err instanceof Error ? err.message : String(err) } };
      }
      return { formatted: formatMexicoCityDateTime(value) };
    }
    case "enum": {
      if (typeof value !== "string" || !spec.enumValues!.includes(value)) {
        return {
          gap: {
            variable: spec.name,
            reason: "invalid_enum_value",
            detail: `Valor ${JSON.stringify(value)} no está entre los permitidos para "${spec.name}": ${spec.enumValues!.join(", ")}.`,
          },
        };
      }
      return { formatted: value };
    }
  }
}

/**
 * Registro de plantillas de manifiesto versionadas. Instancia en memoria:
 * `apps/api` es responsable de respaldarlo con persistencia real (tabla
 * `manifest_templates` o equivalente) cuando ese cableado se construya —
 * este paquete, como el resto de `packages/expediente`, es una librería
 * pura sin dependencia de base de datos (ver `types.ts`).
 */
export class ManifestTemplateRegistry {
  private readonly byIdVersion = new Map<string, ManifestTemplateDefinition>();

  private key(id: string, version: string): string {
    return `${id}@${version}`;
  }

  /**
   * Registra una versión NUEVA de una plantilla. Nace SIEMPRE en
   * `reviewStatus: "needs_human"` (gate `legal-doc`, REQ-028) — el
   * `reviewStatus` no es un parámetro de entrada, precisamente para que
   * nadie pueda "auto-aprobarse" al registrar.
   *
   * Migración de versión: si `id` ya tiene versiones registradas, `version`
   * debe ser semver ESTRICTAMENTE mayor a la más alta ya registrada para ese
   * `id` — de lo contrario lanza (nunca se sobre-escribe ni se retrocede una
   * versión ya publicada).
   */
  registerVersion(input: ManifestTemplateInput): ManifestTemplateDefinition {
    validateDefinitionShape(input);
    if (this.byIdVersion.has(this.key(input.id, input.version))) {
      throw new Error(`ManifestTemplateRegistry.registerVersion: "${input.id}@${input.version}" ya está registrada — las versiones son inmutables, registre un semver nuevo.`);
    }
    const existingVersions = this.listVersions(input.id).map((t) => t.version);
    const highestExisting = existingVersions.reduce<string | null>(
      (max, v) => (max === null || compareSemver(v, max) > 0 ? v : max),
      null,
    );
    if (highestExisting !== null && compareSemver(input.version, highestExisting) <= 0) {
      throw new Error(
        `ManifestTemplateRegistry.registerVersion: "${input.id}@${input.version}" no es mayor que la versión más alta ya registrada ("${highestExisting}") — la migración de plantilla exige semver estrictamente creciente.`,
      );
    }

    const sealed: ManifestTemplateDefinition = Object.freeze({
      id: input.id,
      version: input.version,
      legalBasis: input.legalBasis,
      variables: Object.freeze(input.variables.map((v) => Object.freeze({ ...v }))),
      body: input.body,
      sha256: computeTemplateSha256(input),
      reviewStatus: "needs_human",
      registeredAt: new Date().toISOString(),
    });
    this.byIdVersion.set(this.key(input.id, input.version), sealed);
    return sealed;
  }

  /**
   * Promueve una versión de `"needs_human"` a `"approved"` — el único cruce
   * del gate `legal-doc`. Debe llamarse explícitamente con la identidad de
   * quien aprueba; no hay aprobación implícita ni automática en ningún punto
   * de este módulo.
   */
  approveVersion(id: string, version: string, approvedBy: string, approvedAtIso: string = new Date().toISOString()): ManifestTemplateDefinition {
    const existing = this.byIdVersion.get(this.key(id, version));
    if (!existing) {
      throw new Error(`ManifestTemplateRegistry.approveVersion: no existe la plantilla "${id}@${version}".`);
    }
    if (existing.reviewStatus === "approved") {
      throw new Error(`ManifestTemplateRegistry.approveVersion: "${id}@${version}" ya está aprobada (por "${existing.approvedBy}" el ${existing.approvedAt}) — la aprobación no se reemplaza, registre una versión nueva si el texto cambió.`);
    }
    if (approvedBy.trim().length === 0) {
      throw new Error("ManifestTemplateRegistry.approveVersion: \"approvedBy\" no puede estar vacío — la aprobación debe ser atribuible a una persona real.");
    }
    const approved: ManifestTemplateDefinition = Object.freeze({
      ...existing,
      reviewStatus: "approved",
      approvedBy,
      approvedAt: approvedAtIso,
    });
    this.byIdVersion.set(this.key(id, version), approved);
    return approved;
  }

  /** Todas las versiones registradas de `id` (cualquier `reviewStatus`), sin ordenar. */
  listVersions(id: string): ManifestTemplateDefinition[] {
    return [...this.byIdVersion.values()].filter((t) => t.id === id);
  }

  /** Versión exacta, o `undefined` si no existe. */
  getVersion(id: string, version: string): ManifestTemplateDefinition | undefined {
    return this.byIdVersion.get(this.key(id, version));
  }

  /** La versión `approved` de semver más alto para `id`, o `undefined` si no hay ninguna aprobada (aunque existan versiones `needs_human`). */
  getLatestApproved(id: string): ManifestTemplateDefinition | undefined {
    const approved = this.listVersions(id).filter((t) => t.reviewStatus === "approved");
    if (approved.length === 0) return undefined;
    return approved.reduce((latest, t) => (compareSemver(t.version, latest.version) > 0 ? t : latest));
  }

  private resolve(ref: ManifestTemplateRef): ManifestTemplateDefinition | undefined {
    if (ref.version === "latest_approved") return this.getLatestApproved(ref.id);
    return this.getVersion(ref.id, ref.version);
  }

  /**
   * Renderiza un manifiesto a partir de una plantilla ya APROBADA y de los
   * valores de variable proporcionados. Fail-closed en cada paso — nunca
   * lanza por datos de negocio faltantes/incorrectos (eso son
   * `ManifestDataGap`, no excepciones): un `ManifestRenderResult` con
   * `ok: false` es el "bloqueo rojo" del criterio de REQ-028. Solo lanza por
   * errores de PROGRAMACIÓN del llamador que `registerVersion` no pudo
   * detectar de antemano (no debería ocurrir en práctica, dado que
   * `registerVersion` ya valida la forma de la plantilla).
   */
  render(ref: ManifestTemplateRef, variables: Readonly<Record<string, string | number | boolean | undefined>>): ManifestRenderResult {
    const template = this.resolve(ref);
    if (!template) {
      return {
        ok: false,
        gaps: [
          {
            variable: "__template__",
            reason: "template_not_found",
            detail: ref.version === "latest_approved"
              ? `No existe ninguna versión APROBADA de la plantilla "${ref.id}" (puede que existan versiones "needs_human" pendientes del gate legal-doc, o que "${ref.id}" no exista en absoluto).`
              : `No existe la plantilla "${ref.id}@${ref.version}".`,
          },
        ],
      };
    }
    if (template.reviewStatus !== "approved") {
      return {
        ok: false,
        gaps: [
          {
            variable: "__template__",
            reason: "template_not_approved",
            detail: `La plantilla "${template.id}@${template.version}" está en "needs_human" (gate legal-doc, REQ-028) — un humano autorizado debe aprobarla con ManifestTemplateRegistry.approveVersion antes de poder generar manifiestos con ella.`,
          },
        ],
      };
    }

    const gaps: ManifestDataGap[] = [];
    const formattedByName = new Map<string, string>();
    for (const spec of template.variables) {
      const provided = variables[spec.name];
      const effective = provided === undefined ? spec.defaultValue : provided;
      if (effective === undefined) {
        gaps.push({
          variable: spec.name,
          reason: "missing",
          detail: `Variable requerida "${spec.name}" no fue proporcionada y la plantilla "${template.id}@${template.version}" no declara un valor por defecto — hueco sin dato, bloqueo (REQ-028), nunca texto inventado.`,
        });
        continue;
      }
      const result = formatValue(spec, effective);
      if ("gap" in result) {
        gaps.push(result.gap);
        continue;
      }
      formattedByName.set(spec.name, result.formatted);
    }

    if (gaps.length > 0) {
      return { ok: false, gaps };
    }

    const text = template.body.replace(PLACEHOLDER_PATTERN, (_match, name: string) => {
      // Invariante garantizado por registerVersion (todo placeholder tiene
      // variable declarada) + el bucle anterior (toda variable declarada ya
      // fue formateada o generó un gap que ya habría cortado la ejecución
      // arriba): `formattedByName.get(name)` siempre existe aquí.
      return formattedByName.get(name)!;
    });

    return {
      ok: true,
      text,
      docId: { templateId: template.id, templateVersion: template.version, templateSha256: template.sha256 },
    };
  }
}
