import { z } from "zod";

/**
 * Envuelve un schema OPCIONAL de zod para que un `null` EXPLÍCITO en el
 * payload de entrada se trate exactamente igual que el campo simplemente
 * AUSENTE, normalizándolo a `undefined` ANTES de validar (SR-13).
 *
 * Es un patrón muy común en APIs JSON reales de gobierno devolver `null`
 * para un campo opcional sin dato (en vez de omitir la llave por completo).
 * Sin este `preprocess`, `z.optional()` por sí solo RECHAZA `null` con un
 * `ZodError` ("Expected string, received null") -- el registro completo (no
 * solo el campo) falla, y `classifySourceFailure` lo clasifica como
 * `interface_changed`: una falsa alarma de "cambio de interfaz" cuando la
 * estructura real no cambió, solo el VALOR es `null`.
 *
 * El tipo inferido (`z.infer`) sigue siendo `T | undefined` (nunca `T | null
 * | undefined`): el `preprocess` colapsa `null` a `undefined` antes de que
 * el schema interno lo vea, así que el resto del código (que ya maneja
 * `undefined` para "campo ausente") no necesita cambiar.
 */
export function optionalNullish<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === null ? undefined : value), schema.optional());
}
