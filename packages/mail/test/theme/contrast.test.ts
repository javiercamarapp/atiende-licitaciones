import { describe, expect, it } from "vitest";
import { colors } from "../../src/theme";

/** Razón de contraste WCAG entre dos colores hex. Fórmula estándar de
 *  luminancia relativa (sRGB) + (L1+0.05)/(L2+0.05). */
function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const value = Number.parseInt(clean, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [rl, gl, bl] = [channel(r), channel(g), channel(b)];
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexToRgb(hexA));
  const lb = relativeLuminance(hexToRgb(hexB));
  const [lighter, darker] = la > lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

describe("contraste básico de la paleta de correo", () => {
  it("el texto de título (ink) sobre la tarjeta cumple WCAG AA (>=4.5:1)", () => {
    expect(contrastRatio(colors.ink, colors.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("el texto de cuerpo (body) sobre la tarjeta cumple WCAG AA (>=4.5:1)", () => {
    expect(contrastRatio(colors.body, colors.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("el texto del botón (blanco) sobre el fondo de marca cumple WCAG AA (>=4.5:1)", () => {
    expect(contrastRatio("#ffffff", colors.brand)).toBeGreaterThanOrEqual(4.5);
  });

  it("el texto secundario del pie (muted) sobre el lienzo cumple un mínimo básico (>=3:1)", () => {
    expect(contrastRatio(colors.muted, colors.canvas)).toBeGreaterThanOrEqual(3);
  });

  it("el rótulo de tono de urgencia (danger) sobre la tarjeta es legible (>=3:1, texto grande/negrita)", () => {
    expect(contrastRatio(colors.danger, colors.surface)).toBeGreaterThanOrEqual(3);
  });

  // ML-04: `faint` se usa en EmailLayout para texto normal (10-11.5px, ni
  // grande ni negrita) — el motivo de envío, el enlace de baja y el de
  // administrar preferencias. Eso exige el umbral COMPLETO de WCAG AA para
  // texto normal (>=4.5:1), no el relajado de 3:1 que solo aplica a texto
  // grande/negrita.
  it("ML-04: el texto discreto del pie (faint) sobre la tarjeta cumple WCAG AA de texto normal (>=4.5:1)", () => {
    expect(contrastRatio(colors.faint, colors.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("ML-04: el texto discreto del pie (faint) sobre el lienzo cumple WCAG AA de texto normal (>=4.5:1)", () => {
    expect(contrastRatio(colors.faint, colors.canvas)).toBeGreaterThanOrEqual(4.5);
  });
});
