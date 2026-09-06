import { useMemo, useState } from "react";
import { PenLine, Plus, Trash2, Sparkles, Save } from "lucide-react";

import { AiDisclosureNote } from "@/components/AiDisclosureNote";
import { SectionHeader } from "@/components/layout/SectionHeader";
import { TenderSelect } from "@/components/expediente/TenderSelect";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useCapabilities, useExperience, useDocuments, useSignatories, useRates } from "@/hooks/useCompany";
import {
  useRequirementMatrix,
  useProposal,
  useProposalSections,
  useUpdateProposalSection,
  useGenerateTechnicalProposal,
  useGenerateEconomicProposal,
} from "@/hooks/useExpediente";
import { WRITE_ROLES, REQUIREMENT_MAPPING_KINDS, type RequirementMappingKind } from "@/lib/api/schemas";
import { formatDateTimeMx } from "@/lib/datetime";

const KIND_LABELS: Record<RequirementMappingKind, string> = {
  capability: "Capacidad",
  experience: "Experiencia",
  document: "Documento de empresa",
  signer: "Firmante autorizado",
};

interface MappingRow {
  requirementId: string;
  kind: RequirementMappingKind;
  refKey: string;
}

interface EconomicRow {
  concept: string;
  quantity: string;
  requirementId: string;
}

interface TechnicalBlocker {
  requirementId?: string;
  detail?: string;
  reason?: string;
}

interface EconomicBlockedLineItem {
  concept?: string;
  detail?: string;
}

function TechnicalGenerationForm({ tenderId }: { tenderId: string }) {
  const { data: matrix } = useRequirementMatrix(tenderId);
  const { data: capabilities } = useCapabilities();
  const { data: experience } = useExperience();
  const { data: documents } = useDocuments();
  const { data: signatories } = useSignatories();
  const generate = useGenerateTechnicalProposal(tenderId);
  const [rows, setRows] = useState<MappingRow[]>([]);

  const activeRequirements = useMemo(() => (matrix ?? []).filter((r) => !r.invalidatedAt), [matrix]);
  const documentTypes = useMemo(() => [...new Set((documents ?? []).map((d) => d.documentType))], [documents]);
  const signerRoles = useMemo(() => [...new Set((signatories ?? []).map((s) => s.roleTitle).filter((r): r is string => Boolean(r)))], [signatories]);

  const refOptions = (kind: RequirementMappingKind): { value: string; label: string }[] => {
    switch (kind) {
      case "capability":
        return (capabilities ?? []).map((c) => ({ value: c.name, label: c.name }));
      case "experience":
        return (experience ?? []).map((e) => ({ value: e.id, label: e.title }));
      case "document":
        return documentTypes.map((t) => ({ value: t, label: t }));
      case "signer":
        return signerRoles.map((r) => ({ value: r, label: r }));
      default:
        return [];
    }
  };

  const onGenerate = async () => {
    const validRows = rows.filter((r) => r.requirementId && r.refKey);
    try {
      const proposal = await generate.mutateAsync({ mappings: validRows.map((r) => ({ requirementId: r.requirementId, kind: r.kind, refKey: r.refKey })) });
      const blockers = ((proposal.generationReport as { technical?: { blockers?: TechnicalBlocker[] } } | null)?.technical?.blockers ?? []).length;
      toast.success(blockers > 0 ? `Propuesta técnica generada con ${blockers} bloqueo(s) — revisa las secciones "PENDIENTE".` : "Propuesta técnica generada sin bloqueos.");
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  if (activeRequirements.length === 0) {
    return (
      <EmptyState
        icon={PenLine}
        title="Sin requisitos activos"
        description="Extrae primero la matriz de requisitos en Análisis de bases para poder mapear cada requisito a un dato real de la empresa."
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Generar propuesta técnica</CardTitle>
        <CardDescription>
          Mapea cada requisito a un dato real y aprobado de la empresa. Un requisito sin mapeo o sin evidencia
          mapeable queda "PENDIENTE" en su sección — nunca se inventa un valor.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.map((row, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2 rounded-xl border border-border p-3">
            <div className="flex min-w-[220px] flex-1 flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Requisito</span>
              <Select
                value={row.requirementId}
                onValueChange={(value) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, requirementId: value } : r)))}
              >
                <SelectTrigger aria-label="Requisito">
                  <SelectValue placeholder="Selecciona un requisito" />
                </SelectTrigger>
                <SelectContent>
                  {activeRequirements.map((req) => (
                    <SelectItem key={req.id} value={req.id}>
                      {req.description.slice(0, 80)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Fuente</span>
              <Select
                value={row.kind}
                onValueChange={(value) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, kind: value as RequirementMappingKind, refKey: "" } : r)))}
              >
                <SelectTrigger aria-label="Tipo de fuente" className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REQUIREMENT_MAPPING_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {KIND_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-w-[200px] flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Dato de empresa</span>
              <Select value={row.refKey} onValueChange={(value) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, refKey: value } : r)))}>
                <SelectTrigger aria-label="Dato de empresa">
                  <SelectValue placeholder="Selecciona" />
                </SelectTrigger>
                <SelectContent>
                  {refOptions(row.kind).map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="button" variant="ghost" size="icon" aria-label="Quitar mapeo" onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}>
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setRows((prev) => [...prev, { requirementId: "", kind: "capability", refKey: "" }])}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Agregar mapeo
        </Button>
        <div>
          <Button type="button" className="gap-1.5" disabled={generate.isPending} onClick={onGenerate}>
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            {generate.isPending ? "Generando…" : "Generar propuesta técnica"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EconomicGenerationForm({ tenderId }: { tenderId: string }) {
  const { data: rates } = useRates();
  const { data: matrix } = useRequirementMatrix(tenderId);
  const generate = useGenerateEconomicProposal(tenderId);
  const [rows, setRows] = useState<EconomicRow[]>([{ concept: "", quantity: "1", requirementId: "" }]);
  const activeRequirements = useMemo(() => (matrix ?? []).filter((r) => !r.invalidatedAt), [matrix]);

  const onGenerate = async () => {
    const validRows = rows.filter((r) => r.concept && Number(r.quantity) > 0);
    if (validRows.length === 0) {
      toast.error("Agrega al menos un concepto con cantidad mayor a cero.");
      return;
    }
    try {
      const proposal = await generate.mutateAsync(
        validRows.map((r) => ({ concept: r.concept, quantity: Number(r.quantity), requirementId: r.requirementId || undefined })),
      );
      const blocked = ((proposal.generationReport as { economic?: { blockedLineItems?: EconomicBlockedLineItem[] } } | null)?.economic?.blockedLineItems ?? []).length;
      toast.success(
        blocked > 0
          ? `Propuesta económica generada con ${blocked} concepto(s) bloqueado(s) (precio no aprobado/vencido) — sin total parcial.`
          : "Propuesta económica generada.",
      );
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Generar propuesta económica</CardTitle>
        <CardDescription>Solo se calcula con tarifas aprobadas y vigentes a la fecha del acto — una tarifa no aprobada o vencida bloquea ese concepto completo, nunca un total parcial.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.map((row, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2 rounded-xl border border-border p-3">
            <div className="flex min-w-[220px] flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Concepto (tarifa)</span>
              <Select value={row.concept} onValueChange={(value) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, concept: value } : r)))}>
                <SelectTrigger aria-label="Concepto">
                  <SelectValue placeholder="Selecciona una tarifa" />
                </SelectTrigger>
                <SelectContent>
                  {(rates ?? []).map((rate) => (
                    <SelectItem key={rate.id} value={rate.itemCode}>
                      {rate.itemCode} — {rate.description} ({rate.status === "approved" ? "aprobada" : rate.status === "draft" ? "borrador" : "archivada"})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={`economic-quantity-${i}`} className="text-xs font-medium text-muted-foreground">
                Cantidad
              </label>
              <Input
                id={`economic-quantity-${i}`}
                type="number"
                min={0}
                step="any"
                className="w-28"
                value={row.quantity}
                onChange={(e) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, quantity: e.target.value } : r)))}
              />
            </div>
            <div className="flex min-w-[200px] flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Requisito relacionado (opcional)</span>
              <Select
                value={row.requirementId || undefined}
                onValueChange={(value) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, requirementId: value } : r)))}
              >
                <SelectTrigger aria-label="Requisito relacionado">
                  <SelectValue placeholder="Ninguno" />
                </SelectTrigger>
                <SelectContent>
                  {activeRequirements.map((req) => (
                    <SelectItem key={req.id} value={req.id}>
                      {req.description.slice(0, 60)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Quitar concepto"
              onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setRows((prev) => [...prev, { concept: "", quantity: "1", requirementId: "" }])}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Agregar concepto
        </Button>
        <div>
          <Button type="button" className="gap-1.5" disabled={generate.isPending} onClick={onGenerate}>
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            {generate.isPending ? "Generando…" : "Generar propuesta económica"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SectionEditor({ tenderId, canWrite }: { tenderId: string; canWrite: boolean }) {
  const { data: sections, isLoading, isError, error, refetch } = useProposalSections(tenderId);
  const update = useUpdateProposalSection(tenderId);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  if (isLoading) return <LoadingState label="Cargando secciones…" />;
  if (isError) return <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />;
  if (!sections || sections.length === 0) {
    return <EmptyState icon={PenLine} title="Aún no hay secciones" description="Genera la propuesta técnica y/o económica para ver aquí sus secciones." />;
  }

  return (
    <ul className="space-y-4">
      {sections.map((section) => {
        const isBlocked = section.content.startsWith("PENDIENTE");
        const sources = Array.isArray(section.sources) ? (section.sources as unknown[]) : [];
        const draft = drafts[section.sectionKey] ?? section.content;
        return (
          <li key={section.id}>
            <Card className={isBlocked ? "border-warning/40 bg-warning/5" : ""}>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle level={3} className="text-base">
                    {section.title}
                  </CardTitle>
                  <CardDescription>
                    Versión {section.version} · actualizado {formatDateTimeMx(section.updatedAt)} · {sources.length} fuente(s) trazada(s)
                  </CardDescription>
                </div>
                {isBlocked && <Badge variant="warning">Bloqueado / pendiente</Badge>}
              </CardHeader>
              <CardContent className="space-y-3">
                {canWrite ? (
                  <Textarea
                    rows={4}
                    aria-label={`Contenido de la sección ${section.title}`}
                    value={draft}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [section.sectionKey]: e.target.value }))}
                  />
                ) : (
                  <p className="whitespace-pre-wrap text-sm text-foreground">{section.content}</p>
                )}
                {sources.length > 0 && (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer font-medium">Ver fuentes (source_ref)</summary>
                    <pre className="mt-1 overflow-x-auto rounded-lg bg-muted/40 p-2">{JSON.stringify(sources, null, 2)}</pre>
                  </details>
                )}
                {canWrite && (
                  <Button
                    type="button"
                    size="sm"
                    className="gap-1.5"
                    disabled={update.isPending || draft === section.content}
                    onClick={() => {
                      update.mutate(
                        { sectionKey: section.sectionKey, content: draft },
                        {
                          onSuccess: () => toast.success("Sección actualizada — nueva versión creada. Cualquier aprobación vigente de esta sección queda invalidada."),
                          onError: (err) => toast.error(describeApiError(err)),
                        },
                      );
                    }}
                  >
                    <Save className="h-4 w-4" aria-hidden="true" />
                    Guardar nueva versión
                  </Button>
                )}
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

export default function RedaccionPage() {
  const { currentOrgId, currentMembership } = useAuth();
  const [tenderId, setTenderId] = useState<string | null>(null);
  const canWrite = Boolean(currentMembership && WRITE_ROLES.includes(currentMembership.role));
  const { data: proposal } = useProposal(tenderId);

  return (
    <div>
      <SectionHeader icon={PenLine} title="Redacción" description="Propuesta técnica y económica generadas desde datos aprobados de la empresa, con fuente trazable por sección." />
      <AiDisclosureNote />

      {!currentOrgId ? (
        <EmptyState icon={PenLine} title="Selecciona una organización" description="Elige una organización en el encabezado para redactar su propuesta." />
      ) : (
        <div className="space-y-6">
          <TenderSelect value={tenderId} onChange={setTenderId} />

          {tenderId && (
            <>
              {proposal && (
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span>
                    Expediente: {proposal.title} · versión {proposal.version} · estado {proposal.status}
                  </span>
                  {proposal.invalidatedAt && <Badge variant="warning">Invalidado: {proposal.invalidatedReason}</Badge>}
                </div>
              )}
              {canWrite && <TechnicalGenerationForm tenderId={tenderId} />}
              {canWrite && <EconomicGenerationForm tenderId={tenderId} />}
              <SectionEditor tenderId={tenderId} canWrite={canWrite} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
