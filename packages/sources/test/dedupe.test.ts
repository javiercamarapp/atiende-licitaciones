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

  it("SR-07: NO colisiona entre dos procedimientos DISTINTOS de la MISMA entidad con título genérico compartido, cuando su fecha de presentación difiere", () => {
    // Caso adversarial de la auditoría: misma entidad, mismo día de publicación, título administrativo
    // genérico ("Adquisición de material de oficina") compartido por dos procedimientos REALES y distintos
    // (externalId distinto). Antes del fix, título+entidad+fecha de publicación colisionaban en la misma
    // huella pese a ser procedimientos distintos.
    const procA = baseRecord({
      source: "compras-mx",
      externalId: "PROC-A",
      title: "Adquisición de material de oficina",
      dates: { published: "2026-08-01T00:00:00Z", submissionDeadline: "2026-08-20T00:00:00Z" },
    });
    const procB = baseRecord({
      source: "compras-mx",
      externalId: "PROC-B",
      title: "Adquisición de material de oficina",
      dates: { published: "2026-08-01T00:00:00Z", submissionDeadline: "2026-09-10T00:00:00Z" },
    });
    expect(computeCrossSourceFingerprint(procA)).not.toBe(computeCrossSourceFingerprint(procB));
  });

  it("SR-07: sigue reconociendo el MISMO procedimiento cruzado entre fuentes cuando también coincide la fecha de presentación", () => {
    const a = baseRecord({
      source: "dof",
      externalId: "5900001:LA-000-2026",
      dates: { published: "2026-08-01T00:00:00Z", submissionDeadline: "2026-09-01T00:00:00Z" },
    });
    const b = baseRecord({
      source: "ocds-shcp",
      externalId: "LA-000-2026",
      dates: { published: "2026-08-01T00:00:00Z", submissionDeadline: "2026-09-01T00:00:00Z" },
    });
    expect(computeCrossSourceFingerprint(a)).toBe(computeCrossSourceFingerprint(b));
  });

  it("SR-07: incluye el número de procedimiento embebido en el título cuando está presente, distinguiendo dos convocatorias con título/fecha idénticos salvo por ese número", () => {
    const a = baseRecord({
      externalId: "PROC-A",
      title: "Convocatoria LA-012NAY001-E15-2026 para adquisición de material de oficina",
    });
    const b = baseRecord({
      externalId: "PROC-B",
      title: "Convocatoria LA-016B00003-E22-2026 para adquisición de material de oficina",
    });
    expect(computeCrossSourceFingerprint(a)).not.toBe(computeCrossSourceFingerprint(b));
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

describe("SR-01: hash de versión canónico (orden de arrays/espacios/unicode no debe disparar una versión falsa)", () => {
  it("reordenar classifiers[] sin cambiar su contenido NO produce un versionHash distinto ni dispara ChangeDetected", () => {
    const ordered = baseRecord({
      classifiers: [
        { scheme: "UNSPSC", code: "43211500" },
        { scheme: "CUCoP", code: "20101501" },
      ],
    });
    const reordered = baseRecord({
      classifiers: [
        { scheme: "CUCoP", code: "20101501" },
        { scheme: "UNSPSC", code: "43211500" },
      ],
    });
    expect(computeVersionHash(ordered)).toBe(computeVersionHash(reordered));
    expect(detectChanges(ordered, reordered)).not.toContain("bases");

    const store = new InMemoryTenderVersionStore();
    store.record(ordered, new Date("2026-08-01T00:00:00Z"));
    const { event } = store.record(reordered, new Date("2026-08-02T00:00:00Z"));
    expect(event).toBeUndefined();
  });

  it("reordenar attachments[] sin cambiar su contenido NO produce un versionHash distinto ni dispara 'anexos'", () => {
    const ordered = baseRecord({
      attachments: [
        { name: "Bases", url: "https://example.gob.mx/bases.pdf" },
        { name: "Anexo técnico", url: "https://example.gob.mx/anexo-tecnico.pdf" },
      ],
    });
    const reordered = baseRecord({
      attachments: [
        { name: "Anexo técnico", url: "https://example.gob.mx/anexo-tecnico.pdf" },
        { name: "Bases", url: "https://example.gob.mx/bases.pdf" },
      ],
    });
    expect(computeVersionHash(ordered)).toBe(computeVersionHash(reordered));
    expect(detectChanges(ordered, reordered)).not.toContain("anexos");
  });

  it("cambiar realmente un anexo (no solo reordenar) SÍ produce un versionHash distinto y dispara 'anexos'", () => {
    const previous = baseRecord({
      attachments: [{ name: "Bases", url: "https://example.gob.mx/bases.pdf" }],
    });
    const next = baseRecord({
      attachments: [
        { name: "Bases", url: "https://example.gob.mx/bases.pdf" },
        { name: "Anexo técnico", url: "https://example.gob.mx/anexo-tecnico.pdf" },
      ],
    });
    expect(computeVersionHash(previous)).not.toBe(computeVersionHash(next));
    expect(detectChanges(previous, next)).toContain("anexos");
  });

  it("normaliza unicode (NFC vs NFD) y espacios de más en el título: no produce una versión falsa", () => {
    const tituloNfd = "Adquisición  de   equipo de cómputo"; // "ó"/"ó" descompuestos (NFD) + espacios dobles
    const nfc = baseRecord({ title: "Adquisición de equipo de cómputo" }); // ya NFC, espacios simples
    const nfdConEspacios = baseRecord({ title: tituloNfd });
    expect(tituloNfd.normalize("NFC")).not.toBe(tituloNfd); // confirma que el fixture realmente está en NFD
    expect(computeVersionHash(nfc)).toBe(computeVersionHash(nfdConEspacios));
    expect(detectChanges(nfc, nfdConEspacios)).not.toContain("bases");
  });
});

describe("SR-18: cambios SOLO de mayúsculas/acentos en attachments[].name o classifiers[].code NO deben disparar versión (pero hash/URL de anexo SÍ)", () => {
  it("cambiar SOLO mayúsculas/acentos en attachments[].name no produce un versionHash distinto ni dispara 'anexos'", () => {
    const previous = baseRecord({ attachments: [{ name: "Anexo Tecnico", url: "https://example.gob.mx/anexo.pdf" }] });
    const next = baseRecord({ attachments: [{ name: "ANEXO TÉCNICO", url: "https://example.gob.mx/anexo.pdf" }] });
    expect(computeVersionHash(previous)).toBe(computeVersionHash(next));
    expect(detectChanges(previous, next)).not.toContain("anexos");
  });

  it("cambiar el hash/URL del anexo (aunque el nombre no cambie) SÍ produce un versionHash distinto y dispara 'anexos'", () => {
    const previous = baseRecord({ attachments: [{ name: "Anexo Técnico", url: "https://example.gob.mx/anexo-v1.pdf" }] });
    const next = baseRecord({ attachments: [{ name: "Anexo Técnico", url: "https://example.gob.mx/anexo-v2.pdf" }] });
    expect(computeVersionHash(previous)).not.toBe(computeVersionHash(next));
    expect(detectChanges(previous, next)).toContain("anexos");
  });

  it("cambiar el sha256 del MISMO anexo (mismo name/url) SÍ produce un versionHash distinto", () => {
    const previous = baseRecord({
      attachments: [{ name: "Anexo Técnico", url: "https://example.gob.mx/anexo.pdf", sha256: "a".repeat(64) }],
    });
    const next = baseRecord({
      attachments: [{ name: "Anexo Técnico", url: "https://example.gob.mx/anexo.pdf", sha256: "b".repeat(64) }],
    });
    expect(computeVersionHash(previous)).not.toBe(computeVersionHash(next));
  });

  it("cambiar SOLO mayúsculas/acentos en classifiers[].code no produce un versionHash distinto", () => {
    const previous = baseRecord({ classifiers: [{ scheme: "UNSPSC", code: "Adquisición" }] });
    const next = baseRecord({ classifiers: [{ scheme: "UNSPSC", code: "ADQUISICION" }] });
    expect(computeVersionHash(previous)).toBe(computeVersionHash(next));
  });

  it("un cambio real de classifiers[].code (no solo de formato) SÍ produce un versionHash distinto", () => {
    const previous = baseRecord({ classifiers: [{ scheme: "UNSPSC", code: "43211500" }] });
    const next = baseRecord({ classifiers: [{ scheme: "UNSPSC", code: "43211600" }] });
    expect(computeVersionHash(previous)).not.toBe(computeVersionHash(next));
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
