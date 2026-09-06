import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { ChevronDown } from "lucide-react";

import { NAV_GROUPS } from "@/config/navigation";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

const STORAGE_KEY = "atiende-licitaciones-grupos-abiertos";

function leerGruposAbiertos(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as string[];
  } catch {
    // localStorage no disponible (SSR/tests) o valor corrupto: se ignora.
  }
  return NAV_GROUPS.map((g) => g.id);
}

export interface SidebarNavProps {
  onNavigate?: () => void;
  className?: string;
}

/**
 * Contenido de navegación compartido entre la sidebar de escritorio y el
 * drawer móvil (Sheet) — un solo lugar de verdad para los grupos/items.
 */
export function SidebarNav({ onNavigate, className }: SidebarNavProps) {
  const [gruposAbiertos, setGruposAbiertos] = useState<string[]>(leerGruposAbiertos);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(gruposAbiertos));
    } catch {
      // Persistencia best-effort; no bloquea la navegación si falla.
    }
  }, [gruposAbiertos]);

  const toggleGrupo = (id: string) => {
    setGruposAbiertos((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]));
  };

  return (
    <nav aria-label="Navegación principal" className={cn("flex flex-col gap-1", className)}>
      {NAV_GROUPS.map((group) => {
        const abierto = gruposAbiertos.includes(group.id);
        const listId = `grupo-${group.id}`;
        return (
          <div key={group.id} className="px-2">
            <button
              type="button"
              aria-expanded={abierto}
              aria-controls={listId}
              onClick={() => toggleGrupo(group.id)}
              className="flex w-full items-center justify-between rounded-lg px-2 py-2 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
            >
              <span>{group.label}</span>
              <ChevronDown
                className={cn("h-3.5 w-3.5 transition-transform", abierto ? "rotate-0" : "-rotate-90")}
                aria-hidden="true"
              />
            </button>
            {abierto && (
              <ul id={listId} className="mt-0.5 space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  if (item.disabled) {
                    return (
                      <li key={item.id}>
                        <span className="flex cursor-not-allowed items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm text-muted-foreground/60">
                          <span className="flex items-center gap-2">
                            <Icon className="h-4 w-4" aria-hidden="true" strokeWidth={1.75} />
                            {item.label}
                          </span>
                          <Badge variant="outline" className="text-[10px]">
                            Pronto
                          </Badge>
                        </span>
                      </li>
                    );
                  }
                  return (
                    <li key={item.id}>
                      <NavLink
                        to={item.to}
                        onClick={onNavigate}
                        className={({ isActive }) =>
                          cn(
                            "flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors",
                            isActive
                              ? "bg-primary text-primary-foreground shadow-card"
                              : "text-foreground hover:bg-muted",
                          )
                        }
                      >
                        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" strokeWidth={1.75} />
                        {item.label}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}
