import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { CreditCard, HelpCircle, LogOut, Settings, UserRound } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { ROLE_LABELS } from "@/lib/roles";
import { ThemeSelector } from "@/components/ThemeSelector";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface SidebarAccountBlockProps {
  onNavigate?: () => void;
  className?: string;
}

/**
 * Bloque inferior del sidebar, estilo Likida/atiende-restaurantes
 * (AdminSidebar.tsx: centro de ayuda, accesos de cuenta, selector de tema,
 * tarjeta de usuario) — ver docs/investigacion/frontend-restaurantes.md.
 *
 * Dos de los tres accesos de cuenta no tienen página real detrás todavía
 * en este repo (no existe ningún "centro de ayuda", "perfil de usuario" ni
 * "plan y facturación" en apps/api ni en las rutas de App.tsx) y quedan
 * deshabilitados con "Pronto" — mismo criterio que el resto del sidebar
 * (SidebarNav.tsx) en vez de fingir que llevan a algo que no existe.
 * "Configuración" SÍ es una ruta real (`/configuracion`, ConfiguracionPage).
 */
export function SidebarAccountBlock({ onNavigate, className }: SidebarAccountBlockProps) {
  const { user, currentMembership, logout } = useAuth();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      setLoggingOut(false);
      navigate("/login", { replace: true });
    }
  };

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="space-y-0.5 rounded-xl bg-muted/60 p-1.5">
        <button
          type="button"
          disabled
          title="Centro de ayuda: todavía no existe esta sección en Atiende Licitaciones."
          className="mb-1 flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-[13px] text-muted-foreground/60"
        >
          <HelpCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" strokeWidth={1.75} />
          Centro de ayuda
        </button>

        <button
          type="button"
          disabled
          title="Mi perfil: todavía no existe esta pantalla en Atiende Licitaciones."
          className="flex w-full items-center justify-between gap-2 rounded-full px-3 py-1.5 text-[13px] text-muted-foreground/50"
        >
          <span className="flex items-center gap-2.5">
            <UserRound className="h-4 w-4 shrink-0" aria-hidden="true" strokeWidth={1.75} />
            Mi perfil
          </span>
          <Badge variant="outline" className="text-[9px] uppercase tracking-[0.06em] text-muted-foreground/60">
            Pronto
          </Badge>
        </button>

        <button
          type="button"
          disabled
          title="Plan y facturación: todavía no existe esta pantalla en Atiende Licitaciones."
          className="flex w-full items-center justify-between gap-2 rounded-full px-3 py-1.5 text-[13px] text-muted-foreground/50"
        >
          <span className="flex items-center gap-2.5">
            <CreditCard className="h-4 w-4 shrink-0" aria-hidden="true" strokeWidth={1.75} />
            Plan y facturación
          </span>
          <Badge variant="outline" className="text-[9px] uppercase tracking-[0.06em] text-muted-foreground/60">
            Pronto
          </Badge>
        </button>

        <NavLink
          to="/configuracion"
          onClick={onNavigate}
          className="flex w-full items-center gap-2.5 rounded-full px-3 py-1.5 text-[13px] text-foreground transition-colors hover:bg-background"
        >
          <Settings className="h-4 w-4 shrink-0" aria-hidden="true" strokeWidth={1.75} />
          Configuración
        </NavLink>

        <div className="flex justify-center pb-0.5 pt-1.5">
          <ThemeSelector />
        </div>
      </div>

      {/* Tarjeta de usuario: identidad y rol reales (GET /me, GET /organizations — ver useAuth.tsx), logout real. */}
      {user && (
        <div className="flex items-center gap-2 border-t border-border px-1 pt-1.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
            {user.email.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] text-foreground">{user.email}</p>
            <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
              {currentMembership ? (ROLE_LABELS[currentMembership.role] ?? currentMembership.role) : "Sin organización"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleLogout()}
            disabled={loggingOut}
            aria-label="Cerrar sesión"
            className="shrink-0 text-destructive hover:opacity-70 disabled:opacity-40"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
