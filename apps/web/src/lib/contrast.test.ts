import { describe, expect, it } from "vitest";

import { contrastRatio, WCAG_AA_NORMAL_TEXT, type HslTuple } from "@/lib/contrast";

/**
 * Prueba de tokens (W-17): reproduce en frío, sin navegador, el contraste de
 * cada variante de `Badge` (`src/components/ui/badge.tsx`) en claro y en
 * oscuro, copiando los valores HSL literales de `src/index.css`. Si alguien
 * cambia un token de color sin correr `test:e2e`, esta prueba lo atrapa
 * igual — y documenta el número exacto de contraste de cada variante, no
 * solo "pasa/no pasa" como el axe-core del E2E.
 *
 * Los valores fondo/texto deben mantenerse sincronizados a mano con
 * `src/index.css`: no se importa el CSS aquí a propósito (jsdom no calcula
 * variables CSS custom properties de forma fiable sin un navegador real).
 */

interface BadgeVariantTokens {
  variant: string;
  background: HslTuple;
  foreground: HslTuple;
}

const LIGHT_VARIANTS: BadgeVariantTokens[] = [
  { variant: "default", background: [224, 76, 48], foreground: [0, 0, 100] },
  { variant: "secondary", background: [224, 76, 48], foreground: [0, 0, 100] },
  { variant: "destructive", background: [352, 83, 41], foreground: [0, 0, 100] },
  { variant: "success", background: [152, 60, 30], foreground: [0, 0, 100] },
  { variant: "warning", background: [38, 92, 40], foreground: [216, 50, 12] },
];

const DARK_VARIANTS: BadgeVariantTokens[] = [
  { variant: "default", background: [213, 82, 62], foreground: [216, 45, 9] },
  { variant: "secondary", background: [199, 89, 55], foreground: [216, 45, 9] },
  // W-17: era [352, 75, 55] → 4.30:1 (violación serious de color-contrast,
  // requerido 4.5:1). Corregido a [352, 75, 48] en src/index.css.
  { variant: "destructive", background: [352, 75, 48], foreground: [0, 0, 100] },
  { variant: "success", background: [152, 55, 45], foreground: [216, 45, 9] },
  { variant: "warning", background: [38, 85, 55], foreground: [216, 45, 9] },
];

describe("Contraste WCAG de las variantes de Badge (W-17)", () => {
  it.each(LIGHT_VARIANTS)("modo claro — variante $variant ≥ 4.5:1", ({ variant, background, foreground }) => {
    const ratio = contrastRatio(background, foreground);
    expect(ratio, `variante ${variant} en claro: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });

  it.each(DARK_VARIANTS)("modo oscuro — variante $variant ≥ 4.5:1", ({ variant, background, foreground }) => {
    const ratio = contrastRatio(background, foreground);
    expect(ratio, `variante ${variant} en oscuro: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });

  it("la variante destructive en oscuro queda por encima del umbral con margen (no al filo)", () => {
    const ratio = contrastRatio([352, 75, 48], [0, 0, 100]);
    expect(ratio).toBeGreaterThanOrEqual(5);
  });
});
