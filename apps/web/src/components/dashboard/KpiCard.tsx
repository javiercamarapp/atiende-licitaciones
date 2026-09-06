import type { LucideIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface KpiCardProps {
  icon: LucideIcon;
  label: string;
  value: number | string;
  hint?: string;
  isLoading?: boolean;
  tone?: "default" | "warning" | "destructive" | "success";
}

const TONE_CLASSES: Record<NonNullable<KpiCardProps["tone"]>, string> = {
  default: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning-foreground",
  destructive: "bg-destructive/10 text-destructive",
};

/** Tarjeta de KPI reutilizada entre el Panel real (useDashboard) y la demo (datos de ejemplo vía MSW). */
export function KpiCard({ icon: Icon, label, value, hint, isLoading, tone = "default" }: KpiCardProps) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4">
        <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", TONE_CLASSES[tone])}>
          <Icon className="h-5 w-5" aria-hidden="true" strokeWidth={1.75} />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          {isLoading ? (
            <Skeleton className="mt-1.5 h-7 w-14" />
          ) : (
            <p className="font-display text-2xl font-semibold text-foreground">{value}</p>
          )}
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
