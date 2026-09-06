import { describe, expect, it } from "vitest";
import { TokenBucketRateLimiter, UnlimitedRateLimiter } from "../../src/service/rate-limiter";

describe("TokenBucketRateLimiter", () => {
  it("permite hasta la capacidad y luego bloquea", () => {
    const limiter = new TokenBucketRateLimiter(2, 1, () => 0);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
  });

  it("cada llave tiene su propio presupuesto independiente", () => {
    const limiter = new TokenBucketRateLimiter(1, 1, () => 0);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("b")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
  });

  it("se recarga con el tiempo según refillPerSecond", () => {
    let now = 0;
    const limiter = new TokenBucketRateLimiter(1, 1, () => now);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
    now += 1000; // 1 segundo después, se recarga 1 token
    expect(limiter.tryConsume("a")).toBe(true);
  });

  it("rechaza capacidad o tasa de recarga no positivas", () => {
    expect(() => new TokenBucketRateLimiter(0, 1)).toThrow();
    expect(() => new TokenBucketRateLimiter(1, 0)).toThrow();
    expect(() => new TokenBucketRateLimiter(-1, 1)).toThrow();
    expect(() => new TokenBucketRateLimiter(1, Number.NaN)).toThrow();
  });
});

describe("UnlimitedRateLimiter", () => {
  it("siempre permite", () => {
    const limiter = new UnlimitedRateLimiter();
    for (let i = 0; i < 100; i++) expect(limiter.tryConsume("cualquiera")).toBe(true);
  });
});
