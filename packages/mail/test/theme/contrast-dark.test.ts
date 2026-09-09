import { describe, expect, it } from "vitest";
import { darkColors } from "../../src/theme";
import { contrastRatio } from "./contrast.test";

/**
 * ML-09 — la contraparte de `contrast.test.ts` para la paleta de RESPALDO de
 * modo oscuro (`darkColors`/`DARK_MODE_STYLE` en `theme.ts`). No basta con
 * que el `<style>` exista (eso lo cubre `test/components/email-layout.test.tsx`);
 * cada color elegido a mano para la tarjeta oscura tiene que seguir
 * cumpliendo el mismo umbral WCAG que ya se exige en modo claro — un
 * "respaldo" que resulta ilegible no es un respaldo real.
 */
describe("contraste de la paleta de correo en modo oscuro (ML-09)", () => {
  it("el texto de título (ink) sobre la tarjeta oscura cumple WCAG AA (>=4.5:1)", () => {
    expect(contrastRatio(darkColors.ink, darkColors.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("el texto de cuerpo (body) sobre la tarjeta oscura cumple WCAG AA (>=4.5:1)", () => {
    expect(contrastRatio(darkColors.body, darkColors.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("el texto secundario (muted) sobre la tarjeta y el lienzo oscuros cumple WCAG AA (>=4.5:1)", () => {
    expect(contrastRatio(darkColors.muted, darkColors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(darkColors.muted, darkColors.canvas)).toBeGreaterThanOrEqual(4.5);
  });

  it("el texto más discreto del pie (faint) sobre la tarjeta y el lienzo oscuros cumple WCAG AA de texto normal (>=4.5:1)", () => {
    expect(contrastRatio(darkColors.faint, darkColors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(darkColors.faint, darkColors.canvas)).toBeGreaterThanOrEqual(4.5);
  });

  it("el fondo del bloque de código/respaldo (well) se distingue de la tarjeta oscura y el texto ink sigue siendo legible sobre él", () => {
    expect(contrastRatio(darkColors.well, darkColors.surface)).toBeGreaterThan(1);
    expect(contrastRatio(darkColors.ink, darkColors.well)).toBeGreaterThanOrEqual(4.5);
  });

  it("los tres tonos con rótulo (danger/warning/success) son legibles sobre la tarjeta oscura (>=4.5:1)", () => {
    expect(contrastRatio(darkColors.danger, darkColors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(darkColors.warning, darkColors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(darkColors.success, darkColors.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("el botón CTA no cambia en modo oscuro: el azul de marca (#1d4ed8) con texto blanco sigue cumpliendo WCAG AA", () => {
    // No hay `darkColors.brand` a propósito — ver el comentario de
    // `darkColors` en theme.ts: el mismo azul ya funciona en ambos modos.
    expect(contrastRatio("#ffffff", "#1d4ed8")).toBeGreaterThanOrEqual(4.5);
  });
});
