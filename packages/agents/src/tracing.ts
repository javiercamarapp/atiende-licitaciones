import { createHash } from "node:crypto";
import type { ModelTier } from "./types.js";

/** sha256 hex de una entrada arbitraria, serializada de forma determinista. */
export function hashValue(value: unknown): string {
  const serialized = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(serialized).digest("hex");
}

/** JSON.stringify con claves ordenadas, para que el hash sea estable sin importar el orden de inserción. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Estimación simple de tokens a partir de un texto (~4 caracteres por token, redondeado hacia arriba). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Costo estimado en USD por 1,000 tokens, por nivel de modelo. Son valores
 * de referencia para trazabilidad interna, no tarifas contractuales de
 * ningún proveedor; `apps/api` puede sobreescribir esta tabla si necesita
 * cifras reales de facturación.
 */
export const COST_PER_1K_TOKENS_USD: Record<ModelTier, number> = {
  economico: 0.0005,
  estandar: 0.003,
  premium: 0.015,
};

export function estimateCostUsd(tier: ModelTier, tokens: number): number {
  return (tokens / 1000) * COST_PER_1K_TOKENS_USD[tier];
}
