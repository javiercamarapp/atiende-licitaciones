import { Link } from "react-router-dom";
import { CheckCircle2, Circle, ListChecks } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ChecklistItem } from "@/hooks/useActivationChecklist";

export interface ChecklistCardProps {
  items: ChecklistItem[];
  completedCount: number;
  totalCount: number;
  isLoading?: boolean;
}

/** Checklist de activación (ronda 7): cada casilla refleja un hecho real leído de la API, ver hooks/useActivationChecklist.ts. */
export function ChecklistCard({ items, completedCount, totalCount, isLoading }: ChecklistCardProps) {
  const allDone = totalCount > 0 && completedCount === totalCount;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ListChecks className="h-5 w-5 text-primary" aria-hidden="true" strokeWidth={1.75} />
          <CardTitle level={2} className="text-base">
            Checklist de activación
          </CardTitle>
        </div>
        <CardDescription>
          {allDone ? "Completaste todos los pasos recomendados." : `${completedCount} de ${totalCount} pasos completados.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full rounded-xl" />
            ))}
          </div>
        ) : (
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  to={item.href}
                  className="flex items-center gap-2.5 rounded-xl px-2 py-2 text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {item.done ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  ) : (
                    <Circle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                  <span className={item.done ? "text-muted-foreground line-through" : "text-foreground"}>{item.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
