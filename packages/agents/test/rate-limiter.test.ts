import { describe, expect, it } from "vitest";
import { TokenBucketRateLimiter } from "../src/rate-limiter.js";
import { InvalidAmountError } from "../src/errors.js";

describe("TokenBucketRateLimiter", () => {
  it("permite consumir hasta la capacidad y rechaza después", () => {
    const now = 0;
    const limiter = new TokenBucketRateLimiter(3, 1, () => now);
    expect(limiter.tryConsume("org-1")).toBe(true);
    expect(limiter.tryConsume("org-1")).toBe(true);
    expect(limiter.tryConsume("org-1")).toBe(true);
    expect(limiter.tryConsume("org-1")).toBe(false);
  });

  it("rellena tokens con el paso del tiempo según refillTokensPerSecond", () => {
    let now = 0;
    const limiter = new TokenBucketRateLimiter(2, 1, () => now); // 1 token/seg
    expect(limiter.tryConsume("org-1")).toBe(true);
    expect(limiter.tryConsume("org-1")).toBe(true);
    expect(limiter.tryConsume("org-1")).toBe(false);

    now += 1000; // 1 segundo después: se rellena 1 token
    expect(limiter.tryConsume("org-1")).toBe(true);
    expect(limiter.tryConsume("org-1")).toBe(false);
  });

  it("nunca rellena por encima de la capacidad máxima", () => {
    let now = 0;
    const limiter = new TokenBucketRateLimiter(2, 10, () => now);
    now += 10_000; // tiempo suficiente para rellenar de sobra
    expect(limiter.getAvailableTokens("org-1")).toBe(2);
  });

  it("aísla los buckets por organización", () => {
    const limiter = new TokenBucketRateLimiter(1, 0);
    expect(limiter.tryConsume("org-1")).toBe(true);
    expect(limiter.tryConsume("org-1")).toBe(false);
    expect(limiter.tryConsume("org-2")).toBe(true); // org distinta, bucket independiente
  });

  it("trata organizationId null como su propio bucket de plataforma", () => {
    const limiter = new TokenBucketRateLimiter(1, 0);
    expect(limiter.tryConsume(null)).toBe(true);
    expect(limiter.tryConsume(null)).toBe(false);
  });

  it("reset() limpia todos los buckets", () => {
    const limiter = new TokenBucketRateLimiter(1, 0);
    limiter.tryConsume("org-1");
    limiter.reset();
    expect(limiter.tryConsume("org-1")).toBe(true);
  });

  describe("AG-09 (MEDIA): validación de signo/finitud/enteros en tryConsume()", () => {
    it("rechaza un valor negativo de tokens en vez de rellenar el bucket a capacidad completa", () => {
      const limiter = new TokenBucketRateLimiter(10, 0);
      limiter.tryConsume("org-1", 10); // agota el bucket
      expect(limiter.getAvailableTokens("org-1")).toBe(0);
      expect(() => limiter.tryConsume("org-1", -1000)).toThrow(InvalidAmountError);
      // El intento inválido no debe haber rellenado el bucket.
      expect(limiter.getAvailableTokens("org-1")).toBe(0);
    });

    it("rechaza NaN", () => {
      const limiter = new TokenBucketRateLimiter(10, 0);
      expect(() => limiter.tryConsume("org-1", NaN)).toThrow(InvalidAmountError);
    });

    it("rechaza Infinity", () => {
      const limiter = new TokenBucketRateLimiter(10, 0);
      expect(() => limiter.tryConsume("org-1", Infinity)).toThrow(InvalidAmountError);
    });

    it("rechaza valores no enteros (los tokens son unidades discretas)", () => {
      const limiter = new TokenBucketRateLimiter(10, 0);
      expect(() => limiter.tryConsume("org-1", 1.5)).toThrow(InvalidAmountError);
    });

    it("acepta 0 (consumo nulo es válido)", () => {
      const limiter = new TokenBucketRateLimiter(10, 0);
      expect(() => limiter.tryConsume("org-1", 0)).not.toThrow();
    });
  });
});
