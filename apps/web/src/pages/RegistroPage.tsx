import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { UserPlus } from "lucide-react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";

import { AtiendeWordmark } from "@/components/AtiendeLogo";
import { SkipLink } from "@/components/SkipLink";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { ErrorState } from "@/components/ui/error-state";
import { GoogleAuthButton } from "@/components/auth/GoogleAuthButton";
import { ApiError } from "@/lib/api/http";
import { register as registerAccount } from "@/lib/api/auth";
import { redirectAfterAuth } from "@/lib/redirectAfterAuth";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useDocumentMeta } from "@/hooks/useDocumentMeta";
import { toast } from "@/components/ui/sonner";
import "./login.css";

/**
 * Espejo EXACTO de `registerBodySchema` (apps/api/src/modules/auth/schemas.ts):
 * email válido, contraseña de mínimo 8 caracteres, nombre opcional. La
 * confirmación de contraseña es solo del cliente (apps/api no la recibe) —
 * evita que un error de tecleo cree una cuenta a la que el usuario no
 * puede volver a entrar.
 */
const registroSchema = z
  .object({
    fullName: z.string().trim().max(200, "Máximo 200 caracteres.").optional(),
    email: z.string().min(1, "Ingresa tu correo electrónico.").email("Ingresa un correo electrónico válido."),
    password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres."),
    passwordConfirm: z.string().min(1, "Repite la contraseña."),
  })
  .refine((values) => values.password === values.passwordConfirm, {
    path: ["passwordConfirm"],
    message: "Las dos contraseñas no coinciden.",
  });
type RegistroValues = z.infer<typeof registroSchema>;

/**
 * REQ-172 (docs/REQUISITOS.md): pantalla de registro con los DOS métodos
 * reales — email+contraseña (`POST /auth/register`, que ya existía en
 * `lib/api/auth.ts` sin ninguna pantalla que lo usara) y "Registrarme con
 * Google" (mismo `GoogleAuthButton` que /login: el flujo OIDC de apps/api
 * crea la cuenta en el primer login si el email no existía, ver
 * apps/api/README.md § auth/google).
 *
 * API-03 (docs/auditoria-1/db-api.md): `POST /auth/register` responde
 * SIEMPRE 201, exista o no ya una cuenta con ese correo — es
 * antienumeración deliberada del backend. Esta pantalla NO puede (ni debe)
 * afirmar "cuenta creada": muestra un mensaje que es verdadero en ambos
 * casos y encadena un `login()` real; si el correo ya existía con OTRA
 * contraseña, ese login falla con el 401 real de la API y el usuario ve el
 * motivo honesto en vez de una falsa confirmación.
 *
 * REQ-181 (ronda 8b): apps/api dispara el correo de verificación al
 * registrar (sin esperarlo). Con la compuerta activa —el valor por defecto—
 * el login encadenado responde `403 email-not-verified`, y eso NO es un
 * fallo: es la señal de que la cuenta quedó creada y falta confirmar el
 * correo. Ese caso lleva a `/revisa-tu-correo` (RevisaTuCorreoPage.tsx), que
 * también ofrece reenviar el enlace. Con la compuerta apagada
 * (`REQUIRE_EMAIL_VERIFICATION=false`) el login entra directo, como antes.
 */
export default function RegistroPage() {
  useDocumentMeta({ title: "Crear cuenta" });
  const { status, login } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<RegistroValues>({
    resolver: zodResolver(registroSchema),
    defaultValues: { fullName: "", email: "", password: "", passwordConfirm: "" },
  });

  // Mismo criterio que LoginPage: con sesión ya activa esta pantalla no
  // tiene nada que hacer.
  if (status === "authenticated") {
    return <Navigate to={redirectAfterAuth(location.state)} replace />;
  }

  const onSubmit = async (values: RegistroValues) => {
    setError(null);
    setSubmitting(true);
    try {
      const fullName = values.fullName?.trim();
      await registerAccount({ email: values.email, password: values.password, ...(fullName ? { fullName } : {}) });
      // El registro NO emite tokens (responde `{id, email}`): la sesión se
      // abre con el login real de siempre, exactamente el mismo que usaría
      // el usuario mañana.
      await login({ email: values.email, password: values.password });
      toast.success("Cuenta lista. Te llevamos al siguiente paso.");
    } catch (err) {
      // REQ-181 (ronda 8b): con la compuerta de verificación ACTIVA
      // (`REQUIRE_EMAIL_VERIFICATION`, el valor por defecto de apps/api),
      // este login encadenado responde `403 email-not-verified` — no es un
      // fallo del registro, es exactamente el flujo esperado: la cuenta
      // quedó creada y el correo de confirmación salió. Se lleva al usuario
      // al aviso "revisa tu correo" (que además ofrece reenviarlo) en vez de
      // mostrarle un error rojo por algo que salió bien.
      if (err instanceof ApiError && err.status === 403 && (err.type ?? "").includes("email-not-verified")) {
        navigate("/revisa-tu-correo", { state: { email: values.email, motivo: "registro" } });
        return;
      }
      setError(describeApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-background lg:grid lg:grid-cols-2">
      <SkipLink targetId="registro-form">Saltar al formulario de registro</SkipLink>

      <section className="flex min-h-screen flex-col px-6 py-7 sm:px-10 lg:px-14 lg:py-10">
        <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col">
          <header className="flex items-center">
            <AtiendeWordmark />
          </header>

          <div className="flex flex-1 flex-col justify-center py-12">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Crear cuenta</p>
            <h1 className="login-serif mt-5 text-[34px] font-medium leading-[1.15] text-foreground sm:text-[42px]">
              Crea tu cuenta de Atiende Licitaciones
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
              Al terminar, podrás crear tu organización o aceptar la invitación de una que ya exista.
            </p>

            <div
              id="registro-form"
              tabIndex={-1}
              className="mt-9 rounded-2xl ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-4">
                  <FormField
                    control={form.control}
                    name="fullName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Nombre completo (opcional)</FormLabel>
                        <FormControl>
                          <Input autoComplete="name" placeholder="Ana Pérez" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Correo electrónico</FormLabel>
                        <FormControl>
                          <Input type="email" autoComplete="email" placeholder="tu@empresa.com" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Contraseña</FormLabel>
                        <FormControl>
                          <Input type="password" autoComplete="new-password" placeholder="••••••••" {...field} />
                        </FormControl>
                        <FormDescription>Mínimo 8 caracteres (lo que exige la API, ni más ni menos).</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="passwordConfirm"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Repite la contraseña</FormLabel>
                        <FormControl>
                          <Input type="password" autoComplete="new-password" placeholder="••••••••" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  {error && <ErrorState message={error} onRetry={() => setError(null)} />}
                  <Button type="submit" className="w-full gap-2" disabled={submitting}>
                    <UserPlus className="h-4 w-4" aria-hidden="true" />
                    {submitting ? "Creando cuenta…" : "Crear cuenta"}
                  </Button>
                </form>
              </Form>

              {/* REQ-172: el mismo botón de /login, con la etiqueta propia
                  del registro — el flujo OIDC es idéntico (apps/api crea la
                  cuenta en el primer login si el correo no existía). */}
              <div className="my-6 flex items-center gap-3" role="presentation">
                <span aria-hidden="true" className="h-px flex-1 bg-border" />
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">o</span>
                <span aria-hidden="true" className="h-px flex-1 bg-border" />
              </div>

              <GoogleAuthButton label="Registrarme con Google" />

              <p className="mt-6 text-sm text-muted-foreground">
                ¿Ya tienes cuenta?{" "}
                <Link to="/login" className="font-medium text-primary underline-offset-4 hover:underline">
                  Inicia sesión
                </Link>
                .
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Al crear tu cuenta aceptas los{" "}
                <Link to="/legal/terminos" className="underline underline-offset-4">
                  términos de servicio
                </Link>{" "}
                y el{" "}
                <Link to="/privacidad" className="underline underline-offset-4">
                  aviso de privacidad
                </Link>
                .
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Lámina decorativa: misma de /login (ver LoginPage.tsx). */}
      <aside
        aria-hidden="true"
        className="relative hidden overflow-hidden bg-[linear-gradient(160deg,hsl(var(--primary))_0%,hsl(216_45%_9%)_100%)] lg:flex lg:flex-col lg:justify-end lg:p-10"
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,hsl(0_0%_100%/0.12),transparent_45%)]" />
        <p className="relative text-xs font-semibold uppercase tracking-[0.16em] text-primary-foreground/70">
          Licitaciones públicas en México
        </p>
        <p className="login-serif relative mt-3.5 max-w-sm text-[26px] leading-tight text-primary-foreground">
          Convocatorias, evaluación y entrega, en un solo lugar.
        </p>
      </aside>
    </main>
  );
}
