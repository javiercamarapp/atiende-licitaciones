import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ShieldCheck } from "lucide-react";

import { AtiendeWordmark } from "@/components/AtiendeLogo";
import { AtiendeMark } from "@/components/AtiendeLogo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { ErrorState } from "@/components/ui/error-state";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { exchangeGoogleCallback, verifyGoogleTwoFactor } from "@/lib/api/google";
import type { AuthTokens } from "@/lib/api/schemas";
import { useDocumentMeta } from "@/hooks/useDocumentMeta";

type Phase =
  | { kind: "processing" }
  | { kind: "requires_2fa"; pendingToken: string }
  | { kind: "error"; message: string }
  | { kind: "done" };

const twoFactorSchema = z.object({ code: z.string().min(1, "Ingresa tu código TOTP o de respaldo.") });
type TwoFactorValues = z.infer<typeof twoFactorSchema>;

/**
 * REQ-172..180: página de callback del flujo OIDC de Google. `apps/api`
 * configura `GOOGLE_REDIRECT_URI` apuntando AQUÍ (a esta SPA, no a
 * `apps/api` directamente — ver apps/api/test/google-oidc-login.test.ts,
 * `GOOGLE_REDIRECT_URI = 'https://app.example.test/auth/google/callback'`):
 * el proveedor redirige el navegador completo a esta ruta con
 * `?code&state` (o `?error=...&state`), y esta página es quien llama a
 * `GET /auth/google/callback` con esos mismos parámetros — nunca al revés.
 *
 * Pública (fuera de `RequireAuth`, como `/login`): un login en curso, por
 * definición, todavía no tiene sesión.
 */
export default function GoogleCallbackPage() {
  useDocumentMeta({ title: "Iniciando sesión con Google" });
  const [search] = useSearchParams();
  const { loginWithTokens } = useAuth();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>({ kind: "processing" });
  const ranOnce = useRef(false);

  useEffect(() => {
    // React 18 StrictMode (dev) monta/desmonta dos veces — `code`/`state`
    // son de UN SOLO USO del lado del servidor (`oauth_states` se consume
    // atómicamente): un segundo intercambio real respondería 400 "ya fue
    // utilizado". Esta guarda evita ese doble intercambio espurio.
    if (ranOnce.current) return;
    ranOnce.current = true;

    const code = search.get("code");
    const state = search.get("state");
    const providerError = search.get("error");

    if (!state) {
      setPhase({ kind: "error", message: "Falta el parámetro state en la redirección de Google. Vuelve a intentar el inicio de sesión." });
      return;
    }

    void (async () => {
      try {
        const result = await exchangeGoogleCallback({ code, state, error: providerError });
        await handleResult(result);
      } catch (err) {
        setPhase({ kind: "error", message: describeApiError(err) });
      }
    })();

    async function handleResult(result: { status: "ok" | "sin_acceso" | "requires_2fa"; accessToken?: string; refreshToken?: string; pendingToken?: string }) {
      if (result.status === "requires_2fa") {
        if (!result.pendingToken) {
          setPhase({ kind: "error", message: "La respuesta del servidor no incluyó el token pendiente de verificación en dos pasos." });
          return;
        }
        setPhase({ kind: "requires_2fa", pendingToken: result.pendingToken });
        return;
      }
      if (!result.accessToken || !result.refreshToken) {
        setPhase({ kind: "error", message: "La respuesta del servidor no incluyó los tokens de sesión." });
        return;
      }
      await completeLogin({ accessToken: result.accessToken, refreshToken: result.refreshToken }, result.status);
    }

    async function completeLogin(tokens: AuthTokens, status: "ok" | "sin_acceso") {
      try {
        await loginWithTokens(tokens);
        setPhase({ kind: "done" });
        navigate(status === "ok" ? "/panel" : "/sin-acceso", { replace: true });
      } catch (err) {
        setPhase({ kind: "error", message: describeApiError(err) });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo debe correr UNA vez al montar (ver `ranOnce`); `search`/`loginWithTokens`/`navigate` son estables en la práctica para este flujo de un solo paso.
  }, []);

  if (phase.kind === "requires_2fa") {
    return <GoogleTwoFactorStep pendingToken={phase.pendingToken} />;
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 py-10">
      <AtiendeWordmark />
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle level={1} className="text-lg">
            Iniciando sesión con Google
          </CardTitle>
        </CardHeader>
        <CardContent>
          {phase.kind === "processing" || phase.kind === "done" ? (
            <div role="status" aria-label="Completando el inicio de sesión con Google" className="flex flex-col items-center gap-3 py-6">
              <AtiendeMark className="atiende-respira h-10 w-auto" animado />
              <p className="text-sm text-muted-foreground">Completando el inicio de sesión…</p>
            </div>
          ) : (
            <div className="space-y-4">
              <ErrorState message={phase.message} title="No se pudo completar el inicio de sesión con Google" />
              <Button asChild className="w-full">
                <Link to="/login">Volver al inicio de sesión</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

/**
 * REQ-176: la cuenta vinculada/existente ya tiene 2FA enrolado+verificado —
 * `GET /auth/google/callback` no completa la sesión, devuelve
 * `pendingToken` para canjear aquí junto con un código TOTP/backup real.
 * No existía ninguna pantalla de "2FA al iniciar sesión" antes de esta
 * ronda (el 2FA de `apps/api` hasta ahora era solo step-up de acciones
 * sensibles, ver `components/StepUpDialog.tsx`) — el login con
 * email+contraseña nunca lo exige. Se construye una pantalla nueva,
 * dedicada, con el mismo patrón visual (código TOTP o de respaldo) que
 * `StepUpDialog`.
 */
function GoogleTwoFactorStep({ pendingToken }: { pendingToken: string }) {
  const { loginWithTokens } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<TwoFactorValues>({ resolver: zodResolver(twoFactorSchema), defaultValues: { code: "" } });

  const onSubmit = async (values: TwoFactorValues) => {
    setError(null);
    setSubmitting(true);
    try {
      const result = await verifyGoogleTwoFactor(pendingToken, values.code.trim());
      if (!result.accessToken || !result.refreshToken) {
        setError("La respuesta del servidor no incluyó los tokens de sesión.");
        return;
      }
      await loginWithTokens({ accessToken: result.accessToken, refreshToken: result.refreshToken });
      navigate(result.status === "ok" ? "/panel" : "/sin-acceso", { replace: true });
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 py-10">
      <AtiendeWordmark />
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" strokeWidth={1.75} />
          </div>
          <CardTitle level={1} className="text-lg">
            Verificación en dos pasos
          </CardTitle>
          <CardDescription>Esta cuenta de Google tiene 2FA activo — confirma tu identidad para completar el inicio de sesión.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-4">
              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Código TOTP o de respaldo</FormLabel>
                    <FormControl>
                      <Input autoComplete="one-time-code" placeholder="123456 o XXXX-XXXX" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {error && <ErrorState message={error} onRetry={() => setError(null)} />}
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? "Verificando…" : "Verificar y continuar"}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </main>
  );
}

