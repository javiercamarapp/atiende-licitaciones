import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { MailCheck, Send } from "lucide-react";
import { Link } from "react-router-dom";

import { AuthScreen } from "@/components/auth/AuthScreen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { ErrorState } from "@/components/ui/error-state";
import { requestPasswordReset } from "@/lib/api/mail";
import { describeApiError } from "@/hooks/useAuth";
import { useDocumentMeta } from "@/hooks/useDocumentMeta";

const forgotSchema = z.object({
  email: z.string().min(1, "Ingresa tu correo electrónico.").email("Ingresa un correo electrónico válido."),
});
type ForgotValues = z.infer<typeof forgotSchema>;

/**
 * REQ-186 (ronda 8b): "¿Olvidaste tu contraseña?" — `POST
 * /auth/password/forgot`.
 *
 * **La respuesta es idéntica exista o no la cuenta, y esta pantalla lo
 * respeta al pie de la letra.** La API responde 202 con el mismo cuerpo
 * byte a byte en ambos casos y dispara el correo SIN `await` para que
 * tampoco la latencia los distinga (apps/api/src/modules/auth/mail.routes.ts,
 * regla 1). Cualquier confirmación del tipo "listo, te mandamos el correo"
 * o "ese correo no está registrado" convertiría esa defensa del servidor en
 * papel mojado desde el cliente: bastaría con leer la pantalla para saber
 * qué direcciones tienen cuenta. Por eso el estado de éxito dice
 * literalmente "SI existe una cuenta con ese correo…" — es lo único que
 * esta pantalla sabe de verdad.
 *
 * Detalle real que tampoco se oculta: una cuenta creada SOLO con Google no
 * tiene contraseña que restablecer, así que apps/api omite el envío (sin
 * cambiar la respuesta). De ahí la nota que remite a "Continuar con Google".
 */
export default function RecuperarPasswordPage() {
  useDocumentMeta({ title: "Recuperar contraseña" });
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<ForgotValues>({ resolver: zodResolver(forgotSchema), defaultValues: { email: "" } });

  const onSubmit = async (values: ForgotValues) => {
    setError(null);
    setSubmitting(true);
    try {
      await requestPasswordReset(values.email);
      setSent(true);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthScreen
      eyebrow="Recuperar acceso"
      title="¿Olvidaste tu contraseña?"
      intro="Escribe el correo de tu cuenta y te mandamos un enlace para elegir una nueva. El enlace vive 30 minutos y solo se puede usar una vez."
      contentId="recuperar-form"
      skipLabel="Saltar al formulario de recuperación"
    >
      {sent ? (
        <div className="space-y-4">
          <div role="status" className="flex items-start gap-3 rounded-2xl border border-border bg-muted/40 p-4">
            <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <div className="space-y-2 text-sm">
              <p className="font-medium text-foreground">Si existe una cuenta con ese correo, ya va en camino el enlace.</p>
              <p className="text-muted-foreground">
                No podemos decirte si ese correo tiene cuenta o no: la respuesta del servidor es idéntica en ambos casos, a
                propósito, para que nadie pueda usar esta pantalla como directorio de usuarios. Revisa tu bandeja (y la de
                correo no deseado) en los próximos minutos.
              </p>
              <p className="text-muted-foreground">
                Si creaste tu cuenta con Google, no hay contraseña que restablecer: entra desde{" "}
                <Link to="/login" className="font-medium text-primary underline-offset-4 hover:underline">
                  "Continuar con Google"
                </Link>
                .
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => {
              setSent(false);
              form.reset();
            }}
          >
            Usar otro correo
          </Button>
        </div>
      ) : (
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
              <Send className="h-4 w-4" aria-hidden="true" />
              {submitting ? "Enviando…" : "Enviarme el enlace"}
            </Button>
          </form>
        </Form>
      )}

      <p className="mt-6 text-sm text-muted-foreground">
        ¿Ya la recordaste?{" "}
        <Link to="/login" className="font-medium text-primary underline-offset-4 hover:underline">
          Volver a iniciar sesión
        </Link>
        .
      </p>
    </AuthScreen>
  );
}
