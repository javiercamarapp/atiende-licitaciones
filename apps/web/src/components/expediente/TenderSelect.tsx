import { FileSearch } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { describeApiError } from "@/hooks/useAuth";
import { useTenders } from "@/hooks/useTenders";

/**
 * Selector de convocatoria compartido por todos los módulos del expediente
 * (Análisis de bases, Cumplimiento documental, Redacción, Revisión,
 * Expediente, Entregas, Paquete descargable, Seguimiento post-adjudicación):
 * cada uno de esos 26 endpoints de apps/api cuelga de
 * `/expediente/tenders/:tenderId/...`, así que la convocatoria activa es el
 * primer dato que hace falta en cualquiera de esas pantallas. Mismo patrón
 * ya usado en GoNoGoPage.tsx (selección independiente por página, no
 * compartida globalmente).
 */
export interface TenderSelectProps {
  value: string | null;
  onChange: (tenderId: string) => void;
  emptyDescription?: string;
}

export function TenderSelect({ value, onChange, emptyDescription }: TenderSelectProps) {
  const { data: tendersPage, isLoading, isError, error, refetch } = useTenders({ limit: 50 });

  if (isLoading) return <LoadingState label="Cargando convocatorias…" rows={2} />;
  if (isError) return <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />;
  if (!tendersPage || tendersPage.items.length === 0) {
    return (
      <EmptyState
        icon={FileSearch}
        title="Sin convocatorias"
        description={emptyDescription ?? "No hay convocatorias todavía. Descúbrelas primero desde Convocatorias › Descubrimiento."}
      />
    );
  }

  return (
    <Select value={value ?? undefined} onValueChange={onChange}>
      <SelectTrigger aria-label="Convocatoria" className="w-full sm:w-[420px]">
        <SelectValue placeholder="Selecciona una convocatoria" />
      </SelectTrigger>
      <SelectContent>
        {tendersPage.items.map((t) => (
          <SelectItem key={t.id} value={t.id}>
            {t.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
