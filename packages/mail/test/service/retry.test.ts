import { describe, expect, it } from "vitest";
import { computeBackoffDelay, DEFAULT_RETRY_POLICY } from "../../src/service/retry";

describe("computeBackoffDelay", () => {
  it("crece exponencialmente con el número de intento (sin jitter)", () => {
    const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 10_000, jitterRatio: 0 };
    expect(computeBackoffDelay(1, policy)).toBe(100);
    expect(computeBackoffDelay(2, policy)).toBe(200);
    expect(computeBackoffDelay(3, policy)).toBe(400);
    expect(computeBackoffDelay(4, policy)).toBe(800);
  });

  it("nunca excede maxDelayMs", () => {
    const policy = { maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 3000, jitterRatio: 0 };
    expect(computeBackoffDelay(10, policy)).toBeLessThanOrEqual(3000);
  });

  it("el jitter mantiene el resultado no negativo y acotado por encima", () => {
    const policy = { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 10_000, jitterRatio: 0.5 };
    // random() fijo en los extremos para verificar las cotas del jitter.
    const low = computeBackoffDelay(2, policy, () => 0); // jitter = -0.5 * exponential
    const high = computeBackoffDelay(2, policy, () => 1); // jitter = +0.5 * exponential
    expect(low).toBeGreaterThanOrEqual(0);
    expect(high).toBeGreaterThan(low);
  });

  it("DEFAULT_RETRY_POLICY tiene valores razonables", () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeGreaterThan(1);
    expect(DEFAULT_RETRY_POLICY.baseDelayMs).toBeGreaterThan(0);
  });
});
