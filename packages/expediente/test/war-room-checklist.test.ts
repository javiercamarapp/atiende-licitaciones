import { describe, expect, it } from "vitest";
import { WarRoomChecklist, type WarRoomChecklistInput } from "../src/war-room-checklist.js";
import type { ChecklistReport } from "../src/integrity-checklist.js";
import type { ManifestVerificationResult } from "../src/package-assembler.js";

const NOW = "2026-10-20T12:00:00-06:00";

const GREEN_INTEGRITY: ChecklistReport = {
  overallStatus: "verde",
  items: [{ dimension: "formatos", status: "verde", detail: "ok", evidence: [] }],
};

const OK_ZIP: ManifestVerificationResult = { ok: true, mismatches: [], missingFromZip: [] };

function isoHoursFromNow(hours: number): string {
  return new Date(new Date(NOW).getTime() + hours * 3_600_000).toISOString();
}

function baseInput(overrides: Partial<WarRoomChecklistInput> = {}): WarRoomChecklistInput {
  return {
    integrityChecklist: GREEN_INTEGRITY,
    packageStatus: "ready",
    packageDraftReasons: [],
    submissionDeadlineIso: isoHoursFromNow(48),
    nowIso: NOW,
    zipVerification: OK_ZIP,
    ...overrides,
  };
}

describe("WarRoomChecklist — 4 dimensiones de la sala de guerra (REQ-040)", () => {
  it("produce las 4 dimensiones exigidas por el REQ, ninguna de más ni de menos", () => {
    const report = new WarRoomChecklist().run(baseInput());
    expect(report.items.map((i) => i.dimension).sort()).toEqual(
      ["checklist_anti_desechamiento", "cuenta_regresiva", "hash_zip", "holgura_24h"].sort(),
    );
  });

  it("caso feliz: expediente ready, con holgura sobrada y ZIP verificado -> overallStatus verde en las 4 dimensiones", () => {
    const report = new WarRoomChecklist().run(baseInput());
    expect(report.overallStatus).toBe("verde");
    for (const item of report.items) expect(item.status).toBe("verde");
    expect(report.hoursUntilDeadline).toBeCloseTo(48, 5);
    expect(report.computedAtIso).toBe(NOW);
  });

  describe("checklist_anti_desechamiento", () => {
    it("rojo si el checklist de integridad nunca se corrió", () => {
      const report = new WarRoomChecklist().run(baseInput({ integrityChecklist: null }));
      const item = report.items.find((i) => i.dimension === "checklist_anti_desechamiento")!;
      expect(item.status).toBe("rojo");
      expect(report.overallStatus).toBe("rojo");
    });

    it("rojo si nunca se ensambló ningún paquete", () => {
      const report = new WarRoomChecklist().run(baseInput({ packageStatus: null, zipVerification: null }));
      const item = report.items.find((i) => i.dimension === "checklist_anti_desechamiento")!;
      expect(item.status).toBe("rojo");
      expect(item.detail).toContain("Nunca se ha ensamblado");
    });

    it("rojo si el checklist de integridad no está en verde, aunque el paquete diga 'ready' (nunca debería pasar, pero no se confía ciegamente)", () => {
      const report = new WarRoomChecklist().run(
        baseInput({ integrityChecklist: { overallStatus: "rojo", items: [] } }),
      );
      const item = report.items.find((i) => i.dimension === "checklist_anti_desechamiento")!;
      expect(item.status).toBe("rojo");
      expect(item.evidence).toContain("checklist_integridad=rojo");
    });

    it("rojo si el paquete sigue en 'draft', con los motivos de draft reflejados en la evidencia", () => {
      const report = new WarRoomChecklist().run(
        baseInput({ packageStatus: "draft", packageDraftReasons: ["documentos_faltantes:anexo3"] }),
      );
      const item = report.items.find((i) => i.dimension === "checklist_anti_desechamiento")!;
      expect(item.status).toBe("rojo");
      expect(item.evidence).toContain("documentos_faltantes:anexo3");
      expect(item.detail).toContain("DESECHADO");
    });
  });

  describe("cuenta_regresiva", () => {
    it("rojo si no hay fecha límite conocida", () => {
      const report = new WarRoomChecklist().run(baseInput({ submissionDeadlineIso: null }));
      const item = report.items.find((i) => i.dimension === "cuenta_regresiva")!;
      expect(item.status).toBe("rojo");
      expect(report.hoursUntilDeadline).toBeNull();
    });

    it("rojo si la fecha límite ya pasó", () => {
      const report = new WarRoomChecklist().run(baseInput({ submissionDeadlineIso: isoHoursFromNow(-3) }));
      const item = report.items.find((i) => i.dimension === "cuenta_regresiva")!;
      expect(item.status).toBe("rojo");
      expect(report.hoursUntilDeadline).toBeLessThan(0);
    });

    it("verde mientras quede tiempo, incluso si es menos que la holgura obligatoria (dimensión distinta)", () => {
      const report = new WarRoomChecklist().run(baseInput({ submissionDeadlineIso: isoHoursFromNow(10) }));
      const cuentaRegresiva = report.items.find((i) => i.dimension === "cuenta_regresiva")!;
      const holgura = report.items.find((i) => i.dimension === "holgura_24h")!;
      expect(cuentaRegresiva.status).toBe("verde");
      expect(holgura.status).toBe("rojo");
      expect(report.overallStatus).toBe("rojo");
    });
  });

  describe("hash_zip", () => {
    it("rojo si nunca se ensambló ningún paquete", () => {
      const report = new WarRoomChecklist().run(baseInput({ zipVerification: null }));
      const item = report.items.find((i) => i.dimension === "hash_zip")!;
      expect(item.status).toBe("rojo");
    });

    it("rojo si el ZIP en disco no coincide con su propio manifiesto (manipulación o corrupción)", () => {
      const report = new WarRoomChecklist().run(
        baseInput({
          zipVerification: {
            ok: false,
            mismatches: [{ documentId: "doc-1", expectedSha256: "aaa", actualSha256: "bbb" }],
            missingFromZip: [],
          },
        }),
      );
      const item = report.items.find((i) => i.dimension === "hash_zip")!;
      expect(item.status).toBe("rojo");
      expect(item.evidence.some((e) => e.includes("doc-1"))).toBe(true);
    });

    it("verde si verifyManifest confirma que todo coincide", () => {
      const report = new WarRoomChecklist().run(baseInput());
      expect(report.items.find((i) => i.dimension === "hash_zip")!.status).toBe("verde");
    });
  });

  describe("holgura_24h", () => {
    it("rojo si faltan menos de 24h para la fecha límite", () => {
      const report = new WarRoomChecklist().run(baseInput({ submissionDeadlineIso: isoHoursFromNow(23.5) }));
      expect(report.items.find((i) => i.dimension === "holgura_24h")!.status).toBe("rojo");
    });

    it("verde si faltan 24h o más (frontera inclusiva)", () => {
      const report = new WarRoomChecklist().run(baseInput({ submissionDeadlineIso: isoHoursFromNow(24) }));
      expect(report.items.find((i) => i.dimension === "holgura_24h")!.status).toBe("verde");
    });

    it("respeta un `minMandatorySlackHours` distinto al default cuando el llamador lo declara", () => {
      const report = new WarRoomChecklist().run(baseInput({ submissionDeadlineIso: isoHoursFromNow(40), minMandatorySlackHours: 48 }));
      expect(report.items.find((i) => i.dimension === "holgura_24h")!.status).toBe("rojo");
    });

    it("rojo si no hay fecha límite conocida (no se puede confirmar holgura)", () => {
      const report = new WarRoomChecklist().run(baseInput({ submissionDeadlineIso: null }));
      expect(report.items.find((i) => i.dimension === "holgura_24h")!.status).toBe("rojo");
    });
  });

  describe("fail-closed sobre fechas mal formadas (EX-EXP-04, mismo contrato que el resto de packages/expediente)", () => {
    it("lanza si `nowIso` no trae offset horario explícito", () => {
      expect(() => new WarRoomChecklist().run(baseInput({ nowIso: "2026-10-20T12:00:00" }))).toThrow(/offset horario/);
    });

    it("lanza si `submissionDeadlineIso` no trae offset horario explícito", () => {
      expect(() => new WarRoomChecklist().run(baseInput({ submissionDeadlineIso: "2026-10-22T12:00:00" }))).toThrow(/offset horario/);
    });
  });
});
