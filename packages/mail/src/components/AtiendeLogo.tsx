/**
 * El glifo de Atiende (3 barras + círculo + trazo corriendo) tal como lo
 * define `AtiendeMark`/`AtiendeWordmark` en la consola web
 * (`docs/investigacion/frontend-restaurantes.md` §3): mismas coordenadas
 * (`viewBox 0 0 40 32`), mismos tres colores literales (`skyLight`/`sky`/
 * `brand` de `theme.ts`). `AtiendeLogoMark` es ese componente, para
 * contextos que sí soportan SVG sin reservas (la página de índice de
 * `preview/`, o cualquier reuso fuera de un cliente de correo).
 *
 * ADENTRO DE UN CORREO NO SE USA. `docs/investigacion/salida-promocion-referencias.md`
 * §2 documenta el porqué con las dos referencias reales del proyecto:
 * Gmail (el cliente más usado) **descarta el elemento `<svg>` completo** de
 * un correo HTML, con o sin comentarios condicionales — no es un problema
 * exclusivo de Outlook. Por eso Atiende Restaurantes decidió explícitamente
 * "sin logo-imagen — wordmark de texto" para su correo transaccional, y
 * Likida, que sí necesita un glifo, lo manda como **adjunto `cid:` en
 * formato rasterizado (PNG)** — nunca como SVG inline ni como URL externa
 * (bloqueada por default en un remitente nuevo).
 *
 * Este paquete todavía no tiene un archivo de logo rasterizado "maestro" de
 * Atiende (el SVG del §3 es, por su propio comentario en el código fuente,
 * "una reconstrucción, no el asset oficial"): fabricar un PNG a partir de
 * esa reconstrucción sería inventar un asset que nadie aprobó. Mientras
 * tanto, `EmailLayout` usa el WORDMARK DE TEXTO (`AtiendeWordmarkText`,
 * Inter Tight en el azul de marca) como encabezado — el mismo criterio de
 * Atiende Restaurantes, que nunca falla en ningún cliente porque no depende
 * de que se cargue ninguna imagen.
 *
 * El plumbing para el caso Likida (logo adjunto `cid:`) SÍ existe end to
 * end — `OutboundAttachment`/`OutboundEmail.attachments` en
 * `provider/types.ts`, cableado en los tres adaptadores HTTP/SMTP — listo
 * para el día en que exista un PNG oficial: ese día, `EmailLayout` gana un
 * prop `logoCid` que cambia el wordmark de texto por
 * `<Img src="cid:...">` con el mismo alt con estilo como respaldo.
 */
import * as React from "react";
import { colors, fonts } from "../theme";

export interface AtiendeLogoMarkProps {
  className?: string;
  /** Alto en px; el ancho escala proporcional al viewBox (40x32). */
  height?: number;
}

/** El glifo completo, como componente React — SOLO para contextos que
 *  renderizan DOM real (la página de índice de `preview/`). No se usa
 *  dentro del HTML de un correo: ver el comentario de cabecera de este
 *  archivo. */
export function AtiendeLogoMark({ height = 32 }: AtiendeLogoMarkProps): React.ReactElement {
  const width = Math.round((height * 40) / 32);
  return (
    <svg
      viewBox="0 0 40 32"
      width={width}
      height={height}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Atiende"
    >
      <rect x="0" y="4" width="13" height="4" rx="2" fill={colors.skyLight} />
      <rect x="4" y="12" width="13" height="4" rx="2" fill={colors.skyLight} />
      <rect x="0" y="20" width="13" height="4" rx="2" fill={colors.skyLight} />
      <circle cx="26" cy="6" r="5" fill={colors.sky} />
      <path
        d="M14 32 L20 20 Q22 16 27 16 L31 16 Q34 16 36 13 L38 10"
        stroke={colors.brand}
        strokeWidth={7}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export interface AtiendeWordmarkTextProps {
  fontSize?: number;
}

/**
 * El wordmark de texto — el encabezado real de todo correo de Atiende
 * Licitaciones. Es un `<span>` con tipografía y color de marca, nada más:
 * no hay imagen que bloquear, ni SVG que un cliente pueda descartar. Mismo
 * criterio explícito que Atiende Restaurantes documenta en su plantilla de
 * correo real.
 */
export function AtiendeWordmarkText({ fontSize = 20 }: AtiendeWordmarkTextProps): React.ReactElement {
  return (
    <span
      style={{
        fontFamily: fonts.display,
        fontSize,
        fontWeight: 700,
        letterSpacing: "-0.01em",
        color: colors.brand,
      }}
    >
      atiende
    </span>
  );
}
