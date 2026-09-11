/**
 * Aritmética decimal determinista mínima para `packages/agents/src/analytics`
 * (motores estadísticos/deterministas de REQ-002/REQ-009/REQ-020/REQ-030),
 * calcada del mismo patrón que `packages/expediente/src/money.ts`: montos
 * como centavos `bigint`, redondeo half-up explícito, nunca `number` de
 * punto flotante para dinero.
 *
 * Es una copia INTENCIONAL, no una duplicación accidental: ningún
 * `package.json` de `packages/*` depende de otro `packages/*` en este repo
 * (cada paquete es una librería independiente; solo las apps los componen,
 * ver README raíz y `packages/agents/README.md` "Librería TypeScript pura
 * -- no depende de ninguna base de datos"). Añadir una dependencia cruzada
 * `@atiende/agents -> @atiende/expediente` solo para reusar ~90 líneas
 * rompería esa capa deliberadamente, así que se replica el mismo algoritmo
 * en vez de importarlo.
 */

/** Cadena decimal con hasta 2 decimales, p. ej. "1234.56" o "1234". */
export type DecimalString = string;

const DECIMAL_PATTERN = /^-?\d+(\.\d{1,2})?$/;

export function assertValidDecimalString(value: string): void {
  if (!DECIMAL_PATTERN.test(value.trim())) {
    throw new Error(`Cadena decimal inválida (se esperaba p.ej. "1234.56"): "${value}"`);
  }
}

/** Convierte una cadena decimal a centavos (`bigint`), validando el formato. */
export function toCents(value: DecimalString): bigint {
  const trimmed = value.trim();
  assertValidDecimalString(trimmed);
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPart, fracPartRaw = ""] = unsigned.split(".");
  const fracPart = (fracPartRaw + "00").slice(0, 2);
  const cents = BigInt(intPart) * 100n + BigInt(fracPart);
  return negative ? -cents : cents;
}

/** Convierte centavos (`bigint`) de vuelta a cadena decimal con 2 decimales fijos. */
export function fromCents(cents: bigint): DecimalString {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const intPart = abs / 100n;
  const fracPart = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${intPart.toString()}.${fracPart}`;
}

/**
 * Multiplica un monto en centavos por una tasa fraccionaria (p. ej. 0.60 o
 * 1.10 de la banda de precio, REQ-030) con redondeo half-up al centavo.
 * Solo válido para montos no negativos.
 */
export function multiplyRateHalfUp(cents: bigint, rate: number): bigint {
  if (cents < 0n) throw new Error("multiplyRateHalfUp solo admite montos no negativos");
  if (rate < 0) throw new Error("multiplyRateHalfUp solo admite tasas no negativas");
  // La tasa se fija a 6 decimales de precisión para evitar el error de
  // punto flotante de `rate` en el resultado.
  const rateMicros = BigInt(Math.round(rate * 1_000_000));
  const product = cents * rateMicros; // unidades: centavo * 1e-6
  const divisor = 1_000_000n;
  const quotient = product / divisor;
  const remainder = product % divisor;
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

export function compareCents(a: bigint, b: bigint): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
