import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface LoadingStateProps {
  label?: string;
  rows?: number;
  className?: string;
}

export function LoadingState({ label = "Cargando…", rows = 3, className }: LoadingStateProps) {
  return (
    <div role="status" aria-label={label} className={cn("space-y-3", className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-16 w-full rounded-2xl" />
      ))}
    </div>
  );
}
