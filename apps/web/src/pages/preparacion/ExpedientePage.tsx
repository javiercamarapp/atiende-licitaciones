import { useState } from "react";
import { Link } from "react-router-dom";
import { FolderKanban, FileSearch, FolderCheck, PenLine, ClipboardCheck, PackageCheck, Send, ArrowRight } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { TenderSelect } from "@/components/expediente/TenderSelect";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/useAuth";
import {
  useTenderDocuments,
  useRequirementMatrix,
  useProposal,
  useChecklist,
  useApprovalState,
  useLatestPackage,
  useSubmission,
} from "@/hooks/useExpediente";

interface OverviewCardProps {
  icon: typeof FileSearch;
  title: string;
  to: string;
  children: React.ReactNode;
}

function OverviewCard({ icon: Icon, title, to, children }: OverviewCardProps) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle level={3} className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {title}
        </CardTitle>
        <Link to={to} className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          Ir al módulo <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function ExpedienteOverview({ tenderId }: { tenderId: string }) {
  const { data: documents } = useTenderDocuments(tenderId);
  const { data: matrix } = useRequirementMatrix(tenderId);
  const { data: proposal } = useProposal(tenderId);
  const { data: checklist } = useChecklist(tenderId);
  const { data: approval } = useApprovalState(tenderId);
  const { data: pkg } = useLatestPackage(tenderId);
  const { data: submission } = useSubmission(tenderId);

  const activeRequirements = (matrix ?? []).filter((r) => !r.invalidatedAt);
  const blocked = activeRequirements.filter((r) => r.matrixStatus === "bloqueado").length;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <OverviewCard icon={FileSearch} title="Análisis de bases" to="/evaluacion/analisis-bases">
        <p className="text-sm text-muted-foreground">
          {documents?.length ?? 0} documento(s) · {activeRequirements.length} requisito(s) activo(s)
          {blocked > 0 ? ` · ${blocked} bloqueado(s)` : ""}
        </p>
      </OverviewCard>

      <OverviewCard icon={PenLine} title="Redacción" to="/preparacion/redaccion">
        {proposal ? (
          <p className="text-sm text-muted-foreground">
            {proposal.title} · versión {proposal.version} · estado {proposal.status}
            {proposal.invalidatedAt ? " · invalidada" : ""}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Aún no se ha generado ninguna propuesta.</p>
        )}
      </OverviewCard>

      <OverviewCard icon={FolderCheck} title="Cumplimiento documental" to="/preparacion/cumplimiento-documental">
        {checklist && checklist.items.length > 0 ? (
          <Badge variant={checklist.overallStatus === "verde" ? "success" : checklist.overallStatus === "ambar" ? "warning" : "destructive"}>
            Checklist: {checklist.overallStatus}
          </Badge>
        ) : (
          <p className="text-sm text-muted-foreground">Checklist aún no ejecutado.</p>
        )}
      </OverviewCard>

      <OverviewCard icon={ClipboardCheck} title="Revisión / aprobación" to="/preparacion/revision">
        {approval ? (
          <p className="text-sm text-muted-foreground">
            Estado: {approval.state} · {approval.fullyApproved ? "totalmente aprobado" : "pendiente de aprobación completa"}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Sin información de aprobación todavía.</p>
        )}
      </OverviewCard>

      <OverviewCard icon={PackageCheck} title="Paquete descargable" to="/entrega/paquete-descargable">
        {pkg ? (
          <Badge variant={pkg.status === "ready" ? "success" : "outline"}>{pkg.status === "ready" ? "Listo" : "Borrador"}</Badge>
        ) : (
          <p className="text-sm text-muted-foreground">Aún no se ha ensamblado ningún paquete.</p>
        )}
      </OverviewCard>

      <OverviewCard icon={Send} title="Entregas / presentación" to="/entrega/entregas">
        {submission ? (
          <p className="text-sm text-muted-foreground">Presentación declarada: {submission.status} ({submission.submittedAt ?? "sin fecha"})</p>
        ) : (
          <p className="text-sm text-muted-foreground">Aún no se ha declarado la presentación.</p>
        )}
      </OverviewCard>
    </div>
  );
}

export default function ExpedientePage() {
  const { currentOrgId } = useAuth();
  const [tenderId, setTenderId] = useState<string | null>(null);

  return (
    <div>
      <SectionHeader
        icon={FolderKanban}
        title="Expediente"
        description="Vista general del expediente de una convocatoria: bases, propuesta, cumplimiento, aprobación, paquete y presentación."
      />

      {!currentOrgId ? (
        <EmptyState icon={FolderKanban} title="Selecciona una organización" description="Elige una organización en el encabezado para ver el expediente de sus convocatorias." />
      ) : (
        <div className="space-y-6">
          <TenderSelect value={tenderId} onChange={setTenderId} />
          {tenderId ? (
            <ExpedienteOverview tenderId={tenderId} />
          ) : (
            <EmptyState icon={FolderKanban} title="Selecciona una convocatoria" description="Elige una convocatoria arriba para ver el estado de su expediente." />
          )}
        </div>
      )}
    </div>
  );
}
