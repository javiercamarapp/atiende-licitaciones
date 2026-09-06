// vitest-axe@0.1.0 ships type augmentation written for an older Vitest
// typings shape (`namespace Vi { interface Assertion }`), which Vitest 2.x
// no longer exposes — the matcher works at runtime (registered in
// setup.ts via `expect.extend`) but `toHaveNoViolations` isn't visible to
// tsc without this local augmentation of the current `vitest` module shape.
import "vitest";

declare module "vitest" {
  interface Assertion<T = unknown> {
    toHaveNoViolations(): T extends { violations: unknown[] } ? void : never;
  }
  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): void;
  }
}
