import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Mail, Lock, Sparkles } from "lucide-react";

import { AtiendeWordmark } from "@/components/AtiendeLogo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { ErrorState } from "@/components/ui/error-state";
import { ApiError, login, requestMagicLink } from "@/lib/api";
import { toast } from "@/components/ui/sonner";

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
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <a href="#login-form" className="skip-link">
        Saltar al formulario de acceso
      </a>
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <AtiendeWordmark className="mb-2" />
          <CardTitle>Accede a tu panel de licitaciones</CardTitle>
          <CardDescription>Gestiona convocatorias, evaluaciones y entregas en un solo lugar.</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="password" id="login-form">
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
        </CardContent>
      </Card>
    </div>
  );
}
