// Panel/Dashboard real (ronda 7, REQ-169): agrega KPIs de la organización
// activa a partir de endpoints YA existentes de apps/api -- ningún dato
// simulado. Cada cifra documenta de qué endpoint sale y qué limitación
// honesta tiene (p. ej. sin endpoint de conteo total, algunas cifras son
// "de los últimos N cargados").
import { useMemo } from "react";

import { useAuth } from "@/hooks/useAuth";
import { useTenders } from "@/hooks/useTenders";
import { useTenderMatches } from "@/hooks/useMatching";
import { useRates } from "@/hooks/useCompany";
import { usePostAwardAlerts } from "@/hooks/useExpediente";
import { useAuditLog } from "@/hooks/useAuditLog";
import type { Tender, TenderStatus } from "@/lib/api/schemas";

const DASHBOARD_TENDER_LIMIT = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): number {
  return Date.now() - days * MS_PER_DAY;
}

function countNewerThan(tenders: Tender[], sinceMs: number): number {
  return tenders.filter((t) => new Date(t.createdAt).getTime() >= sinceMs).length;
}

export interface DashboardData {
  /** `undefined` mientras carga o si nextCursor indica que hay más allá del límite consultado. */
  newTenders7d: number;
  newTenders30d: number;
  /** `true` si la lista de convocatorias está truncada (más allá de DASHBOARD_TENDER_LIMIT) -- los conteos de arriba son un piso, no el total exacto. */
  tendersTruncated: boolean;
  tendersByStatus: Partial<Record<TenderStatus, number>>;
  matchesTotal: number;
  matchesEligible: number;
  pendingRateApprovals: number;
  upcomingDeadlines: number;
  overdueDeadlines: number;
  paymentFollowupsInProgress: number;
  isLoading: boolean;
  isError: boolean;
  errors: unknown[];
}

export function useDashboard(): DashboardData {
  const { currentOrgId } = useAuth();
  const tenders = useTenders({ limit: DASHBOARD_TENDER_LIMIT });
  const matches = useTenderMatches();
  const rates = useRates();
  const alerts = usePostAwardAlerts();

  return useMemo(() => {
    const tenderItems = tenders.data?.items ?? [];
    const tendersByStatus: Partial<Record<TenderStatus, number>> = {};
    for (const t of tenderItems) tendersByStatus[t.status] = (tendersByStatus[t.status] ?? 0) + 1;

    const matchItems = matches.data ?? [];
    const alertItems = alerts.data ?? [];

    const queries = [tenders, matches, rates, alerts];
    return {
      newTenders7d: countNewerThan(tenderItems, daysAgo(7)),
      newTenders30d: countNewerThan(tenderItems, daysAgo(30)),
      tendersTruncated: Boolean(tenders.data?.nextCursor),
      tendersByStatus,
      matchesTotal: matchItems.length,
      matchesEligible: matchItems.filter((m) => m.eligibility.status === "cumple").length,
      pendingRateApprovals: (rates.data ?? []).filter((r) => r.status === "draft").length,
      upcomingDeadlines: alertItems.filter((a) => a.alertLevel === "proximo").length,
      overdueDeadlines: alertItems.filter((a) => a.alertLevel === "vencido").length,
      paymentFollowupsInProgress: alertItems.filter((a) => a.kind === "pago").length,
      isLoading: Boolean(currentOrgId) && queries.some((q) => q.isLoading),
      isError: queries.some((q) => q.isError),
      errors: queries.filter((q) => q.isError).map((q) => q.error),
    } satisfies DashboardData;
  }, [currentOrgId, tenders, matches, rates, alerts]);
}

/** Actividad reciente (audit-log de la organización activa, ronda 4 de apps/api). */
export function useRecentActivity(limit = 8) {
  const auditLog = useAuditLog();
  return {
    items: (auditLog.data?.items ?? []).slice(0, limit),
    isLoading: auditLog.isLoading,
    isError: auditLog.isError,
    error: auditLog.error,
    refetch: auditLog.refetch,
  };
}
