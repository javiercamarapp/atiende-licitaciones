/**
 * Aritmética monetaria determinista mínima para el gate de "consistencia
 * numérica" del auditor (REQ-037/REQ-029). Deliberadamente autocontenida en
 * `packages/agents` (que no depende de `packages/expediente`, ver
 * `package.json`): mismo algoritmo half-up en centavos `bigint` que
 * `packages/expediente/src/money.ts`, pero sin crear una dependencia
 * cruzada nueva entre paquetes para cerrar un solo requisito.
 */

/** Multiplica un monto en centavos por una tasa fraccionaria (p. ej. IVA 0.16) con redondeo half-up al centavo. */
export function multiplyRateHalfUpCents(cents: bigint, rate: number): bigint {
  if (cents < 0n) throw new Error("multiplyRateHalfUpCents solo admite montos no negativos");
  if (!Number.isFinite(rate) || rate < 0) throw new Error("multiplyRateHalfUpCents solo admite tasas finitas no negativas");
  const rateMicros = BigInt(Math.round(rate * 1_000_000));
  const product = cents * rateMicros;
  const divisor = 1_000_000n;
  const quotient = product / divisor;
  const remainder = product % divisor;
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

export function sumCents(values: readonly bigint[]): bigint {
  return values.reduce((acc, v) => acc + v, 0n);
}
