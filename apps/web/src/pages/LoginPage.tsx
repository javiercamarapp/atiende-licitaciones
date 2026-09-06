import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Lock } from "lucide-react";
import { Link, Navigate, useLocation } from "react-router-dom";

import { AtiendeWordmark } from "@/components/AtiendeLogo";
import { SkipLink } from "@/components/SkipLink";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { ErrorState } from "@/components/ui/error-state";
import { GoogleAuthButton } from "@/components/auth/GoogleAuthButton";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { toast } from "@/components/ui/sonner";
import "./login.css";

const passwordSchema = z.object({
  email: z.string().min(1, "Ingresa tu correo electrónico.").email("Ingresa un correo electrónico válido."),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres."),
});
type PasswordValues = z.infer<typeof passwordSchema>;

function PasswordLoginForm() {
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = async (values: PasswordValues) => {
    setError(null);
    setSubmitting(true);
    try {
      await login(values);
      toast.success("Sesión iniciada correctamente.");
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-4">
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
                <Input type="password" autoComplete="current-password" placeholder="••••••••" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {error && <ErrorState message={error} onRetry={() => setError(null)} />}
        <Button type="submit" className="w-full gap-2" disabled={submitting}>
          <Lock className="h-4 w-4" aria-hidden="true" />
          {submitting ? "Iniciando sesión…" : "Iniciar sesión"}
        </Button>
      </form>
    </Form>
  );
}

export default function LoginPage() {
  const { status } = useAuth();
  const location = useLocation();

  // Si ya hay sesión (p. ej. el refresh token restauró una sesión al
  // recargar /login directamente), no tiene sentido mostrar el formulario:
  // se redirige a la ruta que se pedía originalmente o al panel.
  if (status === "authenticated") {
    const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? "/panel";
    return <Navigate to={from} replace />;
  }

  return (
    // LoginPage es la única pantalla que no usa <AppShell/> (que ya aporta
    // <main>/<h1> a todas las demás), así que necesita su propio landmark y
    // encabezado real — sin esto axe reporta landmark-one-main,
    // page-has-heading-one y region (W-08).
    //
    // Layout a pantalla partida (W-11, ver README § "Paridad del login con
    // Restaurantes"). Ronda 3: se retira la pestaña de enlace mágico — no
    // existe ningún endpoint `/auth/magic-link` (ni equivalente) en
    // apps/api (ver apps/api/README.md, módulo `auth`: solo
    // register/login/refresh/logout con contraseña); mantenerla habría
    // sido una acción de UI sin backend real detrás, exactamente lo que
    // esta ronda busca eliminar. Si el backend añade ese flujo en una
    // ronda futura, se puede reintroducir la pestaña.
    <main className="min-h-screen bg-background lg:grid lg:grid-cols-2">
      <SkipLink targetId="login-form">Saltar al formulario de acceso</SkipLink>

      <section className="flex min-h-screen flex-col px-6 py-7 sm:px-10 lg:px-14 lg:py-10">
        <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col">
          <header className="flex items-center">
            <AtiendeWordmark />
          </header>

          <div className="flex flex-1 flex-col justify-center py-12">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Acceso al panel</p>
            <h1 className="login-serif mt-5 text-[34px] font-medium leading-[1.15] text-foreground sm:text-[42px]">
              Accede a tu panel de licitaciones
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
              Gestiona convocatorias, evaluaciones y entregas en un solo lugar.
            </p>

            {/* W-18: al retirar el <Tabs/> que envolvía este formulario
                (ronda 3, ver más abajo), se perdieron sin querer las clases
                del anillo de foco visible que llevaba ese wrapper
                (`focus-visible:ring-2 ...`) — quedaba `focus-visible:outline-none`
                SIN reemplazo, exactamente el bug original de W-18. Mismo
                patrón de anillo que #main-content (AppShell.tsx). */}
            <div
              id="login-form"
              tabIndex={-1}
              className="mt-9 rounded-2xl ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <PasswordLoginForm />

              {/* REQ-172: "Continuar con Google" JUNTO al método de
                  email+contraseña de arriba, nunca reemplazándolo — mismo
                  <LoginPage/>, sin pestañas. El registro tiene su propia
                  pantalla (/registro, RegistroPage.tsx) con estos mismos
                  dos métodos; el enlace de abajo la conecta. */}
              <div className="my-6 flex items-center gap-3" role="presentation">
                <span aria-hidden="true" className="h-px flex-1 bg-border" />
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">o</span>
                <span aria-hidden="true" className="h-px flex-1 bg-border" />
              </div>

              <GoogleAuthButton />

              <p className="mt-6 text-sm text-muted-foreground">
                ¿Todavía no tienes cuenta?{" "}
                <Link to="/registro" className="font-medium text-primary underline-offset-4 hover:underline">
                  Crear cuenta
                </Link>
                .
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Lámina decorativa: ver README.md. */}
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
