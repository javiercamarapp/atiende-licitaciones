import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { KeyRound } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { AuthScreen } from "@/components/auth/AuthScreen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { ErrorState } from "@/components/ui/error-state";
import { ApiError } from "@/lib/api/http";
import { readSignedLinkParams, resetPassword } from "@/lib/api/mail";
import { describeApiError } from "@/hooks/useAuth";
import { useDocumentMeta } from "@/hooks/useDocumentMeta";
import { toast } from "@/components/ui/sonner";

const resetSchema = z
  .object({
    password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres."),
    passwordConfirm: z.string().min(1, "Repite la contraseña."),
  })
  .refine((values) => values.password === values.passwordConfirm, {
    path: ["passwordConfirm"],
    message: "Las dos contraseñas no coinciden.",
  });
type ResetValues = z.infer<typeof resetSchema>;

/**
 * Texto que acompaña al ÚNICO error que devuelve la API para cualquier
 * enlace que no sirve. `POST /auth/password/reset` responde el mismo 400
 * genérico si el enlace venció, si ya se usó, si la firma no cuadra o si es
 * de una cuenta que ya no existe — deliberadamente, para no decirle a quien
 * prueba enlaces al azar cuándo acertó el formato
 * (apps/api/src/modules/auth/mail.routes.ts, `invalidLinkError`).
 *
 * La pantalla NO inventa cuál de los cuatro fue: enumera los motivos
 * posibles (el vencido y el ya usado son los dos casos reales que le pasan
 * a una persona normal) y ofrece la única salida que existe, pedir uno
 * nuevo. Fingir un "tu enlace expiró" cuando el servidor no lo dijo sería
 * inventar información.
 */
const MOTIVOS_ENLACE_INVALIDO = [
  "Ya venció: los enlaces de restablecimiento viven 30 minutos.",
  "Ya se usó: cada enlace sirve una sola vez (si ya cambiaste la contraseña, entra con la nueva).",
  "Se copió incompleto desde el correo, o se alteró en el camino.",
];

/**
 * REQ-186 (ronda 8b): pantalla de restablecimiento a la que aterriza el
 * enlace del correo, `/restablecer-contrasena?d=…&s=…`. La ruta la fija
 * `apps/api` al firmar el enlace (`sendPasswordResetEmail` →
 * `signedLink(publicUrl, '/restablecer-contrasena', …)`), no esta pantalla:
 * cambiarle el nombre aquí rompería todos los correos ya enviados.
 *
 * Tras el éxito redirige a `/login` (no abre sesión sola): `apps/api` revoca
 * TODAS las sesiones de la cuenta en la misma transacción que cambia la
 * contraseña (`app.reset_password_with_token`), justamente porque el motivo
 * típico para restablecerla es sospechar que alguien más la conocía —
 * autologuear aquí contradiría esa revocación.
 */
export default function RestablecerPasswordPage() {
  useDocumentMeta({ title: "Restablecer contraseña" });
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const link = readSignedLinkParams(searchParams);
  const [error, setError] = useState<string | null>(null);
  const [linkRejected, setLinkRejected] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<ResetValues>({ resolver: zodResolver(resetSchema), defaultValues: { password: "", passwordConfirm: "" } });

  const onSubmit = async (values: ResetValues) => {
    if (!link) return;
    setError(null);
    setSubmitting(true);
    try {
      await resetPassword({ ...link, newPassword: values.password });
      toast.success("Contraseña actualizada. Inicia sesión con la nueva.");
      navigate("/login", { replace: true });
    } catch (err) {
      // 400 = el único error de enlace de la API (ver MOTIVOS_ENLACE_INVALIDO).
      // Cualquier otro (429, 500, red) se muestra como error normal y el
      // formulario sigue disponible: el enlace puede seguir siendo válido.
      if (err instanceof ApiError && err.status === 400) {
        setLinkRejected(true);
      }
      setError(describeApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (!link || linkRejected) {
    return (
      <AuthScreen
        eyebrow="Recuperar acceso"
        title="Este enlace ya no sirve"
        intro={
          link
            ? "El servidor rechazó el enlace. No nos dice cuál de estos motivos fue —a propósito, para no darle pistas a quien pruebe enlaces al azar—, pero solo puede ser uno de estos:"
            : "El enlace llegó incompleto: le faltan los parámetros firmados que lo identifican. Suele pasar cuando el cliente de correo corta la URL en dos líneas."
        }
        contentId="restablecer-invalido"
        skipLabel="Saltar a las opciones de recuperación"
      >
        <div className="space-y-4">
          {link && (
            <ul className="space-y-2 rounded-2xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
              {MOTIVOS_ENLACE_INVALIDO.map((motivo) => (
                <li key={motivo}>{motivo}</li>
              ))}
            </ul>
          )}
          {error && <ErrorState message={error} />}
          <Button asChild className="w-full">
            <Link to="/recuperar-contrasena">Pedir un enlace nuevo</Link>
          </Button>
          <p className="text-sm text-muted-foreground">
            ¿Ya cambiaste la contraseña?{" "}
            <Link to="/login" className="font-medium text-primary underline-offset-4 hover:underline">
              Inicia sesión
            </Link>
            .
          </p>
        </div>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      eyebrow="Recuperar acceso"
      title="Elige una contraseña nueva"
      intro="Al guardarla se cerrarán todas las sesiones abiertas de tu cuenta, incluida la de este dispositivo: tendrás que iniciar sesión con la contraseña nueva."
      contentId="restablecer-form"
      skipLabel="Saltar al formulario de contraseña nueva"
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-4">
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Contraseña nueva</FormLabel>
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
                <FormLabel>Repite la contraseña nueva</FormLabel>
                <FormControl>
                  <Input type="password" autoComplete="new-password" placeholder="••••••••" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          {error && <ErrorState message={error} onRetry={() => setError(null)} />}
          <Button type="submit" className="w-full gap-2" disabled={submitting}>
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            {submitting ? "Guardando…" : "Guardar contraseña nueva"}
          </Button>
        </form>
      </Form>
    </AuthScreen>
  );
}
