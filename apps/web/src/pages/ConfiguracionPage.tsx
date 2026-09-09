import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import QRCode from "qrcode";
import { Settings, ShieldCheck, ShieldOff, KeyRound, RefreshCw, BellRing, Lock, Link2Off, Monitor, LogOut } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { toast } from "@/components/ui/sonner";
import { StepUpDialog } from "@/components/StepUpDialog";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import {
  useTwoFactorStatus,
  useEnrollTwoFactor,
  useVerifyTwoFactorEnrollment,
  useDisableTwoFactor,
  useRegenerateBackupCodes,
} from "@/hooks/useTwoFactor";
import { useAuthSessions, useRevokeAuthSession, useRevokeOtherAuthSessions, useChangePassword, useUnlinkGoogle } from "@/hooks/useAccountSecurity";
import { useNotificationPreferences, useUpdateNotificationPreferences } from "@/hooks/useNotificationPreferences";
import type { NotificationPreferences } from "@/lib/api/mail";
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
 * RevisionPage). apps/api no ofrece re-enrolar sin desactivar primero --
 * una vez confirmado, esta pantalla ya no permite generar un secreto
 * nuevo, solo desactivarlo (E21) o regenerar los códigos de respaldo (E21).
 *
 * Desactivar/regenerar comparten UN solo StepUpDialog (`stepUpAction`
 * decide el `purpose` y qué mutación corre `onVerified`) -- mismo patrón
 * que `TarifasAprobadasPage` (un diálogo, varias acciones posibles).
 */
function TwoFactorSection() {
  const { data: status, isLoading, isError, error, refetch } = useTwoFactorStatus();
  const enroll = useEnrollTwoFactor();
  const verify = useVerifyTwoFactorEnrollment();
  const disable = useDisableTwoFactor();
  const regenerate = useRegenerateBackupCodes();
  const [enrollment, setEnrollment] = useState<EnrollTwoFactorResponse | null>(null);
  const [regeneratedCodes, setRegeneratedCodes] = useState<string[] | null>(null);
  const [stepUpAction, setStepUpAction] = useState<"disable" | "regenerate" | null>(null);
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

  const onStepUpVerified = (stepUpToken: string) => {
    if (stepUpAction === "disable") {
      disable.mutate(stepUpToken, {
        onSuccess: () => toast.success("2FA desactivado."),
        onError: (err) => toast.error(describeApiError(err)),
      });
    } else if (stepUpAction === "regenerate") {
      regenerate.mutate(stepUpToken, {
        onSuccess: (result) => setRegeneratedCodes(result.backupCodes),
        onError: (err) => toast.error(describeApiError(err)),
      });
    }
    setStepUpAction(null);
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
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge variant="success">Enrolado</Badge>
              <span className="text-sm text-muted-foreground">Desde {formatDateTimeMx(status.enrolledAt)}.</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Tu app de autenticación es ahora el segundo factor: al aprobar una tarifa o un expediente se te pedirá un código de 6 dígitos
              (o uno de tus códigos de respaldo, de un solo uso).
            </p>

            {regeneratedCodes ? (
              <div className="space-y-2 rounded-xl border border-border p-4">
                <p className="text-sm font-medium text-foreground">Nuevos códigos de respaldo (guárdalos ahora — no se muestran de nuevo)</p>
                <p className="text-xs text-muted-foreground">Los códigos anteriores ya NO sirven.</p>
                <ul aria-label="Nuevos códigos de respaldo" className="grid grid-cols-2 gap-1 font-mono text-xs text-muted-foreground sm:grid-cols-5">
                  {regeneratedCodes.map((code) => (
                    <li key={code} className="rounded bg-muted/40 px-2 py-1">
                      {code}
                    </li>
                  ))}
                </ul>
                <Button type="button" size="sm" variant="secondary" onClick={() => setRegeneratedCodes(null)}>
                  Ya los guardé
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="gap-1.5"
                  disabled={regenerate.isPending}
                  onClick={() => setStepUpAction("regenerate")}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  Regenerar códigos de respaldo
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="gap-1.5"
                  disabled={disable.isPending}
                  onClick={() => setStepUpAction("disable")}
                >
                  <ShieldOff className="h-4 w-4" aria-hidden="true" />
                  Desactivar 2FA
                </Button>
              </div>
            )}
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

      <StepUpDialog
        open={stepUpAction !== null}
        onOpenChange={(open) => {
          if (!open) setStepUpAction(null);
        }}
        purpose={stepUpAction === "disable" ? "twofa.disable" : "twofa.backup_codes_regenerate"}
        title={stepUpAction === "disable" ? "Desactivar verificación en dos pasos" : "Regenerar códigos de respaldo"}
        description={
          stepUpAction === "disable"
            ? "Confirma con tu app de autenticación antes de desactivar 2FA. Se rechaza si tu cuenta quedaría sin contraseña ni Google vinculado."
            : "Confirma con tu app de autenticación antes de invalidar tus códigos de respaldo actuales y emitir diez nuevos."
        }
        onVerified={onStepUpVerified}
      />
    </Card>
  );
}


/**
 * Las 8 categorías APAGABLES, en el mismo orden y con las mismas claves
 * (camelCase) que devuelve `GET /mail/preferences` — que son
 * `OPTIONAL_CATEGORIES` de apps/api traducidas por `COLUMN_TO_KEY`. La
 * lista es cerrada: una categoría que la API no conozca no se puede
 * inventar aquí (el `PUT` la rechazaría con 422).
 */
const CATEGORIAS_NOTIFICACION: { key: keyof NotificationPreferences; label: string; description: string }[] = [
  { key: "tenderMatches", label: "Convocatorias que coinciden con tu perfil", description: "Cuando el matching encuentra una convocatoria relevante para tu empresa." },
  { key: "tenderChanges", label: "Cambios en convocatorias que sigues", description: "Modificaciones de bases, prórrogas y aclaraciones." },
  { key: "approvals", label: "Aprobaciones pendientes", description: "Cuando alguien de tu organización necesita tu aprobación." },
  { key: "submission", label: "Presentación y entrega", description: "Paquete listo para descargar y recordatorios de presentación." },
  { key: "deadlines", label: "Plazos próximos a vencer", description: "Fechas límite de convocatorias en las que participas." },
  { key: "documentExpiration", label: "Vencimiento de documentos", description: "Documentos de la empresa que están por caducar." },
  { key: "postAward", label: "Seguimiento post-adjudicación", description: "Plazos de contrato, entregas y pagos tras una adjudicación." },
  { key: "weeklySummary", label: "Resumen semanal", description: "Un correo con lo que pasó en tus convocatorias esta semana." },
];

/**
 * REQ-187 (ronda 8b): centro de preferencias de notificación
 * (`GET`/`PUT /mail/preferences`).
 *
 * Es una lista de EXCLUSIÓN, no de opt-in: sin fila en
 * `notification_preferences` todo llega activado (ver
 * `DEFAULT_NOTIFICATION_PREFERENCES` en packages/mail). Un aviso de plazo
 * que nunca llegó porque nadie marcó una casilla es peor que uno de más —
 * por eso los interruptores arrancan encendidos y lo que el usuario hace
 * aquí es APAGAR.
 *
 * Cada interruptor manda su propia categoría (`PUT` parcial: las omitidas
 * se dejan como estaban) y pinta lo que DEVUELVE el servidor, nunca un
 * estado optimista: si el `PUT` falla, la casilla se queda donde estaba en
 * vez de mentir sobre un cambio que no se guardó.
 */
function NotificationPreferencesSection() {
  const { data: preferences, isLoading, isError, error, refetch } = useNotificationPreferences();
  const update = useUpdateNotificationPreferences();
  const [pendiente, setPendiente] = useState<keyof NotificationPreferences | null>(null);

  const onToggle = async (key: keyof NotificationPreferences, value: boolean) => {
    setPendiente(key);
    try {
      await update.mutateAsync({ [key]: value } as Partial<NotificationPreferences>);
    } catch (err) {
      toast.error(describeApiError(err));
    } finally {
      setPendiente(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BellRing className="h-5 w-5 text-primary" aria-hidden="true" />
          Notificaciones por correo
        </CardTitle>
        <CardDescription>
          Todas llegan activadas: aquí apagas las que no quieras. El cambio aplica a tu cuenta, en todas tus
          organizaciones.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <LoadingState label="Cargando tus preferencias…" />}
        {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}

        {preferences && (
          <ul className="space-y-3">
            {CATEGORIAS_NOTIFICACION.map((categoria) => (
              <li key={categoria.key} className="flex items-start gap-3 rounded-xl border border-border p-3">
                <input
                  id={`pref-${categoria.key}`}
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
                  checked={preferences[categoria.key]}
                  disabled={pendiente !== null}
                  onChange={(event) => void onToggle(categoria.key, event.target.checked)}
                />
                <div className="min-w-0">
                  <label htmlFor={`pref-${categoria.key}`} className="block text-sm font-medium text-foreground">
                    {categoria.label}
                  </label>
                  <p className="text-xs text-muted-foreground">{categoria.description}</p>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* REQ-187: la parte que esta pantalla está obligada a decir. Los
            correos de seguridad de cuenta (`account_security`) NO son
            apagables -- no están en `OPTIONAL_CATEGORIES` de apps/api y
            `isCategoryEnabled` de packages/mail ni siquiera consulta las
            preferencias para ellos. Ocultarlo generaría la queja legítima
            de "apagué todo y me siguen llegando correos". */}
        <p className="rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Los correos de seguridad de la cuenta no se pueden desactivar</span>{" "}
          (confirmación de correo, restablecimiento de contraseña, activación de 2FA y códigos de respaldo): son los que te
          avisan si alguien intenta entrar a tu cuenta. Tampoco se apagan desde el enlace de baja de un clic del pie de
          cada correo, que solo afecta a las categorías de arriba.
        </p>
      </CardContent>
    </Card>
  );
}

const passwordFormSchema = z
  .object({
    currentPassword: z.string().min(1, "Ingresa tu contraseña actual."),
    newPassword: z.string().min(8, "La contraseña nueva debe tener al menos 8 caracteres."),
    confirmPassword: z.string().min(1, "Confirma tu contraseña nueva."),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    message: "Las contraseñas nuevas no coinciden.",
    path: ["confirmPassword"],
  });
type PasswordFormValues = z.infer<typeof passwordFormSchema>;

/**
 * E21 (docs/BACKLOG.md): `POST /auth/password/change` -- exige step-up
 * ADEMÁS de la contraseña actual. Solo aplica a cuentas con contraseña
 * propia (`user.hasPassword`, `GET /me`) -- una cuenta solo-Google
 * (REQ-172) no tiene contraseña que cambiar; se declara así en vez de
 * ofrecer un formulario que la API rechazaría con 409.
 *
 * Éxito revoca TODAS las sesiones (este dispositivo incluido, ver
 * docstring de `lib/api/password.ts`) -- tras el `toast` de éxito, la
 * pantalla cierra la sesión local (`useAuth().logout()`) y deja que el
 * enrutado normal mande a `/login`: seguir "autenticado" con un refresh
 * token que el servidor ya revocó solo produciría un 401 en la siguiente
 * petición.
 */
function ChangePasswordSection() {
  const { user, logout } = useAuth();
  const changePassword = useChangePassword();
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [pendingValues, setPendingValues] = useState<PasswordFormValues | null>(null);
  const form = useForm<PasswordFormValues>({
    resolver: zodResolver(passwordFormSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  const onSubmit = (values: PasswordFormValues) => {
    setPendingValues(values);
    setStepUpOpen(true);
  };

  const onStepUpVerified = (stepUpToken: string) => {
    const values = pendingValues;
    setPendingValues(null);
    if (!values) return;
    changePassword.mutate(
      { payload: { currentPassword: values.currentPassword, newPassword: values.newPassword }, stepUpToken },
      {
        onSuccess: async () => {
          toast.success("Contraseña actualizada. Vuelve a iniciar sesión con tu contraseña nueva.");
          form.reset();
          await logout();
        },
        onError: (err) => toast.error(describeApiError(err)),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Lock className="h-5 w-5 text-primary" aria-hidden="true" />
          Contraseña
        </CardTitle>
        <CardDescription>Exige verificación en dos pasos además de tu contraseña actual. Cambiarla cierra todas tus sesiones.</CardDescription>
      </CardHeader>
      <CardContent>
        {user && !user.hasPassword ? (
          <p className="text-sm text-muted-foreground">
            Esta cuenta no tiene contraseña propia (solo Google) — no hay nada que cambiar aquí.
          </p>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <FormField
                  control={form.control}
                  name="currentPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Contraseña actual</FormLabel>
                      <FormControl>
                        <Input type="password" autoComplete="current-password" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="newPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Contraseña nueva</FormLabel>
                      <FormControl>
                        <Input type="password" autoComplete="new-password" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="confirmPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Confirmar contraseña nueva</FormLabel>
                      <FormControl>
                        <Input type="password" autoComplete="new-password" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <Button type="submit" className="gap-1.5" disabled={changePassword.isPending}>
                <Lock className="h-4 w-4" aria-hidden="true" />
                {changePassword.isPending ? "Cambiando…" : "Cambiar contraseña"}
              </Button>
            </form>
          </Form>
        )}
      </CardContent>

      <StepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        purpose="auth.password_change"
        title="Confirma el cambio de contraseña"
        description="Verifica con tu app de autenticación antes de cambiar tu contraseña."
        onVerified={onStepUpVerified}
      />
    </Card>
  );
}

/**
 * E19 (docs/BACKLOG.md): `POST /auth/google/unlink` -- exige step-up y se
 * rechaza (409) si la cuenta se quedaría sin ningún método de acceso (sin
 * contraseña propia). Sin un flujo de "conectar Google" para una cuenta ya
 * autenticada en apps/api (la vinculación real solo ocurre AUTOMÁTICAMENTE
 * al iniciar sesión con Google por primera vez con un email que coincide,
 * ver `modules/auth/google/routes.ts`), esta sección solo declara el
 * estado y ofrece desvincular -- nunca un botón "vincular" que no tendría
 * endpoint detrás.
 */
function GoogleAccountSection() {
  const { user, refreshUser } = useAuth();
  const unlinkGoogle = useUnlinkGoogle();
  const [stepUpOpen, setStepUpOpen] = useState(false);

  if (!user) return null;

  const onStepUpVerified = (stepUpToken: string) => {
    unlinkGoogle.mutate(stepUpToken, {
      onSuccess: async () => {
        toast.success("Cuenta de Google desvinculada.");
        await refreshUser();
      },
      onError: (err) => toast.error(describeApiError(err)),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Link2Off className="h-5 w-5 text-primary" aria-hidden="true" />
          Cuenta de Google
        </CardTitle>
        <CardDescription>Vincular ocurre automáticamente al iniciar sesión con Google usando este mismo correo.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {user.googleLinked ? (
          <>
            <div className="flex items-center gap-2">
              <Badge variant="success">Vinculada</Badge>
              <span className="text-sm text-muted-foreground">Puedes iniciar sesión con esta cuenta de Google.</span>
            </div>
            {user.hasPassword ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="gap-1.5"
                disabled={unlinkGoogle.isPending}
                onClick={() => setStepUpOpen(true)}
              >
                <Link2Off className="h-4 w-4" aria-hidden="true" />
                Desvincular Google
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                No se puede desvincular: esta cuenta no tiene contraseña propia y se quedaría sin ningún método de acceso. Configura una
                contraseña primero (restablecerla vía "olvidé mi contraseña" también sirve para ponerla por primera vez).
              </p>
            )}
          </>
        ) : (
          <div className="flex items-center gap-2">
            <Badge variant="secondary">Sin vincular</Badge>
            <span className="text-sm text-muted-foreground">No has vinculado ninguna cuenta de Google.</span>
          </div>
        )}
      </CardContent>

      <StepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        purpose="auth.google_unlink"
        title="Confirma la desvinculación de Google"
        description="Verifica con tu app de autenticación antes de desvincular tu cuenta de Google."
        onVerified={onStepUpVerified}
      />
    </Card>
  );
}

/**
 * E21 (docs/BACKLOG.md): `GET/DELETE /auth/sessions`,
 * `POST /auth/sessions/revoke-others` -- una fila por refresh token
 * vigente (como mucho una por login original, ver docstring de la
 * migración 0092: la rotación reemplaza la fila anterior, no suma). La API
 * no indica cuál fila es "esta" sesión (ver docstring de
 * `lib/api/auth-sessions.ts`), así que ninguna fila se marca como actual.
 */
function SessionsSection() {
  const { data, isLoading, isError, error, refetch } = useAuthSessions();
  const revokeOne = useRevokeAuthSession();
  const revokeOthers = useRevokeOtherAuthSessions();
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const onRevokeOne = (id: string) => {
    setRevokingId(id);
    revokeOne.mutate(id, {
      onSuccess: () => toast.success("Sesión cerrada."),
      onError: (err) => toast.error(describeApiError(err)),
      onSettled: () => setRevokingId(null),
    });
  };

  const onRevokeOthers = () => {
    revokeOthers.mutate(undefined, {
      onSuccess: (result) => toast.success(`${result.revokedCount} sesión(es) cerrada(s).`),
      onError: (err) => toast.error(describeApiError(err)),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Monitor className="h-5 w-5 text-primary" aria-hidden="true" />
          Sesiones activas
        </CardTitle>
        <CardDescription>Un dispositivo/navegador por fila. Cerrar una la deja sin efecto de inmediato.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <LoadingState label="Cargando tus sesiones…" />}
        {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}

        {!isLoading && !isError && data && data.sessions.length === 0 && (
          <EmptyState icon={Monitor} title="Sin sesiones activas" description="No se encontró ninguna sesión vigente." />
        )}

        {!isLoading && !isError && data && data.sessions.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Creada</TableHead>
                    <TableHead>Expira</TableHead>
                    <TableHead>IP</TableHead>
                    <TableHead>Agente</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.sessions.map((session) => (
                    <TableRow key={session.id}>
                      <TableCell>{formatDateTimeMx(session.createdAt)}</TableCell>
                      <TableCell>{formatDateTimeMx(session.expiresAt)}</TableCell>
                      <TableCell>{session.ipAddress ?? "—"}</TableCell>
                      <TableCell className="max-w-[16rem] truncate" title={session.userAgent ?? undefined}>
                        {session.userAgent ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          disabled={revokingId === session.id}
                          onClick={() => onRevokeOne(session.id)}
                        >
                          <LogOut className="h-4 w-4" aria-hidden="true" />
                          {revokingId === session.id ? "Cerrando…" : "Cerrar"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {data.sessions.length > 1 && (
              <Button type="button" variant="secondary" size="sm" className="gap-1.5" disabled={revokeOthers.isPending} onClick={onRevokeOthers}>
                <LogOut className="h-4 w-4" aria-hidden="true" />
                {revokeOthers.isPending ? "Cerrando…" : "Cerrar las demás sesiones"}
              </Button>
            )}
          </>
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
        description="Seguridad de tu cuenta y notificaciones por correo. Fuentes de convocatorias, reglas de matching e integraciones siguen sin conectar."
      />
      <div className="space-y-6">
        <TwoFactorSection />
        <ChangePasswordSection />
        <GoogleAccountSection />
        <SessionsSection />
        <NotificationPreferencesSection />
      </div>
    </div>
  );
}
