/* eslint-disable react-refresh/only-export-components -- primitivo shadcn: exporta el componente junto a sus variantes/helpers a propósito */
import { Toaster as Sonner, toast } from "sonner";

// Único sistema de toast de la app (decisión explícita, ver README §Decisiones):
// el origen (atiende-restaurantes) mantenía Radix Toast + Sonner en paralelo sin
// un criterio documentado; aquí usamos solo Sonner detrás de cada notificación.
type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-card group-[.toaster]:text-foreground group-[.toaster]:border group-[.toaster]:border-border group-[.toaster]:shadow-elevated group-[.toaster]:rounded-2xl",
          // Encontrado real (axe, test:e2e:full): `[data-title]`/
          // `[data-sonner-toast]` en el CSS de Sonner fijan `color` (vía
          // `color: inherit` y `color: var(--normal-text)` respectivamente)
          // con una regla `[data-sonner-toaster][data-theme='light'] {
          // --normal-text: var(--gray12); ... }` de especificidad NORMAL
          // (no `:where()`) que redeclara `--normal-text` sobre el MISMO
          // elemento donde Sonner también aplica cualquier `style` que le
          // pasemos -- en la práctica, ni una clase `group-[...]:` ni
          // redeclarar `--normal-text`/`--normal-bg` vía `style` logró
          // ganarle a esa regla en el navegador real (3.59:1, luego 1.95:1
          // medidos por axe en modo oscuro, ambos por debajo del 4.5:1 de
          // WCAG 2 AA). `!` (Tailwind `!important`) sí gana de forma
          // determinística sobre cualquier regla de origen "author" normal,
          // sin depender de la cascada interna de Sonner.
          title: "!text-foreground",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster, toast };
