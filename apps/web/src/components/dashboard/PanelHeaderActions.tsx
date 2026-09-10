import { Bell, MessageCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatTodayMx } from "@/lib/datetime";

export interface PanelHeaderActionsProps {
  /**
   * Conteo real de alertas activas (vencimientos/seguimiento post-
   * adjudicación, ver `usePostAwardAlerts`) — NO un contador inventado.
   * `undefined` mientras la consulta todavía está cargando.
   */
  alertsCount?: number;
  /** Id del elemento al que la campana hace scroll (la sección de alertas ya visible en el panel). */
  alertsAnchorId?: string;
}

/**
 * Patrón de header calcado de atiende-restaurantes (AdminDashboard.tsx,
 * sección `activeSection === 'dashboard'`): botón "Chatea con tus datos",
 * campana de notificaciones con badge, fecha en píldora.
 *
 * Dos de los tres controles no tienen una funcionalidad real detrás en este
 * repo todavía, así que van honestamente deshabilitados con "Pronto" en vez
 * de fingir que funcionan (mismo criterio que los ítems del sidebar):
 *
 * - "Chatea con tus datos": no existe ningún endpoint de chat/analítica
 *   conversacional en apps/api — deshabilitado.
 * - Campana de notificaciones: no hay un feed de notificaciones dedicado,
 *   pero SÍ hay datos reales de alerta ya cargados en este mismo panel
 *   (`usePostAwardAlerts`/`AlertsList`) — se reutiliza ese conteo real en
 *   vez de inventar un contador, y el clic hace scroll a esa sección en
 *   vez de no hacer nada.
 */
export function PanelHeaderActions({ alertsCount, alertsAnchorId = "alertas-post-adjudicacion" }: PanelHeaderActionsProps) {
  const tieneAlertas = typeof alertsCount === "number" && alertsCount > 0;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled
        title="Chatear con tus datos: todavía no existe esta función en Atiende Licitaciones."
        className="h-8 gap-1.5 rounded-full text-[13px]"
      >
        <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" strokeWidth={1.75} />
        Chatea con tus datos
        <Badge variant="outline" className="ml-1 text-[9px] uppercase tracking-[0.06em] text-muted-foreground/70">
          Pronto
        </Badge>
      </Button>

      <button
        type="button"
        onClick={() => document.getElementById(alertsAnchorId)?.scrollIntoView({ behavior: "smooth", block: "start" })}
        aria-label={tieneAlertas ? `Ver alertas: ${alertsCount} activas` : "Sin alertas activas"}
        className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-muted"
      >
        <Bell className="h-4 w-4" aria-hidden="true" strokeWidth={1.75} />
        {tieneAlertas && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 font-mono text-[10px] font-medium leading-none text-destructive-foreground">
            {alertsCount > 99 ? "99+" : alertsCount}
          </span>
        )}
      </button>

      <span className="shrink-0 rounded-full border border-border px-3 py-1.5 font-mono text-xs text-muted-foreground">
        {formatTodayMx()}
      </span>
    </>
  );
}
