import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Mail, Lock, Sparkles } from "lucide-react";

import { AtiendeWordmark } from "@/components/AtiendeLogo";
import { SkipLink } from "@/components/SkipLink";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { ErrorState } from "@/components/ui/error-state";
import { ApiError, login, requestMagicLink } from "@/lib/api";
import { toast } from "@/components/ui/sonner";
import "./login.css";

const passwordSchema = z.object({
  email: z.string().min(1, "Ingresa tu correo electrónico.").email("Ingresa un correo electrónico válido."),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres."),
});
type PasswordValues = z.infer<typeof passwordSchema>;

const magicLinkSchema = z.object({
  email: z.string().min(1, "Ingresa tu correo electrónico.").email("Ingresa un correo electrónico válido."),
});
type MagicLinkValues = z.infer<typeof magicLinkSchema>;

function PasswordLoginForm() {
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
      setError(err instanceof ApiError ? err.message : "Ocurrió un error inesperado al iniciar sesión.");
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

function MagicLinkForm() {
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<MagicLinkValues>({
    resolver: zodResolver(magicLinkSchema),
    defaultValues: { email: "" },
  });

  const onSubmit = async (values: MagicLinkValues) => {
    setError(null);
    setSubmitting(true);
    try {
      await requestMagicLink(values);
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ocurrió un error inesperado al enviar el enlace.");
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <p role="status" className="rounded-2xl border border-border bg-muted/50 p-4 text-sm text-foreground">
        Si el correo existe en nuestro sistema, te enviamos un enlace de acceso. Revisa tu bandeja de entrada.
      </p>
    );
  }

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
        {error && <ErrorState message={error} onRetry={() => setError(null)} />}
        <Button type="submit" className="w-full gap-2" disabled={submitting}>
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          {submitting ? "Enviando enlace…" : "Enviar enlace de acceso"}
        </Button>
      </form>
    </Form>
  );
}

export default function LoginPage() {
  return (
    // LoginPage es la única pantalla que no usa <AppShell/> (que ya aporta
    // <main>/<h1> a todas las demás), así que necesita su propio landmark y
    // encabezado real — sin esto axe reporta landmark-one-main,
    // page-has-heading-one y region (W-08).
    //
    // Layout a pantalla partida (W-11): el login real de atiende-restaurantes
    // no se parece al que describía docs/investigacion/frontend-restaurantes.md
    // (login de tabs sin más) — el real es un layout de dos columnas con
    // kicker + titular serif + formulario a la izquierda y una lámina
    // decorativa a la derecha (oculta en móvil). Se adopta esa misma anatomía
    // aquí; las divergencias deliberadas (tabs contraseña/enlace mágico en vez
    // de solo enlace mágico + Google OAuth, sin foto de cocina) están
    // documentadas en README.md § "Paridad del login con Restaurantes".
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

            <div className="mt-9">
              {/* tabIndex={-1} (W-09): sin esto el skip-link no puede mover el
                  foco aquí porque un <div> sin tabindex no es un destino de
                  foco válido — verificado por teclado real, no solo por axe.
                  W-18: `focus:outline-none` sin reemplazo dejaba el foco
                  invisible; mismo patrón de anillo de foco que
                  #main-content (AppShell.tsx) y las primitivas shadcn. */}
              <Tabs
                defaultValue="password"
                id="login-form"
                tabIndex={-1}
                className="rounded-2xl ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <TabsList className="mb-4 grid w-full grid-cols-2">
                  <TabsTrigger value="password" className="gap-1.5">
                    <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                    Contraseña
                  </TabsTrigger>
                  <TabsTrigger value="magic-link" className="gap-1.5">
                    <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                    Enlace mágico
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="password">
                  <PasswordLoginForm />
                </TabsContent>
                <TabsContent value="magic-link">
                  <MagicLinkForm />
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </div>
      </section>

      {/* Lámina decorativa: el origen usa una foto de una cocina comercial
          (fuera de dominio para licitaciones y sin licencia para reusar) —
          aquí es un degradado con los mismos tokens de marca en vez de una
          imagen de stock genérica, ver README.md. `aria-hidden` porque es
          puramente decorativa (no aporta información que no esté ya en el
          formulario). */}
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
