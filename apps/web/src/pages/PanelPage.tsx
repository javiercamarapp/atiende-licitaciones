import { Link } from "react-router-dom";
import {
  BarChart3,
  Radar,
  Target,
  FolderKanban,
  ShieldCheck,
  Timer,
  CreditCard,
  Building2,
} from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { ChecklistCard } from "@/components/dashboard/ChecklistCard";
import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
import { AlertsList } from "@/components/dashboard/AlertsList";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { usePostAwardAlerts } from "@/hooks/useExpediente";
import { useDashboard, useRecentActivity } from "@/hooks/useDashboard";
import { useActivationChecklist } from "@/hooks/useActivationChecklist";

const QUICK_LINKS = [
  { to: "/convocatorias/descubrimiento", label: "Descubrimiento", icon: Radar },
  { to: "/convocatorias/matching", label: "Matching", icon: Target },
  { to: "/preparacion/expediente", label: "Expediente", icon: FolderKanban },
  { to: "/preparacion/aprobaciones", label: "Aprobaciones", icon: ShieldCheck },
  { to: "/entrega/seguimiento", label: "Seguimiento post-adjudicación", icon: Timer },
];

/**
 * Panel/Dashboard real (ronda 7, REQ-169): KPIs, actividad y alertas desde
 * endpoints ya existentes de apps/api (ver hooks/useDashboard.ts) -- antes
 * era un `createModulePage` con un EmptyState fijo (ver git blame de este
 * archivo). Skeletons por widget (no un solo spinner de página completa) y
 * cada error se muestra con su mensaje real (incluye `request_id` cuando la
 * API lo trae, ver describeApiError en useAuth.tsx).
 */
export default function PanelPage() {
  const { currentOrgId, currentMembership } = useAuth();
  const dashboard = useDashboard();
  const activity = useRecentActivity();
  const alerts = usePostAwardAlerts();
  const checklist = useActivationChecklist();

  if (!currentOrgId) {
    return (
      <div>
        <SectionHeader icon={BarChart3} title="Panel" description="Resumen del estado de tus licitaciones activas." />
        <EmptyState icon={Building2} title="Selecciona una organización" description="Elige una organización en el encabezado para ver su panel." />
      </div>
    );
  }

  return (
    <div>
      <SectionHeader
        icon={BarChart3}
        title="Panel"
        description={`Resumen en tiempo real de ${currentMembership?.name ?? "tu organización"}.`}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          icon={Radar}
          label="Convocatorias nuevas (7 días)"
          value={dashboard.newTenders7d}
          hint={dashboard.tendersTruncated ? "De las últimas 100 convocatorias cargadas" : undefined}
          isLoading={dashboard.isLoading}
        />
        <KpiCard icon={Radar} label="Convocatorias nuevas (30 días)" value={dashboard.newTenders30d} isLoading={dashboard.isLoading} />
        <KpiCard
          icon={Target}
          label="Matches elegibles"
          value={`${dashboard.matchesEligible} / ${dashboard.matchesTotal}`}
          hint="Elegibilidad calculada contra tu perfil"
          isLoading={dashboard.isLoading}
        />
        <KpiCard
          icon={ShieldCheck}
          label="Tarifas por aprobar"
          value={dashboard.pendingRateApprovals}
          tone={dashboard.pendingRateApprovals > 0 ? "warning" : "default"}
          isLoading={dashboard.isLoading}
        />
        <KpiCard
          icon={Timer}
          label="Vencimientos próximos"
          value={dashboard.upcomingDeadlines}
          tone={dashboard.upcomingDeadlines > 0 ? "warning" : "default"}
          isLoading={dashboard.isLoading}
        />
        <KpiCard
          icon={Timer}
          label="Vencimientos ya vencidos"
          value={dashboard.overdueDeadlines}
          tone={dashboard.overdueDeadlines > 0 ? "destructive" : "default"}
          isLoading={dashboard.isLoading}
        />
        <KpiCard icon={CreditCard} label="Plazos de pago en curso" value={dashboard.paymentFollowupsInProgress} isLoading={dashboard.isLoading} />
        <KpiCard
          icon={FolderKanban}
          label="Expedientes en preparación"
          value={dashboard.tendersByStatus.in_progress ?? 0}
          hint="Convocatorias en estado 'en preparación'"
          isLoading={dashboard.isLoading}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <AlertsList
            items={alerts.data ?? []}
            isLoading={alerts.isLoading}
            errorMessage={alerts.isError ? describeApiError(alerts.error) : null}
            onRetry={() => alerts.refetch()}
          />
          <ActivityFeed
            items={activity.items}
            isLoading={activity.isLoading}
            errorMessage={activity.isError ? describeApiError(activity.error) : null}
            onRetry={() => activity.refetch()}
          />
        </div>
        <div className="space-y-4">
          <ChecklistCard items={checklist.items} completedCount={checklist.completedCount} totalCount={checklist.totalCount} isLoading={checklist.isLoading} />
          <nav aria-label="Accesos rápidos" className="rounded-2xl border border-border bg-card p-4 shadow-card">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Accesos rápidos</p>
            <ul className="space-y-1">
              {QUICK_LINKS.map((link) => (
                <li key={link.to}>
                  <Link
                    to={link.to}
                    className="flex items-center gap-2.5 rounded-xl px-2 py-2 text-sm text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <link.icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" strokeWidth={1.75} />
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>
    </div>
  );
}
