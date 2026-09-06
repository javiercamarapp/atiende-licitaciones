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
