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
      // Encontrado real (axe, test:e2e:full): el título del toast (el
      // texto de `toast.success/error(...)`, sin `description`) usa
      // `color: inherit` en el propio CSS de Sonner -- hereda de
      // `[data-sonner-toast]`, que Sonner colorea con SU PROPIA variable
      // `--normal-text` (paleta neutra fija de Sonner para su tema
      // "light" por defecto, independiente de nuestro `text-foreground`
      // de Tailwind). Nuestras clases `group-[.toaster]:bg-card`/
      // `text-foreground` de abajo cambian el FONDO del toast a la
      // tarjeta oscura del tema oscuro de la app, pero Sonner sigue
      // pensando que su texto debe ser oscuro (pensado para SU fondo
      // claro) -- 3.59:1 medido en modo oscuro real, bajo el mínimo 4.5:1
      // de WCAG 2 AA. Redeclarar `--normal-*` aquí (API soportada por
      // Sonner para tematizar sin pelear con su cascada CSS) ata el color
      // de texto real al mismo `--foreground`/`--card`/`--border` que ya
      // usan las clases, para light y dark a la vez.
      style={
        {
          "--normal-bg": "hsl(var(--card))",
          "--normal-text": "hsl(var(--foreground))",
          "--normal-border": "hsl(var(--border))",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-card group-[.toaster]:text-foreground group-[.toaster]:border group-[.toaster]:border-border group-[.toaster]:shadow-elevated group-[.toaster]:rounded-2xl",
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
