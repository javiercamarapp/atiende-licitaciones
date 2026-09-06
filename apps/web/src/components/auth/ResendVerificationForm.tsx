import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { MailCheck, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { ErrorState } from "@/components/ui/error-state";
import { resendEmailVerification } from "@/lib/api/mail";
import { describeApiError } from "@/hooks/useAuth";

const resendSchema = z.object({
  email: z.string().min(1, "Ingresa tu correo electrónico.").email("Ingresa un correo electrónico válido."),
});
type ResendValues = z.infer<typeof resendSchema>;

/**
 * REQ-181 (ronda 8b): reenvío del correo de confirmación
 * (`POST /auth/email/resend-verification`). Se comparte entre las tres
 * pantallas que lo necesitan —el aviso tras registrarse, la pantalla del
 * enlace fallido y la compuerta 403 del login— porque las tres tienen que
 * decir EXACTAMENTE lo mismo y equivocarse en una sola sería filtrar por
 * ahí lo que las otras dos protegen.
 *
 * Tres cosas que esta UI no puede prometer, y por eso no las promete:
 *
 * - **No dice si el correo existe.** La API responde 202 con el mismo
 *   cuerpo exista o no la cuenta, y dispara el envío sin `await`
 *   (antienumeración, ver apps/api). El mensaje de éxito empieza por "si…".
 * - **No dice si de verdad salió un correo.** apps/api omite el envío
 *   cuando la cuenta ya está verificada, está inactiva o es solo-Google
 *   (que llega verificada por el proveedor) — sin cambiar la respuesta.
 * - **El 429 es real y se muestra tal cual.** Este endpoint está en el tier
 *   `auth` (5/min por IP, el más estricto). El cliente NO reintenta a
 *   espaldas del usuario (`retries = 0` en lib/api/mail.ts): mandar el
 *   correo igual 20 segundos después vaciaría de sentido ese límite.
 */
export function ResendVerificationForm({ defaultEmail = "" }: { defaultEmail?: string }) {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<ResendValues>({ resolver: zodResolver(resendSchema), defaultValues: { email: defaultEmail } });

  const onSubmit = async (values: ResendValues) => {
    setError(null);
    setSubmitting(true);
    try {
      await resendEmailVerification(values.email);
      setSent(true);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <div className="space-y-3">
        <div role="status" className="flex items-start gap-3 rounded-2xl border border-border bg-muted/40 p-4 text-sm">
          <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <div className="space-y-2">
            <p className="font-medium text-foreground">Si esa cuenta existe y aún no está confirmada, el enlace ya va en camino.</p>
            <p className="text-muted-foreground">
              El servidor responde lo mismo exista o no la cuenta, así que no podemos confirmarte más que eso. Revisa tu
              bandeja y la de correo no deseado; el enlace vive 30 minutos.
            </p>
          </div>
        </div>
        <Button type="button" variant="outline" className="w-full" onClick={() => setSent(false)}>
          Reenviar de nuevo
        </Button>
      </div>
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
              <FormLabel>Correo de tu cuenta</FormLabel>
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
          {submitting ? "Enviando…" : "Reenviar enlace de confirmación"}
        </Button>
      </form>
    </Form>
  );
}
