import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ClipboardCheck, MessageSquare, Send, CheckCircle2, XCircle, ShieldAlert } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { TenderSelect } from "@/components/expediente/TenderSelect";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/sonner";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useApprovalState, useRequestApprovalReview, useApproveExpediente, useAddApprovalComment } from "@/hooks/useExpediente";
import { WRITE_ROLES, APPROVER_ROLES, MEMBERSHIP_ADMIN_ROLES } from "@/lib/api/schemas";
import { formatDateTimeMx } from "@/lib/datetime";

const STATE_LABELS: Record<string, { label: string; variant: "outline" | "warning" | "success" }> = {
  borrador: { label: "Borrador", variant: "outline" },
  en_revision: { label: "En revisión", variant: "warning" },
  aprobado: { label: "Aprobado", variant: "success" },
};

const REQUEST_REVIEW_ROLES = ["writer", ...MEMBERSHIP_ADMIN_ROLES];

export default function RevisionPage() {
  const { currentOrgId, currentMembership, user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tenderId, setTenderIdState] = useState<string | null>(searchParams.get("tenderId"));
  const [commentText, setCommentText] = useState("");

  const setTenderId = (id: string) => {
    setTenderIdState(id);
    setSearchParams({ tenderId: id });
  };

  const { data: approval, isLoading, isError, error, refetch } = useApprovalState(tenderId);
  const requestReview = useRequestApprovalReview(tenderId);
  const approve = useApproveExpediente(tenderId);
  const addComment = useAddApprovalComment(tenderId);

  const role = currentMembership?.role;
  const canRequestReview = Boolean(role && REQUEST_REVIEW_ROLES.includes(role));
  const canApprove = Boolean(role && APPROVER_ROLES.includes(role));
  const canComment = Boolean(role && WRITE_ROLES.includes(role));

  const onRequestReview = async () => {
    try {
      await requestReview.mutateAsync(undefined);
      toast.success("Revisión solicitada — el expediente pasa a \"en revisión\".");
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  const onApprove = async () => {
    try {
      await approve.mutateAsync();
      toast.success("Expediente aprobado.");
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  const submitComment = async (prefix?: string) => {
    if (!commentText.trim()) {
      toast.error("Escribe un comentario antes de enviarlo.");
      return;
    }
    try {
      await addComment.mutateAsync(prefix ? `${prefix} ${commentText.trim()}` : commentText.trim());
      setCommentText("");
      toast.success(prefix ? "Rechazo registrado como comentario — el expediente permanece en revisión." : "Comentario agregado.");
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <div>
      <SectionHeader
        icon={ClipboardCheck}
        title="Revisión"
        description="Solicitar revisión, comentar y aprobar/rechazar el expediente según rol — el autor de una sección nunca puede aprobarla."
      />

      {!currentOrgId ? (
        <EmptyState icon={ClipboardCheck} title="Selecciona una organización" description="Elige una organización en el encabezado para revisar su expediente." />
      ) : (
        <div className="space-y-6">
          <TenderSelect value={tenderId} onChange={setTenderId} />

          {tenderId && (
            <>
              {isLoading && <LoadingState label="Cargando estado de aprobación…" />}
              {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
              {!isLoading && !isError && approval && (
                <>
                  <Card>
                    <CardHeader className="flex-row items-center justify-between space-y-0">
                      <div>
                        <CardTitle className="text-base">Estado del expediente</CardTitle>
                        <CardDescription>Hash de insumos actual: {approval.currentInputsHash.slice(0, 16)}…</CardDescription>
                      </div>
                      <Badge variant={STATE_LABELS[approval.state]?.variant ?? "outline"}>{STATE_LABELS[approval.state]?.label ?? approval.state}</Badge>
                    </CardHeader>
                    <CardContent className="flex flex-wrap gap-2">
                      {canRequestReview && approval.state === "borrador" && (
                        <Button type="button" variant="outline" className="gap-1.5" disabled={requestReview.isPending} onClick={onRequestReview}>
                          <Send className="h-4 w-4" aria-hidden="true" />
                          {requestReview.isPending ? "Enviando…" : "Solicitar revisión"}
                        </Button>
                      )}
                      {canApprove && (
                        <Button type="button" className="gap-1.5" disabled={approve.isPending || approval.fullyApproved} onClick={onApprove}>
                          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                          {approve.isPending ? "Aprobando…" : approval.fullyApproved ? "Ya aprobado" : "Aprobar expediente"}
                        </Button>
                      )}
                      {!canApprove && (
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                          Tu rol ({role ?? "sin rol"}) no puede aprobar — se requiere reviewer/admin/owner, y nunca la
                          misma cuenta que redactó/solicitó la revisión (la API lo exige igual).
                        </p>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle level={2} className="text-base">
                        Aprobaciones registradas
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {approval.approvals.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Sin aprobaciones registradas todavía.</p>
                      ) : (
                        <ul className="space-y-2">
                          {approval.approvals.map((a, i) => (
                            <li key={i} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3 text-sm">
                              <span>
                                Alcance <span className="font-medium">{a.scopeRef}</span> · aprobado por rol {a.approvedByRole} el {formatDateTimeMx(a.approvedAt)}
                              </span>
                              <Badge variant={a.status === "vigente" ? "success" : "outline"}>
                                {a.status === "vigente" ? "Vigente" : "Invalidada tras un cambio"}
                              </Badge>
                            </li>
                          ))}
                        </ul>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle level={2} className="text-base">
                        Comentarios
                      </CardTitle>
                      <CardDescription>
                        La API no modela un estado de "rechazado" separado (solo borrador/en_revisión/aprobado): un
                        rechazo se registra aquí como comentario explícito y el expediente permanece "en revisión"
                        hasta una nueva aprobación — gap de dominio documentado, no simulado.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {approval.comments.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Sin comentarios todavía.</p>
                      ) : (
                        <ul className="space-y-2">
                          {approval.comments.map((c, i) => (
                            <li key={i} className="rounded-xl border border-border p-3 text-sm">
                              <p className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                                <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                                {c.authorRole} · {formatDateTimeMx(c.createdAt)} · alcance {c.scopeRef}
                              </p>
                              <p className={c.text.startsWith("RECHAZADO:") ? "font-medium text-destructive" : "text-foreground"}>{c.text}</p>
                            </li>
                          ))}
                        </ul>
                      )}
                      {canComment && (
                        <div className="space-y-2">
                          <Textarea
                            aria-label="Nuevo comentario"
                            rows={3}
                            placeholder="Escribe un comentario…"
                            value={commentText}
                            onChange={(e) => setCommentText(e.target.value)}
                          />
                          <div className="flex flex-wrap gap-2">
                            <Button type="button" variant="outline" className="gap-1.5" disabled={addComment.isPending} onClick={() => submitComment()}>
                              <MessageSquare className="h-4 w-4" aria-hidden="true" />
                              Comentar
                            </Button>
                            {canApprove && (
                              <Button
                                type="button"
                                variant="destructive"
                                className="gap-1.5"
                                disabled={addComment.isPending}
                                onClick={() => submitComment("RECHAZADO:")}
                              >
                                <XCircle className="h-4 w-4" aria-hidden="true" />
                                Rechazar (comentario)
                              </Button>
                            )}
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                  {user && <p className="text-xs text-muted-foreground">Sesión actual: {user.email} — la API rechaza aprobar contenido que tú mismo redactaste o cuya revisión tú mismo solicitaste.</p>}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
