import { useState } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { describeApiError } from "@/hooks/useAuth";
import { useTwoFactorStatus, useVerifyStepUp } from "@/hooks/useTwoFactor";

export interface StepUpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Se llama con el `stepUpToken` recién verificado; el llamador decide qué acción real ejecutar con él. */
  onVerified: (stepUpToken: string) => void;
  title?: string;
  description?: string;
}

/**
 * REQ-044/064: apps/api exige un encabezado `X-Step-Up` vigente (emitido
 * por `POST /auth/2fa/step-up`, código TOTP o de respaldo reciente) antes
 * de aprobar una tarifa o un expediente. Este modal es el único punto de
 * la UI que pide ese código — reutilizado por TarifasAprobadasPage y
 * RevisionPage. Si el usuario no tiene 2FA enrolado, lo dirige a
 * Configuración en vez de pedir un código que la API rechazaría igual.
 */
export function StepUpDialog({ open, onOpenChange, onVerified, title, description }: StepUpDialogProps) {
  const { data: status, isLoading, isError, error: statusError, refetch } = useTwoFactorStatus();
  const verifyStepUp = useVerifyStepUp();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const result = await verifyStepUp.mutateAsync(code.trim());
      setCode("");
      onOpenChange(false);
      onVerified(result.stepUpToken);
    } catch (err) {
      setError(describeApiError(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
            {title ?? "Verificación en dos pasos"}
          </DialogTitle>
          <DialogDescription>
            {description ?? "Esta acción requiere confirmar tu identidad con un segundo factor antes de continuar."}
          </DialogDescription>
        </DialogHeader>

        {isLoading && <p className="text-sm text-muted-foreground">Comprobando tu 2FA…</p>}
        {isError && <ErrorState message={describeApiError(statusError)} onRetry={() => refetch()} />}

        {!isLoading && !isError && status && !status.enrolled && (
          <div className="space-y-3">
            <EmptyState
              icon={ShieldCheck}
              title="Aún no tienes 2FA enrolado"
              description="Debes enrolar la verificación en dos pasos en Configuración antes de poder aprobar."
            />
            <Link to="/configuracion" className="text-sm font-medium text-primary hover:underline" onClick={() => onOpenChange(false)}>
              Ir a Configuración a enrolar 2FA →
            </Link>
          </div>
        )}

        {!isLoading && !isError && status?.enrolled && (
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="step-up-code">Código TOTP o de respaldo</Label>
              <Input
                id="step-up-code"
                autoComplete="one-time-code"
                placeholder="123456 o XXXX-XXXX"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="submit" disabled={verifyStepUp.isPending || !code.trim()}>
                {verifyStepUp.isPending ? "Verificando…" : "Verificar y continuar"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
