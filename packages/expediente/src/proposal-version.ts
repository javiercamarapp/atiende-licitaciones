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
 * completamente ciegos al cambio. `createVersion`/`computeInputsHash`
 * exigen `ExpedienteInputs`: un conjunto CERRADO y OBLIGATORIO (versión de
 * bases, documentos de empresa usados con su vigencia, tarifas usadas,
 * datos de perfil, plantillas) que TypeScript fuerza a declarar completo —
 * el llamador ya NO puede "olvidar" un insumo.
 *
 * EX-EXP-17 (reverificación ronda 2, ALTA — mismo hilo que EX-EXP-01/11):
 * lo anterior dejaba, sin embargo, un hueco estructural: `computeInputsHash`
 * era correcta pero NADA obligaba a usarla en el punto de uso.
 * `ApprovalWorkflow.approve()`/`PackageAssembler.buildManifest()` aceptaban
 * `inputsHash`/`currentInputsHash` como un `string` plano, así que un
 * llamador podía aprobar/ensamblar con un hash calculado a mano
 * (`sha256Hex("cualquier-cosa")`, sin relación con `ExpedienteInputs`) y
 * `buildManifest` lo marcaba `"ready"` sin protesta. Ahora:
 *  - `computeInputsHash` devuelve un tipo BRANDED `InputsHash` (`string &
 *    { [INPUTS_HASH_BRAND]: true }`) que NINGÚN otro código puede producir
 *    por asignación directa sin un cast explícito (rechazo en TIEMPO DE
 *    COMPILACIÓN de un `string` suelto).
 *  - `sealInputs(inputs)` devuelve un `HashedInputs` — un objeto `{ inputs,
 *    hash }` con una propiedad de símbolo PRIVADA (`SEALED_MARKER`, no
 *    exportada) que solo este módulo puede adjuntar. `approve()`/
 *    `buildManifest()`/`revalidateAgainstCurrentHash` ya NO reciben un
 *    `string`: exigen un `HashedInputs` y lo verifican con
 *    `requireValidHashedInputs()`, que (a) comprueba la presencia del
 *    símbolo privado — un objeto ensamblado a mano fuera de este módulo
 *    JAMÁS puede tener esa propiedad, porque el símbolo ni siquiera se
 *    exporta — y (b) RECALCULA `computeInputsHash(value.inputs)` y lo
 *    compara contra `value.hash`: si los insumos referenciados se
 *    mutaron después de sellarse, la recomputación ya no coincide y se
 *    rechaza igual. Cualquier fallo lanza `InvalidInputsHashError` en
 *    runtime — incluyendo un mensaje explícito de migración si lo que
 *    llega es un `string` plano (deprecado por inseguro, no silenciosamente
 *    aceptado).
 *
 * REVERIFY3-EXP-A (corrector, severidad BAJA/documental — mismo hilo que
 * EX-EXP-17): la comprobación de (a) arriba usaba acceso de propiedad
 * NORMAL (`value[SEALED_MARKER]`), que RECORRE LA CADENA DE PROTOTIPOS —
 * `Object.create(unHashedInputsAjenoLegítimo)`, con `inputs`/`hash` PROPIOS
 * auto-coherentes (un hash que sí recalcula correctamente), HEREDABA el
 * símbolo del prototipo y pasaba la verificación sin haber invocado nunca
 * `sealInputs`. No era una escalada de privilegio explotable (quien puede
 * ejecutar ese ataque ya podía llamar `sealInputs`/`computeInputsHash`
 * directamente, funciones públicas, con el mismo efecto), pero la
 * afirmación "ningún código externo puede construir un objeto con esta
 * clave" era imprecisa: un objeto que solo HEREDA la clave sí pasaba.
 * Corregido con dos capas ahora en `isSealedHashedInputs`: (a)
 * `Object.hasOwn(value, SEALED_MARKER)` en vez de acceso normal — exige que
 * el símbolo sea propiedad PROPIA, nunca heredada — y (b) el `WeakSet`
 * `sealedInstances`, que registra por IDENTIDAD de objeto (no por
 * estructura) únicamente las instancias que `sealInputs` construyó y
 * devolvió; un objeto forjado con `Object.create(...)` es una referencia
 * NUEVA que jamás puede pertenecer a ese `WeakSet`.
 */
import { isoNow, sha256Hex } from "./types.js";

/**
 * Símbolo PRIVADO del módulo (nunca exportado): es la única forma de que un
 * objeto `HashedInputs` cuente como "sellado" por `sealInputs`/
 * `computeInputsHash`. Como los símbolos son valores únicos por identidad y
 * este NO se exporta, ningún código externo puede añadir esta clave como
 * PROPIEDAD PROPIA de un objeto nuevo — ni siquiera con
 * `Object.getOwnPropertySymbols` sobre una instancia ajena podría
 * reutilizarlo para fabricar un objeto nuevo con el mismo símbolo salvo que
 * copie la referencia real (que nunca sale de este módulo). Precisión
 * añadida tras REVERIFY3-EXP-A: esto por sí solo NO bastaba, porque un
 * objeto puede HEREDAR el símbolo vía `Object.create(objetoAjeno)` sin
 * copiarlo como propiedad propia — de ahí que `isSealedHashedInputs` exija
 * además `Object.hasOwn` (propiedad propia, no heredada) y pertenencia al
 * `WeakSet` `sealedInstances` (identidad exacta de la instancia devuelta
 * por `sealInputs`, ver más abajo). Con ambas capas, la verificación es "no
 * falsificable desde fuera del módulo" en sentido estricto — ni copiando el
 * símbolo (imposible, no se exporta) ni heredándolo (bloqueado por
 * `hasOwn` + `WeakSet`) — (EX-EXP-17 / REVERIFY3-EXP-A).
 */
const SEALED_MARKER: unique symbol = Symbol("expediente:HashedInputs");

/**
 * Segunda barrera, independiente del símbolo privado (REVERIFY3-EXP-A,
 * corrector BAJA): `isSealedHashedInputs` originalmente leía
 * `value[SEALED_MARKER]` con acceso de propiedad NORMAL, que recorre la
 * cadena de prototipos — `Object.create(unHashedInputsLegitimoAjeno)` con
 * `inputs`/`hash` PROPIOS y auto-coherentes HEREDA el símbolo del prototipo
 * y pasaba la verificación sin haber pasado nunca por `sealInputs`. Este
 * `WeakSet` registra, por IDENTIDAD de objeto (nunca por estructura ni por
 * herencia), únicamente las instancias que `sealInputs` construyó y devolvió
 * directamente: un objeto forjado con `Object.create(...)` es una referencia
 * NUEVA que jamás puede estar aquí, sin importar qué propiedades propias
 * declare o qué símbolos herede.
 */
const sealedInstances = new WeakSet<object>();

/** Símbolo de marca (privado) usado solo a nivel de TIPOS para "brandear" `InputsHash`; nunca existe en runtime sobre un `string` (los primitivos no cargan propiedades), es puramente una técnica de nominal typing de TypeScript. */
declare const INPUTS_HASH_BRAND: unique symbol;

/**
 * Hash de insumos de alcance "expediente", producido EXCLUSIVAMENTE por
 * `computeInputsHash(inputs)` (EX-EXP-17). El brand a nivel de tipos
 * rechaza en TIEMPO DE COMPILACIÓN cualquier intento de pasar un `string`
 * suelto donde se espera un `InputsHash` — un llamador tendría que forzar
 * un cast (`as unknown as InputsHash`) para burlarlo, y en ese caso
 * `requireValidHashedInputs`/`HashedInputs` (que exige además el símbolo
 * privado) sigue rechazándolo en RUNTIME.
 */
export type InputsHash = string & { readonly [INPUTS_HASH_BRAND]: true };

/**
 * Envoltorio sellado de un hash de insumos ya verificado (EX-EXP-17):
 * conserva tanto el `ExpedienteInputs` de origen como su `InputsHash`, y
 * está marcado internamente con `SEALED_MARKER` (símbolo privado). Es el
 * tipo que `ApprovalWorkflow.approve()`, `revalidateAgainstCurrentHash`,
 * `isFullyApprovedForCurrentHash` y `PackageAssembler.buildManifest` exigen
 * en vez de un `string` — se obtiene con `sealInputs(inputs)` o leyendo
 * `ProposalVersion.hash` de `ProposalVersionRegistry.createVersion`.
 */
export interface HashedInputs {
  readonly inputs: ExpedienteInputs;
  readonly hash: InputsHash;
}

/** Lanzado cuando `approve()`/`buildManifest()`/`revalidateAgainstCurrentHash()` reciben algo que no es un `HashedInputs` sellado producido por `sealInputs`/`computeInputsHash` de este módulo (EX-EXP-17): un `string` plano (incluso el hash "correcto" calculado por fuera), un objeto sin el símbolo privado, o un `HashedInputs` cuyos `inputs` fueron mutados después de sellarse (la recomputación ya no coincide con `hash`). */
export class InvalidInputsHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputsHashError";
  }
}

interface SealedHashedInputs extends HashedInputs {
  readonly [SEALED_MARKER]: true;
}

/**
 * Verifica que `value` sea un objeto `SealedHashedInputs` legítimo — es
 * decir, la referencia EXACTA devuelta por `sealInputs` — nunca un objeto
 * que meramente HEREDE el símbolo privado vía prototipo
 * (`Object.create(selladoAjeno)`, REVERIFY3-EXP-A). Tres comprobaciones,
 * las tres necesarias:
 *  1. `Object.hasOwn(value, SEALED_MARKER)`: a diferencia del acceso de
 *     propiedad normal (`value[SEALED_MARKER]`, que recorre la cadena de
 *     prototipos), `Object.hasOwn` exige que el símbolo sea una propiedad
 *     PROPIA del objeto — un objeto que solo lo heredó de su prototipo
 *     falla aquí.
 *  2. `inputs`/`hash` también deben ser propiedades PROPIAS: un objeto que
 *     declare `inputs`/`hash` propios (auto-coherentes) pero herede
 *     `SEALED_MARKER` ya falla en (1); esta comprobación es defensa
 *     adicional por si en el futuro `SEALED_MARKER` dejara de ser
 *     enumerable de la misma forma.
 *  3. `sealedInstances.has(value)`: segunda barrera POR IDENTIDAD, no por
 *     estructura — ni copiar el símbolo como propiedad propia (imposible
 *     desde fuera, no se exporta) ni heredar el prototipo cambia que el
 *     objeto forjado es una referencia NUEVA, jamás añadida por
 *     `sealInputs`.
 */
function isSealedHashedInputs(value: unknown): value is SealedHashedInputs {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.hasOwn(value, SEALED_MARKER) &&
    (value as Record<symbol, unknown>)[SEALED_MARKER] === true &&
    Object.hasOwn(value, "inputs") &&
    Object.hasOwn(value, "hash") &&
    sealedInstances.has(value)
  );
}

/**
 * Sella `inputs` en un `HashedInputs` verificable (EX-EXP-17): calcula su
 * `InputsHash` canónico vía `computeInputsHash` y adjunta el símbolo
 * privado que `requireValidHashedInputs` exige. Es la única forma soportada
 * de producir un valor que `approve()`/`buildManifest()` acepten
 * directamente (además de `ProposalVersionRegistry.createVersion`, que la
 * usa internamente para poblar `ProposalVersion.hash`).
 */
export function sealInputs(inputs: ExpedienteInputs): HashedInputs {
  const hash = computeInputsHash(inputs);
  const sealed: SealedHashedInputs = {
    inputs,
    hash,
    [SEALED_MARKER]: true,
  };
  sealedInstances.add(sealed);
  return sealed;
}

/**
 * Verifica que `value` sea un `HashedInputs` legítimo antes de usarlo para
 * decidir una aprobación/ensamblaje (EX-EXP-17). Fail-closed: cualquier
 * discrepancia lanza `InvalidInputsHashError`, nunca deja pasar un valor
 * dudoso "por si acaso".
 *  1. Si `value` es un `string` (el hueco original de EX-EXP-17: pasar un
 *     hash calculado a mano), lanza con un mensaje de migración explícito
 *     — el soporte de `string` está DEPRECADO, no aceptado en silencio.
 *  2. Si no trae el símbolo privado `SEALED_MARKER`, no pudo haber sido
 *     producido por `sealInputs`/`computeInputsHash` de este módulo.
 *  3. Recalcula `computeInputsHash(value.inputs)` y lo compara contra
 *     `value.hash`: si alguien mutó el objeto `inputs` referenciado
 *     DESPUÉS de sellarlo, la recomputación ya no coincide.
 */
export function requireValidHashedInputs(value: unknown, label: string): HashedInputs {
  if (typeof value === "string") {
    throw new InvalidInputsHashError(
      `${label}: se recibió un hash de insumos como STRING PLANO ("${value}"). Esto está DEPRECADO por inseguro ` +
        `(EX-EXP-17): cualquier string suelto —incluso uno "correcto" calculado por fuera— podía aprobar/ensamblar ` +
        `un expediente sin relación real con sus insumos. Use computeInputsHash(inputs) + sealInputs(inputs) (o ` +
        `ProposalVersionRegistry.createVersion(inputs).hash) y pase ese HashedInputs aquí. Ver README §"Hash de insumos".`,
    );
  }
  if (!isSealedHashedInputs(value)) {
    throw new InvalidInputsHashError(
      `${label}: se esperaba un HashedInputs producido por sealInputs()/computeInputsHash() de este módulo (EX-EXP-17); ` +
        `se recibió un objeto sin el sello interno (no puede haberse construido fuera de proposal-version.ts).`,
    );
  }
  const recomputed = computeInputsHash(value.inputs);
  if (recomputed !== value.hash) {
    throw new InvalidInputsHashError(
      `${label}: los ExpedienteInputs sellados fueron MUTADOS después de sellarse — el hash recalculado ` +
        `("${recomputed}") ya no coincide con el hash registrado ("${value.hash}"). Un HashedInputs se invalida si ` +
        `su objeto \`inputs\` cambia después de \`sealInputs()\` (EX-EXP-17).`,
    );
  }
  return { inputs: value.inputs, hash: value.hash };
}

export interface ProposalInputRecord {
  /** p. ej. "tender_version", "company_profile", "company_document:doc-32d", "rate:consultoria_hora" */
  key: string;
  hash: string;
}

export interface ProposalVersion {
  version: number;
  /** `HashedInputs` sellado (EX-EXP-17): pásese tal cual a `ApprovalWorkflow.approve()`/`buildManifest()`, nunca extraiga `.hash` "a mano" para reconstruir un `string`. */
  hash: HashedInputs;
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
export function computeInputsHash(inputs: ExpedienteInputs): InputsHash {
  return sha256Hex(buildInputRecords(inputs)) as InputsHash;
}

export class ProposalVersionRegistry {
  private readonly versions: ProposalVersion[] = [];

  /**
   * Registra una nueva versión a partir del conjunto CERRADO y OBLIGATORIO
   * `ExpedienteInputs` (EX-EXP-01/EX-EXP-11): hashea cada insumo individual
   * y el conjunto completo vía `computeInputsHash`, y sella el resultado con
   * `sealInputs` (EX-EXP-17) para que `.hash` se pueda pasar directamente a
   * `ApprovalWorkflow.approve()`/`PackageAssembler.buildManifest()`.
   */
  createVersion(inputs: ExpedienteInputs): ProposalVersion {
    const inputRecords = buildInputRecords(inputs);
    const version: ProposalVersion = {
      version: this.versions.length + 1,
      hash: sealInputs(inputs),
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
