import { describe, expect, it } from "vitest";
import { classifyHttpStatus } from "../../src/provider/types";

describe("classifyHttpStatus", () => {
  it("429 es retryable", () => {
    expect(classifyHttpStatus(429)).toBe("retryable");
  });
  it("5xx es retryable", () => {
    expect(classifyHttpStatus(500)).toBe("retryable");
    expect(classifyHttpStatus(503)).toBe("retryable");
  });
  it("el resto de los 4xx es permanent", () => {
    expect(classifyHttpStatus(400)).toBe("permanent");
    expect(classifyHttpStatus(401)).toBe("permanent");
    expect(classifyHttpStatus(404)).toBe("permanent");
    expect(classifyHttpStatus(422)).toBe("permanent");
  });
});
