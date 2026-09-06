import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import QRCode from "qrcode";
import { Settings, ShieldCheck, KeyRound } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { toast } from "@/components/ui/sonner";
import { describeApiError } from "@/hooks/useAuth";
import { useTwoFactorStatus, useEnrollTwoFactor, useVerifyTwoFactorEnrollment } from "@/hooks/useTwoFactor";
import { formatDateTimeMx } from "@/lib/datetime";
import type { EnrollTwoFactorResponse } from "@/lib/api/schemas";

const codeSchema = z.object({ code: z.string().min(6, "Ingresa el código de 6 dígitos de tu app de autenticación.") });
type CodeValues = z.infer<typeof codeSchema>;

/**
 * RF-03 (docs/auditoria-2/ronda5-final.md, BAJA): la copia de esta pantalla
 * decía "Escanea el código QR" pero nunca se renderizaba ningún QR real
 * (solo el secreto en texto) -- obligaba a copiar a mano un secreto de 32
 * caracteres en cada enrolamiento. `qrcode` (generación 100% en cliente, sin
 * red) dibuja el QR real del `otpauthUrl` en un `<canvas>`; el secreto y la
 * URL en texto plano (ya existían) se conservan como alternativa accesible
 * para quien no pueda escanear (lector de pantalla, cámara no disponible,
 * etc.) -- nunca se elimina la vía textual, solo se agrega la visual.
 */
function TotpQrCode({ otpauthUrl }: { otpauthUrl: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    const canvas = canvasRef.current;
    if (!canvas) {
      setFailed(true);
      return;
    }
    try {
      QRCode.toCanvas(canvas, otpauthUrl, { width: 176, margin: 1 }).catch(() => {
        if (!cancelled) setFailed(true);
      });
    } catch {
      // `qrcode` normalmente rechaza la promesa (ver el `.catch` de arriba),
      // pero algunos entornos (p. ej. un <canvas> sin `getContext` real)
      // pueden lanzar de forma síncrona en vez de rechazar -- sin este
      // try/catch, esa excepción escaparía del efecto y rompería el render.
      if (!cancelled) setFailed(true);
    }
    return () => {
      cancelled = true;
    };
  }, [otpauthUrl]);

  // Si la generación falla (entrada inválida, navegador sin <canvas> real),
  // no se rompe la página -- se ofrece un texto accesible en el lugar del
  // QR; el secreto/URL en texto (siempre presentes junto a este componente)
  // siguen siendo suficientes para completar el enrolamiento.
  if (failed) {
    return (
      <p
        role="status"
        className="max-w-[176px] rounded-lg border border-dashed border-border bg-muted/40 p-3 text-xs text-muted-foreground"
      >
        No se pudo generar el código QR en este dispositivo. Usa el secreto o el enlace de la derecha para
        completar el enrolamiento.
      </p>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="Código QR para enrolar la verificación en dos pasos en tu app de autenticación"
      className="rounded-lg border border-border bg-white p-2"
    />
  );
}

/**
 * REQ-044/064: enrolamiento de 2FA (TOTP) de la CUENTA -- válido para
 * aprobar tarifas o expedientes en cualquier organización de la que seas
 * miembro (ver StepUpDialog.tsx, usado por TarifasAprobadasPage y
 * RevisionPage). apps/api no ofrece re-enrolar sin desenrolar primero
 * (fuera de alcance de esta ronda; contactar a un administrador) — una vez
 * confirmado, esta pantalla ya no permite generar un secreto nuevo.
 */
function TwoFactorSection() {
  const { data: status, isLoading, isError, error, refetch } = useTwoFactorStatus();
  const enroll = useEnrollTwoFactor();
  const verify = useVerifyTwoFactorEnrollment();
  const [enrollment, setEnrollment] = useState<EnrollTwoFactorResponse | null>(null);
  const form = useForm<CodeValues>({ resolver: zodResolver(codeSchema), defaultValues: { code: "" } });

  const onEnroll = async () => {
    try {
      const result = await enroll.mutateAsync();
      setEnrollment(result);
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  const onConfirm = async (values: CodeValues) => {
    try {
      await verify.mutateAsync(values.code.trim());
      toast.success("2FA enrolado y verificado. Ya puedes aprobar tarifas y expedientes.");
      setEnrollment(null);
      form.reset();
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
          Verificación en dos pasos (2FA)
        </CardTitle>
        <CardDescription>
          Exigida antes de aprobar una tarifa o un expediente (REQ-044/064). Solo TOTP (apps como Google
          Authenticator/1Password) en esta ronda — passkey/WebAuthn queda pendiente.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <LoadingState label="Comprobando tu 2FA…" />}
        {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}

        {!isLoading && !isError && status?.enrolled && (
          <div className="flex items-center gap-2">
            <Badge variant="success">Enrolado</Badge>
            <span className="text-sm text-muted-foreground">Desde {formatDateTimeMx(status.enrolledAt)}.</span>
          </div>
        )}

        {!isLoading && !isError && status && !status.enrolled && !enrollment && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Aún no tienes 2FA enrolado.</p>
            <Button type="button" className="gap-1.5" disabled={enroll.isPending} onClick={onEnroll}>
              <KeyRound className="h-4 w-4" aria-hidden="true" />
              {enroll.isPending ? "Generando…" : "Enrolar 2FA"}
            </Button>
          </div>
        )}

        {enrollment && (
          <div className="space-y-4 rounded-xl border border-border p-4">
            <div>
              <p className="text-sm font-medium text-foreground">1. Agrega esta cuenta a tu app de autenticación</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Escanea el código QR con tu app, o captura el secreto manualmente:
              </p>
              <div className="mt-2 flex flex-wrap items-start gap-4">
                <TotpQrCode otpauthUrl={enrollment.otpauthUrl} />
                <div className="min-w-0 flex-1 space-y-1">
                  <p aria-label="Secreto TOTP" className="break-all rounded-lg bg-muted/40 p-2 font-mono text-xs">
                    {enrollment.secretBase32}
                  </p>
                  <p className="break-all text-xs text-muted-foreground">{enrollment.otpauthUrl}</p>
                </div>
              </div>
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">2. Códigos de respaldo (guárdalos ahora — no se muestran de nuevo)</p>
              <ul aria-label="Códigos de respaldo" className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs text-muted-foreground sm:grid-cols-5">
                {enrollment.backupCodes.map((code) => (
                  <li key={code} className="rounded bg-muted/40 px-2 py-1">
                    {code}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium text-foreground">3. Confirma con el código de tu app</p>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onConfirm)} className="flex flex-wrap items-end gap-3">
                  <FormField
                    control={form.control}
                    name="code"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Código de 6 dígitos</FormLabel>
                        <FormControl>
                          <Input autoComplete="one-time-code" placeholder="123456" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit" disabled={verify.isPending}>
                    {verify.isPending ? "Confirmando…" : "Confirmar enrolamiento"}
                  </Button>
                </form>
              </Form>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function ConfiguracionPage() {
  return (
    <div>
      <SectionHeader
        icon={Settings}
        title="Configuración"
        description="Seguridad de tu cuenta. Fuentes de convocatorias, reglas de matching, notificaciones e integraciones siguen sin conectar."
      />
      <div className="space-y-6">
        <TwoFactorSection />
      </div>
    </div>
  );
}
