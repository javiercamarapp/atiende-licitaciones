import type { ReactNode } from "react";

import { AtiendeWordmark } from "@/components/AtiendeLogo";
import { SkipLink } from "@/components/SkipLink";
import "@/pages/login.css";

interface AuthScreenProps {
  /** Texto pequeño en versalitas sobre el título (contexto de la pantalla). */
  eyebrow: string;
  /** El único <h1> de la pantalla. */
  title: string;
  /** Párrafo introductorio bajo el título. */
  intro: ReactNode;
  /** Id del contenedor al que salta el enlace "saltar al…" (debe ser único por pantalla). */
  contentId: string;
  skipLabel: string;
  children: ReactNode;
}

/**
 * Ronda 8b: el marco COMPARTIDO de las pantallas públicas de cuenta que
 * llegan desde un correo (`/recuperar-contrasena`,
 * `/restablecer-contrasena`, `/verificar-correo`, `/revisa-tu-correo`,
 * `/invitaciones/aceptar`, `/preferencias/baja`).
 *
 * Existe por una razón concreta, no por estética: ninguna de estas rutas
 * cuelga de `<AppShell/>` (todas son alcanzables SIN sesión), así que cada
 * una necesita su propio `<main>`, su propio `<h1>` y su propio enlace de
 * salto — sin eso axe reporta `landmark-one-main`, `page-has-heading-one` y
 * `region` en las seis (el mismo hallazgo W-08 que en su día obligó a
 * dárselos a mano a `/login`). Duplicar ese andamiaje seis veces era
 * exactamente la forma de que una de las seis se quedara sin él.
 *
 * `/login` y `/registro` NO se migran a este componente: su lámina
 * decorativa y su composición ya estaban auditadas (W-11) y reescribirlas
 * aquí solo añadiría riesgo sin cambiar nada de lo que el usuario ve.
 */
export function AuthScreen({ eyebrow, title, intro, contentId, skipLabel, children }: AuthScreenProps) {
  return (
    <main className="min-h-screen bg-background lg:grid lg:grid-cols-2">
      <SkipLink targetId={contentId}>{skipLabel}</SkipLink>

      <section className="flex min-h-screen flex-col px-6 py-7 sm:px-10 lg:px-14 lg:py-10">
        <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col">
          <header className="flex items-center">
            <AtiendeWordmark />
          </header>

          <div className="flex flex-1 flex-col justify-center py-12">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{eyebrow}</p>
            <h1 className="login-serif mt-5 text-[30px] font-medium leading-[1.15] text-foreground sm:text-[38px]">{title}</h1>
            <div className="mt-4 text-[15px] leading-relaxed text-muted-foreground">{intro}</div>

            <div
              id={contentId}
              tabIndex={-1}
              className="mt-9 rounded-2xl ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {children}
            </div>
          </div>
        </div>
      </section>

      {/* Lámina decorativa: la misma de /login y /registro. */}
      <aside
        aria-hidden="true"
        className="relative hidden overflow-hidden bg-[linear-gradient(160deg,hsl(var(--primary))_0%,hsl(216_45%_9%)_100%)] lg:flex lg:flex-col lg:justify-end lg:p-10"
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,hsl(0_0%_100%/0.12),transparent_45%)]" />
        <p className="relative text-xs font-semibold uppercase tracking-[0.16em] text-primary-foreground/70">
          Licitaciones públicas en México
        </p>
        <p className="login-serif relative mt-3.5 max-w-sm text-[26px] leading-tight text-primary-foreground">
          Convocatorias, evaluación y entrega, en un solo lugar.
        </p>
      </aside>
    </main>
  );
}
