import { describe, expect, it } from "vitest";
import { computeCrossSourceFingerprint } from "../src/dedupe/fingerprint.js";
import { computeVersionHash, detectChanges, isDeadlineMovedEarlier, InMemoryTenderVersionStore } from "../src/dedupe/version.js";
import { parseTenderRecord, sourceKey, type TenderRecord } from "../src/types/tender-record.js";

function baseRecord(overrides: Record<string, unknown> = {}): TenderRecord {
  return parseTenderRecord({
    source: "ocds-shcp",
    externalId: "LA-000-2026",
    title: "Adquisición de equipo de cómputo",
    contractingEntity: "Secretaría de Educación Pública",
    procedureType: "licitacion_publica",
    classifiers: [{ scheme: "UNSPSC", code: "43211500" }],
    budgetAmount: 1000000,
    currency: "MXN",
    dates: { published: "2026-08-01T00:00:00Z", submissionDeadline: "2026-09-01T00:00:00Z" },
    status: "published",
    attachments: [],
    snapshot: { fetchedAt: new Date("2026-08-01T00:00:00Z"), rawHash: "a".repeat(64) },
    ...overrides,
  });
}

describe("computeCrossSourceFingerprint", () => {
  it("produce la misma huella para el mismo título/entidad/fecha aunque source y externalId difieran", () => {
    const a = baseRecord({ source: "dof", externalId: "5900001:LA-000-2026" });
    const b = baseRecord({ source: "ocds-shcp", externalId: "LA-000-2026" });
    expect(computeCrossSourceFingerprint(a)).toBe(computeCrossSourceFingerprint(b));
  });

  it("cambia si el título difiere de forma sustantiva", () => {
    const a = baseRecord();
    const b = baseRecord({ title: "Servicio de limpieza integral" });
    expect(computeCrossSourceFingerprint(a)).not.toBe(computeCrossSourceFingerprint(b));
  });

  it("es insensible a mayúsculas/acentos/puntuación en el título", () => {
    const a = baseRecord({ title: "Adquisición de Equipo de Cómputo" });
    const b = baseRecord({ title: "ADQUISICION DE EQUIPO DE COMPUTO!!" });
    expect(computeCrossSourceFingerprint(a)).toBe(computeCrossSourceFingerprint(b));
  });
});

describe("computeVersionHash / detectChanges", () => {
  it("el mismo contenido de negocio produce el mismo versionHash aunque cambie el snapshot/fetchedAt", () => {
    const a = baseRecord({ snapshot: { fetchedAt: new Date("2026-08-01T00:00:00Z"), rawHash: "a".repeat(64) } });
    const b = baseRecord({ snapshot: { fetchedAt: new Date("2026-08-02T12:00:00Z"), rawHash: "b".repeat(64) } });
    expect(computeVersionHash(a)).toBe(computeVersionHash(b));
  });

  it("detecta 'plazos' cuando la fecha límite de presentación cambia", () => {
    const previous = baseRecord();
    const next = baseRecord({ dates: { published: "2026-08-01T00:00:00Z", submissionDeadline: "2026-08-20T00:00:00Z" } });
    expect(detectChanges(previous, next)).toContain("plazos");
    expect(isDeadlineMovedEarlier(previous, next)).toBe(true);
  });

  it("no marca isDeadlineMovedEarlier si el plazo se amplía", () => {
    const previous = baseRecord();
    const next = baseRecord({ dates: { published: "2026-08-01T00:00:00Z", submissionDeadline: "2026-10-01T00:00:00Z" } });
    expect(isDeadlineMovedEarlier(previous, next)).toBe(false);
  });

  it("detecta 'anexos' cuando cambian los documentos adjuntos", () => {
    const previous = baseRecord();
    const next = baseRecord({ attachments: [{ name: "Bases", url: "https://example.gob.mx/bases.pdf" }] });
    expect(detectChanges(previous, next)).toContain("anexos");
  });

  it("detecta 'aclaraciones' cuando cambia la fecha de junta de aclaraciones", () => {
    const previous = baseRecord({ dates: { published: "2026-08-01T00:00:00Z" } });
    const next = baseRecord({ dates: { published: "2026-08-01T00:00:00Z", clarificationMeeting: "2026-08-10T00:00:00Z" } });
    expect(detectChanges(previous, next)).toContain("aclaraciones");
  });

  it("primera publicación (previous undefined) no reporta cambios", () => {
    expect(detectChanges(undefined, baseRecord())).toEqual([]);
  });
});

describe("InMemoryTenderVersionStore (ampliación §3: nueva publicación, replay idempotente, modificación con plazo adelantado)", () => {
  it("caso 'nueva publicación': la primera versión no dispara ChangeDetected", () => {
    const store = new InMemoryTenderVersionStore();
    const record = baseRecord();
    const { isNew, event } = store.record(record, new Date("2026-08-01T00:00:00Z"));
    expect(isNew).toBe(true);
    expect(event).toBeUndefined();
    expect(store.history(sourceKey(record))).toHaveLength(1);
  });

  it("caso 'duplicado/replay idempotente': volver a registrar el MISMO contenido no crea una versión nueva ni dispara evento", () => {
    const store = new InMemoryTenderVersionStore();
    const record = baseRecord();
    store.record(record, new Date("2026-08-01T00:00:00Z"));
    // Replay: mismo contenido de negocio, pero llega con un snapshot distinto (nuevo fetch, mismo dato).
    const replay = baseRecord({ snapshot: { fetchedAt: new Date("2026-08-02T00:00:00Z"), rawHash: "c".repeat(64) } });
    const { isNew, event } = store.record(replay, new Date("2026-08-02T00:00:00Z"));

    expect(isNew).toBe(false);
    expect(event).toBeUndefined();
    expect(store.history(sourceKey(record))).toHaveLength(1);
  });

  it("caso 'modificación con plazo adelantado': dispara ChangeDetected con changes=['plazos'] y deadlineMovedEarlier=true", () => {
    const store = new InMemoryTenderVersionStore();
    const record = baseRecord();
    store.record(record, new Date("2026-08-01T00:00:00Z"));

    const modificado = baseRecord({ dates: { published: "2026-08-01T00:00:00Z", submissionDeadline: "2026-08-15T00:00:00Z" } });
    const { isNew, event } = store.record(modificado, new Date("2026-08-05T00:00:00Z"));

    expect(isNew).toBe(true);
    expect(event).toBeDefined();
    expect(event?.changes).toContain("plazos");
    expect(event?.deadlineMovedEarlier).toBe(true);
    expect(store.history(sourceKey(record))).toHaveLength(2);
    expect(store.latest(sourceKey(record))?.record.dates.submissionDeadline?.toISOString()).toBe(modificado.dates.submissionDeadline?.toISOString());
  });

  it("preserva el historial completo (append-only, nunca se sobreescribe una versión anterior)", () => {
    const store = new InMemoryTenderVersionStore();
    const record = baseRecord();
    store.record(record, new Date("2026-08-01T00:00:00Z"));
    store.record(baseRecord({ status: "clarification" }), new Date("2026-08-05T00:00:00Z"));
    store.record(baseRecord({ status: "closed_for_submission" }), new Date("2026-08-10T00:00:00Z"));

    const history = store.history(sourceKey(record));
    expect(history).toHaveLength(3);
    expect(history[0].record.status).toBe("published");
    expect(history[1].record.status).toBe("clarification");
    expect(history[2].record.status).toBe("closed_for_submission");
  });
});
