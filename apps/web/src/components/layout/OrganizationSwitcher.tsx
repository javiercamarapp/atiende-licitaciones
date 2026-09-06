import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2 } from "lucide-react";

import { listOrganizaciones } from "@/lib/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * Selector de organización del header. Placeholder controlado por estado
 * local (no hay organización "de demo" hardcodeada): mientras no exista
 * backend o la organización no tenga datos, se muestra deshabilitado con un
 * rótulo honesto en vez de simular una organización real.
 */
export function OrganizationSwitcher() {
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const { data: organizaciones, isLoading } = useQuery({
    queryKey: ["organizaciones"],
    queryFn: listOrganizaciones,
    retry: false,
  });

  const opciones = organizaciones ?? [];
  const sinOrganizaciones = !isLoading && opciones.length === 0;

  return (
    <Select
      value={selected}
      onValueChange={setSelected}
      disabled={isLoading || sinOrganizaciones}
    >
      <SelectTrigger aria-label="Organización" className="h-9 w-[180px] gap-2 text-sm sm:w-[220px]">
        <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" strokeWidth={1.75} />
        <SelectValue placeholder={sinOrganizaciones ? "Sin organizaciones" : "Selecciona organización"} />
      </SelectTrigger>
      <SelectContent>
        {opciones.map((org) => (
          <SelectItem key={org.id} value={org.id}>
            {org.nombre}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
