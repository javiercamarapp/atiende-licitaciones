import { canonicalizeWhitespaceAndUnicode, hashRawPayload, stableStringify } from "../util/hash.js";
import { sourceKey, type Attachment, type Classifier, type TenderRecord } from "../types/tender-record.js";

/** Categorías de cambio detectadas entre dos versiones consecutivas de la MISMA convocatoria (ampliación §3). */
export type ChangeKind = "bases" | "aclaraciones" | "anexos" | "plazos" | "estatus" | "otros";

/**
 * Canonicaliza `classifiers[]` para comparación/hash (SR-01): ninguna API
 * real garantiza el mismo orden de array entre dos respuestas (paginación,
 * orden no determinista del backend), así que se ordena por una clave
 * estable (`scheme:code`) para que reordenar el array SIN cambiar su
 * contenido no altere el hash. También normaliza espacios/unicode (NFC) de
 * `code`/`description` para que diferencias incidentales de formato no
 * disparen una versión falsa.
 */
function canonicalClassifiers(classifiers: Classifier[]): Classifier[] {
  return [...classifiers]
    .map((c) => ({
      ...c,
      code: canonicalizeWhitespaceAndUnicode(c.code),
      description: c.description !== undefined ? canonicalizeWhitespaceAndUnicode(c.description) : c.description,
    }))
    .sort((a, b) => `${a.scheme}:${a.code}`.localeCompare(`${b.scheme}:${b.code}`));
}

/**
 * Canonicaliza `attachments[]` para comparación/hash (SR-01): ordena por una
 * clave estable (`url` si existe, si no `name`) y normaliza espacios/unicode
 * del `name`, por la misma razón que `canonicalClassifiers`.
 */
function canonicalAttachments(attachments: Attachment[]): Attachment[] {
  return [...attachments]
    .map((a) => ({ ...a, name: canonicalizeWhitespaceAndUnicode(a.name) }))
    .sort((a, b) => `${a.url ?? ""}:${a.name}`.localeCompare(`${b.url ?? ""}:${b.name}`));
}

/**
 * Subconjunto de `TenderRecord` comparado para versionar (excluye
 * `snapshot`/`sourceCursor`, que cambian en cada fetch aunque el contenido
 * de negocio sea idéntico). Es lo que se hashea para `versionHash`. Los
 * campos de texto pasan por `canonicalizeWhitespaceAndUnicode` y los arrays
 * de `classifiers`/`attachments` por su canonicalización con orden estable
 * (SR-01: ignora orden de claves Y orden de arrays, normaliza espacios/NFC).
 */
function comparableContent(record: TenderRecord) {
  return {
    title: canonicalizeWhitespaceAndUnicode(record.title),
    contractingEntity: canonicalizeWhitespaceAndUnicode(record.contractingEntity),
    procuringUnit: record.procuringUnit !== undefined ? canonicalizeWhitespaceAndUnicode(record.procuringUnit) : record.procuringUnit,
    procedureType: record.procedureType,
    classifiers: canonicalClassifiers(record.classifiers),
    budgetAmount: record.budgetAmount,
    currency: record.currency,
    dates: record.dates,
    status: record.status,
    attachments: canonicalAttachments(record.attachments),
    state: record.state,
  };
}

/** Hash de versión determinista sobre el contenido de negocio (no sobre el payload crudo). Igual contenido -> mismo hash, sin importar cuándo se obtuvo. */
export function computeVersionHash(record: TenderRecord): string {
  return hashRawPayload(comparableContent(record));
}

/**
 * Compara dos versiones de la misma convocatoria y devuelve las categorías
 * de cambio detectadas. `previous === undefined` significa "primera
 * publicación" (no es una modificación, se maneja aparte por el llamador).
 */
export function detectChanges(previous: TenderRecord | undefined, next: TenderRecord): ChangeKind[] {
  if (!previous) return [];
  const changes = new Set<ChangeKind>();

  if (
    canonicalizeWhitespaceAndUnicode(previous.title) !== canonicalizeWhitespaceAndUnicode(next.title) ||
    canonicalizeWhitespaceAndUnicode(previous.contractingEntity) !== canonicalizeWhitespaceAndUnicode(next.contractingEntity) ||
    previous.procedureType !== next.procedureType ||
    previous.budgetAmount !== next.budgetAmount ||
    stableStringify(canonicalClassifiers(previous.classifiers)) !== stableStringify(canonicalClassifiers(next.classifiers))
  ) {
    changes.add("bases");
  }

  if (timeValue(previous.dates.clarificationMeeting) !== timeValue(next.dates.clarificationMeeting)) {
    changes.add("aclaraciones");
  }

  if (
    timeValue(previous.dates.submissionDeadline) !== timeValue(next.dates.submissionDeadline) ||
    timeValue(previous.dates.published) !== timeValue(next.dates.published) ||
    timeValue(previous.dates.award) !== timeValue(next.dates.award)
  ) {
    changes.add("plazos");
  }

  if (stableStringify(canonicalAttachments(previous.attachments)) !== stableStringify(canonicalAttachments(next.attachments))) {
    changes.add("anexos");
  }

  if (previous.status !== next.status) {
    changes.add("estatus");
  }

  if (changes.size === 0 && previous.snapshot.rawHash !== next.snapshot.rawHash) {
    changes.add("otros");
  }

  return [...changes];
}

function timeValue(date: Date | undefined): number | undefined {
  return date ? date.getTime() : undefined;
}

/** true si el nuevo plazo de presentación es ANTERIOR al vigente (caso de prueba obligatorio: "plazo adelantado"). */
export function isDeadlineMovedEarlier(previous: TenderRecord | undefined, next: TenderRecord): boolean {
  const prevDeadline = previous?.dates.submissionDeadline;
  const nextDeadline = next.dates.submissionDeadline;
  if (!prevDeadline || !nextDeadline) return false;
  return nextDeadline.getTime() < prevDeadline.getTime();
}

/** Una versión inmutable y con fecha de una convocatoria, preservada en el historial (nunca se sobreescribe). */
export interface TenderVersion {
  key: string; // sourceKey(record)
  versionHash: string;
  capturedAt: Date;
  changes: ChangeKind[];
  deadlineMovedEarlier: boolean;
  record: TenderRecord;
}

/** Evento emitido cuando una versión nueva difiere de la anterior; los consumidores deben invalidar dependientes (tareas, propuestas) para esa convocatoria. */
export interface ChangeDetectedEvent {
  type: "ChangeDetected";
  key: string;
  changes: ChangeKind[];
  deadlineMovedEarlier: boolean;
  previousVersionHash?: string;
  newVersionHash: string;
  at: Date;
}

/**
 * Historial de versiones en memoria, append-only (nunca se borra ni
 * reescribe una versión ya guardada). `apps/db` implementará el
 * equivalente persistente (REQ-005: raw lake inmutable + REQ-083: bitácora
 * append-only).
 */
export class InMemoryTenderVersionStore {
  private readonly historyByKey = new Map<string, TenderVersion[]>();

  /** Registra `next` como nueva versión si su `versionHash` difiere de la última guardada; idempotente ante reintentos/replay. */
  record(record: TenderRecord, now: Date): { version: TenderVersion; isNew: boolean; event?: ChangeDetectedEvent } {
    const key = sourceKey(record);
    const history = this.historyByKey.get(key) ?? [];
    const last = history[history.length - 1];
    const versionHash = computeVersionHash(record);

    if (last && last.versionHash === versionHash) {
      // Replay/duplicado exacto: no-op idempotente, no se crea versión nueva ni evento.
      return { version: last, isNew: false };
    }

    const changes = detectChanges(last?.record, record);
    const version: TenderVersion = {
      key,
      versionHash,
      capturedAt: now,
      changes,
      deadlineMovedEarlier: isDeadlineMovedEarlier(last?.record, record),
      record,
    };
    this.historyByKey.set(key, [...history, version]);

    if (!last) {
      // Primera publicación: no es un "cambio", no dispara ChangeDetected.
      return { version, isNew: true };
    }

    return {
      version,
      isNew: true,
      event: {
        type: "ChangeDetected",
        key,
        changes,
        deadlineMovedEarlier: version.deadlineMovedEarlier,
        previousVersionHash: last.versionHash,
        newVersionHash: versionHash,
        at: now,
      },
    };
  }

  history(key: string): TenderVersion[] {
    return this.historyByKey.get(key) ?? [];
  }

  latest(key: string): TenderVersion | undefined {
    const history = this.historyByKey.get(key);
    return history?.[history.length - 1];
  }
}
