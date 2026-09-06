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
          // Encontrado real (axe, test:e2e:full): sin una clase explícita
          // aquí, el título del toast heredaba el color por defecto de
          // Sonner (bajo contraste en modo oscuro, ~3.59:1 medido) en vez
          // del `text-foreground` del contenedor `.toast` -- WCAG 2 AA
          // exige 4.5:1 mínimo para texto normal.
          title: "group-[.toast]:text-foreground",
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
