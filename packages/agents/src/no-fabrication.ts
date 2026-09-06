import { z } from "zod";

/**
 * NoFabricationPolicy (docs/AMPLIACION-BACKOFFICE.md §6): cualquier valor de
 * precio, certificación, experiencia, referencia, firma o vigencia que use
 * una herramienta debe venir de una fuente aprobada referenciada
 * (`approvedSourceRef`). Si falta la fuente (o el valor), el resultado debe
 * ser "pendiente/no evaluable" con la lista exacta de datos faltantes —
 * nunca un valor inventado por el LLM.
 *
 * Esto complementa (no reemplaza) el guardrail `no_unsourced_claims` de
 * REQ-027/REQ-085: aquella regla es sobre `Claim`s de texto libre citando
 * evidencia; esta regla es sobre valores estructurados (número, fecha,
 * identificador) que una herramienta necesita para producir un artefacto
 * (precio de propuesta, vigencia de un documento, etc.).
 */

export type SensitiveFieldKind =
  | "precio"
  | "certificacion"
  | "experiencia"
  | "referencia"
  | "firma"
  | "vigencia";

export const SENSITIVE_FIELD_KINDS: readonly SensitiveFieldKind[] = [
  "precio",
  "certificacion",
  "experiencia",
  "referencia",
  "firma",
  "vigencia",
];

export interface ApprovedSourceRef {
  /** Identificador del documento/registro aprobado de origen (bóveda, catálogo interno, etc.). */
  docId: string;
  page?: number;
  /** Momento en que se capturó/confirmó el dato desde la fuente. */
  capturedAt: string;
}

export const approvedSourceRefSchema: z.ZodType<ApprovedSourceRef> = z.object({
  docId: z.string().min(1),
  page: z.number().int().positive().optional(),
  capturedAt: z.string().min(1),
});

export interface SourcedValue<T = unknown> {
  kind: SensitiveFieldKind;
  fieldName: string;
  value: T | null | undefined;
  approvedSourceRef: ApprovedSourceRef | null | undefined;
}

/** Esquema zod reutilizable para que una herramienta declare un campo sensible "abastecido". */
export function sourcedValueSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.object({
    value: valueSchema.nullable(),
    approvedSourceRef: approvedSourceRefSchema.nullable(),
  });
}

export type NoFabricationEvaluation =
  | { status: "evaluable"; values: Record<string, unknown> }
  | { status: "pendiente_no_evaluable"; missing: string[] };

export class NoFabricationPolicy {
  /**
   * Evalúa una lista de valores sensibles. Si a cualquiera le falta el
   * valor o la referencia de fuente aprobada, el resultado completo es
   * `pendiente_no_evaluable` con la lista de nombres de campo faltantes
   * (nunca se completa parcialmente con valores inventados).
   */
  evaluate(values: SourcedValue[]): NoFabricationEvaluation {
    const missing = values
      .filter((v) => v.value === null || v.value === undefined || !v.approvedSourceRef)
      .map((v) => v.fieldName);

    if (missing.length > 0) {
      return { status: "pendiente_no_evaluable", missing };
    }

    const result: Record<string, unknown> = {};
    for (const v of values) result[v.fieldName] = v.value;
    return { status: "evaluable", values: result };
  }

  /** Azúcar sintáctica para validar un único campo sensible. */
  evaluateOne(value: SourcedValue): NoFabricationEvaluation {
    return this.evaluate([value]);
  }
}
