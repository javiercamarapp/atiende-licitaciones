/**
 * Tokens de marca de Atiende, copiados como literales.
 *
 * Un correo no entiende `var(--token)`: Outlook (motor Word), Gmail y la
 * mayoría de los clientes móviles no soportan custom properties de CSS, así
 * que aquí los colores viajan como valores fijos. La fuente de la verdad son
 * los tokens HSL documentados en `docs/investigacion/frontend-restaurantes.md`
 * (§2.1, paleta "white / blue / sky-blue" de la consola web de Atiende); si
 * la paleta cambia allá, se cambia AQUÍ también — no hay una tercera fuente.
 *
 * Igual que en la disciplina de diseño de la que viene esta paleta (un solo
 * acento "con gotero"), el correo no pinta bandas de color: el tono de un
 * aviso se dice en una palabra (ver `ToneBadge`), el resto se mantiene
 * neutro.
 */
export const colors = {
  /** --background modo claro (#f7f9fc): el lienzo detrás de la tarjeta. */
  canvas: "#f7f9fc",
  /** --card / --popover: la superficie de la tarjeta del correo. */
  surface: "#ffffff",
  /** --foreground: el negro azulado de los títulos. */
  ink: "#0f1b2d",
  /** Cuerpo de párrafo: un gris oscuro legible, un peldaño bajo `ink`. */
  body: "#3f4a5c",
  /** --muted-foreground: texto secundario (pie, etiquetas). */
  muted: "#5b6b82",
  /**
   * Un peldaño más tenue que `muted`, para el texto más discreto del pie
   * (motivo de envío, enlace de baja, administrar preferencias). Antes
   * `#8291a3` (ML-04): 3.22:1 sobre `surface` y 3.05:1 sobre `canvas`, por
   * debajo del 4.5:1 que exige WCAG AA para texto normal (no es texto
   * grande ni negrita) — se oscureció a `#637283` (4.92:1 / 4.67:1) para
   * cumplir el umbral completo en ambos fondos, verificado en
   * `test/theme/contrast.test.ts`.
   */
  faint: "#637283",
  /** --border / --input: líneas y separadores. */
  line: "#e2e8f0",
  /** --muted: fondos de reposo (bloque de código, callouts neutros). */
  well: "#eef2f7",
  /** --primary / --secondary / --accent: el acento azul único de Atiende. */
  brand: "#1d4ed8",
  /** --gold (alias legado, celeste): acento secundario del glifo. */
  sky: "#38bdf8",
  /** Celeste claro de las "líneas de movimiento" del glifo. */
  skyLight: "#7dd3fc",
  /** --destructive: rojo de vencimientos/alertas urgentes. */
  danger: "#c0122a",
  /** Ámbar para avisos que requieren atención sin ser urgentes. */
  warning: "#b45309",
  /** Verde para confirmaciones positivas (paquete listo, adjudicación). */
  success: "#15803d",
} as const;

/**
 * Las tres familias tipográficas de la consola de Atiende
 * (`docs/investigacion/frontend-restaurantes.md` §2.2). En correo los
 * webfonts casi nunca cargan —solo Apple Mail y algún cliente minoritario—
 * así que se NOMBRAN primero y el sistema resuelve el resto: quien las tenga
 * instaladas ve el tipo real del producto, y quien no, una pila neutra que
 * se le parece. Nunca se cae a Times.
 */
export const fonts = {
  /** Inter Tight — encabezados y wordmark. */
  display: `'Inter Tight',Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`,
  /** Inter — cuerpo y menús. */
  sans: `Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`,
  /** IBM Plex Mono — códigos de un solo uso: un 1 y una l no se confunden. */
  mono: `'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace`,
} as const;

/** Ancho fijo estándar de correo: lo que Outlook, Gmail y el resto de los
 *  clientes respetan sin desbordar. */
export const EMAIL_WIDTH = 600;

/** Radio base (--radius: 0.75rem → 12px) usado en tarjetas y bloques. */
export const RADIUS = 12;

export type ToneKey = "neutral" | "atencion" | "urgente" | "exito";

/**
 * El tono de un correo se dice en una palabra (micro-rótulo), no en bandas
 * de color: así el día que lleguen tres avisos seguidos no se leen como tres
 * alarmas.
 */
export const TONE_LABEL: Record<ToneKey, { label: string | null; color: string }> = {
  neutral: { label: null, color: colors.muted },
  atencion: { label: "Requiere atención", color: colors.warning },
  urgente: { label: "Urgente", color: colors.danger },
  exito: { label: "Completado", color: colors.success },
};

/**
 * ML-09 — paleta de RESPALDO para `prefers-color-scheme: dark`.
 *
 * Antes, `EmailLayout` solo declaraba `<meta name="color-scheme"
 * content="light only">`: eso le PIDE a los pocos clientes que lo respetan
 * (Apple Mail, iOS/macOS Mail) que NUNCA oscurezcan el correo — así que en
 * modo oscuro seguía viéndose una tarjeta blanca de punta a punta. Esta
 * paleta y `DARK_MODE_STYLE` (más abajo) reemplazan ese "nunca" por un
 * segundo juego de colores real, activado por el propio cliente vía media
 * query — no una promesa de "algún día".
 *
 * No son los tokens de `colors` con un filtro automático: cada valor se
 * eligió a mano para seguir cumpliendo WCAG AA sobre `surfaceDark`/`canvasDark`
 * (verificado en `test/theme/contrast-dark.test.ts`, la contraparte de
 * `contrast.test.ts`). El azul de marca (`colors.brand`) y el botón CTA NO
 * cambian: `#1d4ed8` ya tiene contraste de sobra contra texto blanco (6.7:1)
 * y se distingue perfectamente sobre un fondo oscuro — solo los tonos de
 * urgencia (`danger`/`warning`/`success`), pensados para una tarjeta BLANCA,
 * pierden contraste suficiente sobre una tarjeta oscura y sí necesitan su
 * propia variante.
 */
export const darkColors = {
  canvas: "#0a0e16",
  surface: "#141b29",
  ink: "#eef2fa",
  body: "#c7d0de",
  muted: "#9aa7ba",
  faint: "#93a0b5",
  line: "#2a3446",
  well: "#1b2434",
  danger: "#f87171",
  warning: "#fbbf24",
  success: "#4ade80",
} as const;

/** Variante oscura de `TONE_LABEL`, para las clases `am-tone-*` que
 *  `ToneBadge` aplica junto a su color inline (ver `components/blocks.tsx`). */
export const TONE_LABEL_DARK: Record<ToneKey, string> = {
  neutral: darkColors.muted,
  atencion: darkColors.warning,
  urgente: darkColors.danger,
  exito: darkColors.success,
};

/**
 * El `<style>` de respaldo para modo oscuro que `EmailLayout` inyecta en su
 * `<Head>`. Usa CLASES (no `var()`, que el correo no soporta) con
 * `!important` para poder pisar los estilos inline de `colors` — la técnica
 * estándar de dark-mode en correo, porque una declaración `!important` en
 * una hoja de estilos SÍ gana sobre un `style=""` inline sin `!important`.
 *
 * Se repite una vez bajo `@media (prefers-color-scheme: dark)` (Apple Mail,
 * Outlook.com web/desktop nuevo) y otra vez bajo los selectores de atributo
 * que Gmail (apps iOS/Android) usa cuando aplica SU PROPIO recoloreado
 * automático (`[data-ogsc]`/`[data-ogsb]`, "Outlook/Gmail Style Color/
 * Background") — sin este segundo bloque, Gmail seguiría adivinando sus
 * propios colores en vez de usar los que aquí se eligieron a propósito.
 * Los clientes que ignoran `<style>` en el `<head>` (Outlook de escritorio)
 * simplemente no ven nada de esto y se quedan con el diseño claro normal —
 * nunca se rompe nada, solo se pierde la variante oscura.
 */
export const DARK_MODE_STYLE = `
  @media (prefers-color-scheme: dark) {
    .am-canvas { background-color: ${darkColors.canvas} !important; }
    .am-card { background-color: ${darkColors.surface} !important; border-color: ${darkColors.line} !important; }
    .am-ink { color: ${darkColors.ink} !important; }
    .am-body-text { color: ${darkColors.body} !important; }
    .am-muted { color: ${darkColors.muted} !important; }
    .am-faint { color: ${darkColors.faint} !important; }
    .am-line { border-color: ${darkColors.line} !important; }
    .am-well { background-color: ${darkColors.well} !important; border-color: ${darkColors.line} !important; }
    .am-tone-atencion { color: ${TONE_LABEL_DARK.atencion} !important; }
    .am-tone-urgente { color: ${TONE_LABEL_DARK.urgente} !important; }
    .am-tone-exito { color: ${TONE_LABEL_DARK.exito} !important; }
  }
  [data-ogsc] .am-canvas, [data-ogsb] .am-canvas { background-color: ${darkColors.canvas} !important; }
  [data-ogsc] .am-card, [data-ogsb] .am-card { background-color: ${darkColors.surface} !important; border-color: ${darkColors.line} !important; }
  [data-ogsc] .am-ink { color: ${darkColors.ink} !important; }
  [data-ogsc] .am-body-text { color: ${darkColors.body} !important; }
  [data-ogsc] .am-muted { color: ${darkColors.muted} !important; }
  [data-ogsc] .am-faint { color: ${darkColors.faint} !important; }
  [data-ogsc] .am-line, [data-ogsb] .am-line { border-color: ${darkColors.line} !important; }
  [data-ogsc] .am-well, [data-ogsb] .am-well { background-color: ${darkColors.well} !important; border-color: ${darkColors.line} !important; }
  [data-ogsc] .am-tone-atencion { color: ${TONE_LABEL_DARK.atencion} !important; }
  [data-ogsc] .am-tone-urgente { color: ${TONE_LABEL_DARK.urgente} !important; }
  [data-ogsc] .am-tone-exito { color: ${TONE_LABEL_DARK.exito} !important; }
`;
