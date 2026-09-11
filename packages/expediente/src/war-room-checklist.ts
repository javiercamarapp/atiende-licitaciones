/**
 * WarRoomChecklist (REQ-040): checklist operativo de "sala de guerra" que se
 * ejecuta antes de cada acto de apertura de una convocatoria -- un gate
 * final e INDEPENDIENTE del `IntegrityChecklist` (REQ-160) y del
 * `PackageAssembler` (REQ-163), sobre 4 dimensiones (BLUEPRINT L659-661):
 *
 *  - `checklist_anti_desechamiento`: el expediente debe estar REALMENTE
 *    "ready" (checklist de integridad en verde + paquete final ensamblado
 *    sin faltantes ni aprobación vencida) -- un expediente incompleto se
 *    DESECHA por la convocante en el acto de apertura sin importar la
 *    calidad de su contenido. Nunca se infiere "verde": se recibe el
 *    `ChecklistReport`/`PackageStatus` ya calculados por esos módulos (o
 *    `null` si nunca se corrieron).
 *  - `cuenta_regresiva`: cuánto tiempo falta para la fecha límite de
 *    presentación (`submissionDeadlineIso`, el mismo `tenders.submission_deadline`
 *    que ya usa el resto del expediente, REQ-023/AE-01). Sin fecha límite
 *    conocida, o con la fecha ya vencida al momento de correr el checklist,
 *    esta dimensión es roja: no tiene sentido "hacer sala de guerra" para un
 *    acto ya cerrado o sin fecha declarada.
 *  - `hash_zip`: el ZIP REALMENTE ensamblado (bytes en disco del último
 *    `PackageAssembler.assemble()`) coincide, documento por documento, con
 *    lo que su propio manifiesto declara -- reutiliza `verifyManifest`
 *    (AE-06/REQ-035) en vez de reimplementar el cálculo de hash. Roja si
 *    nunca se ensambló ningún paquete.
 *  - `holgura_24h`: holgura OBLIGATORIA de `minMandatorySlackHours` (24h por
 *    defecto, literal del REQ) antes de la fecha límite -- si este checklist
 *    se corre con MENOS anticipación, la dimensión es roja aunque todo lo
 *    demás esté en verde. El objetivo es forzar a que el equipo llegue con
 *    margen real de reacción (falla de portal, de internet, de firma, etc.),
 *    nunca al último minuto -- la causa concreta de riesgo que "sala de
 *    guerra" existe para evitar.
 *
 * Todas las fechas de entrada deben traer offset horario EXPLÍCITO
 * (`assertExplicitOffset`, mismo contrato que el resto de
 * `packages/expediente`). `nowIso` es un parámetro EXPLÍCITO -- nunca
 * `Date.now()`/`new Date()` interno: quien llama (`apps/api`) decide qué
 * "ahora" usar, y las pruebas fijan su propio valor sin depender del reloj
 * real de la máquina que corre la prueba (evita que la suite se pudra con el
 * paso del tiempo -- ver commits de limpieza de "date-rot" en este repo).
 *
 * Este módulo, como el resto de `packages/expediente`, es lógica de negocio
 * PURA: no toca base de datos ni disco. `apps/api` es responsable de resolver
 * `integrityChecklist`/`packageStatus`/`zipVerification` contra el estado
 * real (Postgres + el ZIP real en `STORAGE_DIR`) antes de llamar a `run()`.
 */
import type { ChecklistReport } from "./integrity-checklist.js";
import type { ManifestVerificationResult } from "./package-assembler.js";
import { assertExplicitOffset } from "./types.js";

export type WarRoomDimension =
  | "checklist_anti_desechamiento"
  | "cuenta_regresiva"
  | "hash_zip"
  | "holgura_24h";

export type WarRoomResultStatus = "verde" | "ambar" | "rojo";

export interface WarRoomItemResult {
  dimension: WarRoomDimension;
  status: WarRoomResultStatus;
  detail: string;
  evidence: string[];
}

export interface WarRoomChecklistReport {
  items: WarRoomItemResult[];
  overallStatus: WarRoomResultStatus;
  /** Horas (con fracción) hasta `submissionDeadlineIso`; negativo si ya venció; `null` si no hay fecha límite conocida. */
  hoursUntilDeadline: number | null;
  /** Eco de `input.nowIso` -- el momento que este reporte usó como "ahora". */
  computedAtIso: string;
}

export interface WarRoomChecklistInput {
  /** Último `IntegrityChecklist.run()` real de este expediente (REQ-160); `null` si nunca se corrió. */
  integrityChecklist: ChecklistReport | null;
  /** `PackageStatus` REAL y ACTUAL (re-derivado, no el guardado en la última corrida si pudo quedar obsoleto -- mismo criterio AE-14 de `package.routes.ts`) para este expediente; `null` si nunca se ensambló ningún paquete. */
  packageStatus: "draft" | "ready" | null;
  /** Motivos de "draft" del estado ACTUAL del paquete (vacío si `packageStatus === "ready"` o `null`). */
  packageDraftReasons: string[];
  /** `tenders.submission_deadline` ya resuelto a ISO con offset horario explícito; `null` si la convocatoria no lo tiene fijado todavía. */
  submissionDeadlineIso: string | null;
  /** Momento de ejecución del checklist, ISO con offset horario explícito -- inyectado por el llamador, nunca calculado dentro de este método. */
  nowIso: string;
  /** `verifyManifest(zipBytesEnDisco)` del último paquete REALMENTE ensamblado; `null` si nunca se ensambló ningún paquete. */
  zipVerification: ManifestVerificationResult | null;
  /** Holgura mínima obligatoria en horas antes de la fecha límite (REQ-040 literal: 24h). */
  minMandatorySlackHours?: number;
}

const DEFAULT_MIN_MANDATORY_SLACK_HOURS = 24;
const MS_PER_HOUR = 3_600_000;

function overallFrom(items: WarRoomItemResult[]): WarRoomResultStatus {
  if (items.some((i) => i.status === "rojo")) return "rojo";
  if (items.some((i) => i.status === "ambar")) return "ambar";
  return "verde";
}

export class WarRoomChecklist {
  run(input: WarRoomChecklistInput): WarRoomChecklistReport {
    assertExplicitOffset(input.nowIso, "nowIso (WarRoomChecklist)");
    if (input.submissionDeadlineIso !== null) {
      assertExplicitOffset(input.submissionDeadlineIso, "submissionDeadlineIso (WarRoomChecklist)");
    }

    const hoursUntilDeadline =
      input.submissionDeadlineIso === null
        ? null
        : (new Date(input.submissionDeadlineIso).getTime() - new Date(input.nowIso).getTime()) / MS_PER_HOUR;

    const items: WarRoomItemResult[] = [
      this.checkAntiDesechamiento(input),
      this.checkCuentaRegresiva(hoursUntilDeadline),
      this.checkHashZip(input),
      this.checkHolgura24h(hoursUntilDeadline, input.minMandatorySlackHours ?? DEFAULT_MIN_MANDATORY_SLACK_HOURS),
    ];

    return { items, overallStatus: overallFrom(items), hoursUntilDeadline, computedAtIso: input.nowIso };
  }

  private checkAntiDesechamiento(input: WarRoomChecklistInput): WarRoomItemResult {
    if (input.integrityChecklist === null) {
      return {
        dimension: "checklist_anti_desechamiento",
        status: "rojo",
        detail: "El checklist de integridad (REQ-160) nunca se ha ejecutado para este expediente.",
        evidence: ["checklist_integridad=nunca_ejecutado"],
      };
    }
    if (input.packageStatus === null) {
      return {
        dimension: "checklist_anti_desechamiento",
        status: "rojo",
        detail: "Nunca se ha ensamblado un paquete final para este expediente.",
        evidence: ["paquete=nunca_ensamblado"],
      };
    }
    if (input.integrityChecklist.overallStatus !== "verde" || input.packageStatus !== "ready") {
      const reasons: string[] = [];
      if (input.integrityChecklist.overallStatus !== "verde") reasons.push(`checklist_integridad=${input.integrityChecklist.overallStatus}`);
      if (input.packageStatus !== "ready") reasons.push(`paquete=${input.packageStatus}`, ...input.packageDraftReasons);
      return {
        dimension: "checklist_anti_desechamiento",
        status: "rojo",
        detail: `El expediente sería DESECHADO por incompleto en el acto de apertura: ${reasons.join(" | ")}.`,
        evidence: reasons,
      };
    }
    return {
      dimension: "checklist_anti_desechamiento",
      status: "verde",
      detail: 'Checklist de integridad en verde y paquete final "ready" (sin faltantes, con aprobación vigente).',
      evidence: ["checklist_integridad=verde", "paquete=ready"],
    };
  }

  private checkCuentaRegresiva(hoursUntilDeadline: number | null): WarRoomItemResult {
    if (hoursUntilDeadline === null) {
      return {
        dimension: "cuenta_regresiva",
        status: "rojo",
        detail: "La convocatoria no tiene fecha límite de presentación fijada; no se puede calcular la cuenta regresiva.",
        evidence: ["fecha_limite=desconocida"],
      };
    }
    if (hoursUntilDeadline <= 0) {
      return {
        dimension: "cuenta_regresiva",
        status: "rojo",
        detail: `La fecha límite de presentación ya pasó hace ${Math.abs(hoursUntilDeadline).toFixed(1)} hora(s).`,
        evidence: [`horas_hasta_limite=${hoursUntilDeadline.toFixed(2)}`],
      };
    }
    return {
      dimension: "cuenta_regresiva",
      status: "verde",
      detail: `Faltan ${hoursUntilDeadline.toFixed(1)} hora(s) para la fecha límite de presentación.`,
      evidence: [`horas_hasta_limite=${hoursUntilDeadline.toFixed(2)}`],
    };
  }

  private checkHashZip(input: WarRoomChecklistInput): WarRoomItemResult {
    if (input.zipVerification === null) {
      return {
        dimension: "hash_zip",
        status: "rojo",
        detail: "Nunca se ha ensamblado ningún paquete (ZIP) para este expediente; no hay hash que verificar.",
        evidence: ["zip=nunca_ensamblado"],
      };
    }
    if (!input.zipVerification.ok) {
      const problems: string[] = [
        ...input.zipVerification.mismatches.map((m) => `hash_no_coincide:${m.documentId}(esperado=${m.expectedSha256},real=${m.actualSha256})`),
        ...input.zipVerification.missingFromZip.map((id) => `documento_ausente_del_zip:${id}`),
      ];
      return {
        dimension: "hash_zip",
        status: "rojo",
        detail: `El ZIP en disco NO coincide con su propio manifiesto: ${problems.join(" | ")}.`,
        evidence: problems,
      };
    }
    return {
      dimension: "hash_zip",
      status: "verde",
      detail: "El sha256 de cada documento dentro del ZIP coincide con el declarado en su manifiesto (verificado byte a byte, AE-06).",
      evidence: ["zip_verificado=ok"],
    };
  }

  private checkHolgura24h(hoursUntilDeadline: number | null, minMandatorySlackHours: number): WarRoomItemResult {
    if (hoursUntilDeadline === null) {
      return {
        dimension: "holgura_24h",
        status: "rojo",
        detail: "Sin fecha límite conocida no se puede confirmar la holgura obligatoria.",
        evidence: ["fecha_limite=desconocida"],
      };
    }
    if (hoursUntilDeadline < minMandatorySlackHours) {
      return {
        dimension: "holgura_24h",
        status: "rojo",
        detail: `Holgura obligatoria de ${minMandatorySlackHours}h incumplida: solo quedan ${hoursUntilDeadline.toFixed(1)}h para la fecha límite. Este checklist debe completarse con más anticipación.`,
        evidence: [`horas_restantes=${hoursUntilDeadline.toFixed(2)}`, `minimo_exigido_horas=${minMandatorySlackHours}`],
      };
    }
    return {
      dimension: "holgura_24h",
      status: "verde",
      detail: `Holgura obligatoria cumplida: ${hoursUntilDeadline.toFixed(1)}h >= ${minMandatorySlackHours}h mínimo.`,
      evidence: [`horas_restantes=${hoursUntilDeadline.toFixed(2)}`],
    };
  }
}
