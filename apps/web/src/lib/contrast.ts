/**
 * Cálculo de contraste WCAG 2.x (fórmula del §1.4.3) a partir de tripletes
 * HSL — los mismos valores que declaran los tokens de `src/index.css`
 * (`--destructive`, `--warning`, etc.), para poder verificar en una prueba
 * unitaria "de tokens" que cada variante de badge cumple ≥4.5:1 sin tener
 * que levantar un navegador real (eso lo cubre `e2e/contraste.spec.ts` con
 * axe-core). Ver hallazgo W-17 (`docs/auditoria-1/web-reverificacion.md`).
 */
export type HslTuple = [h: number, s: number, l: number];

function hslToRgb([h, s, l]: HslTuple): [number, number, number] {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sNorm * Math.min(lNorm, 1 - lNorm);
  const f = (n: number) => lNorm - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const [rl, gl, bl] = [r, g, b].map((c) => {
    const channel = c / 255;
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

/** Ratio de contraste WCAG entre dos colores HSL (orden indistinto). */
export function contrastRatio(a: HslTuple, b: HslTuple): number {
  const l1 = relativeLuminance(hslToRgb(a));
  const l2 = relativeLuminance(hslToRgb(b));
  const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Umbral WCAG 2 AA para texto normal (<18pt / <14pt bold). */
export const WCAG_AA_NORMAL_TEXT = 4.5;
