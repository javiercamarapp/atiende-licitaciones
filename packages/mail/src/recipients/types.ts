import { z } from "zod";

/**
 * Un destinatario REGISTRADO. `MailService.send()` nunca acepta un `string`
 * suelto como destinatario a propósito (ver `service/mail-service.ts`): el
 * llamador (`apps/api`/`apps/worker`) es quien conoce la base de usuarios y
 * quien debe validar que la dirección pertenece a una cuenta real de
 * Atiende antes de gastar un envío en ella. Este tipo es el contrato de esa
 * validación, no un sustituto — construirlo a mano sin haber consultado la
 * base sería reintroducir el mismo riesgo que existe para evitar.
 */
export const RegisteredRecipientSchema = z.object({
  email: z.string().email("Correo inválido."),
  userId: z.string().min(1, "userId es obligatorio."),
  organizationId: z.string().min(1).optional(),
  /** `suspended` existe para que el llamador pueda marcar una cuenta dada de
   *  baja sin borrar el registro; `MailService` rechaza el envío si llega
   *  así, en vez de confiar en que el llamador ya filtró. */
  status: z.enum(["active", "invited", "suspended"]).default("active"),
});

export type RegisteredRecipient = z.infer<typeof RegisteredRecipientSchema>;

export class UnregisteredRecipientError extends Error {
  constructor(reason: string) {
    super(`Destinatario no registrado o inválido: ${reason}`);
    this.name = "UnregisteredRecipientError";
  }
}

/** Valida y normaliza un destinatario. Lanza `UnregisteredRecipientError` si
 *  no cumple el esquema o si la cuenta está suspendida — nunca se manda un
 *  correo a una cuenta que Atiende ya no reconoce como activa. */
export function assertRegisteredRecipient(value: unknown): RegisteredRecipient {
  const parsed = RegisteredRecipientSchema.safeParse(value);
  if (!parsed.success) {
    throw new UnregisteredRecipientError(parsed.error.issues.map((i) => i.message).join("; "));
  }
  if (parsed.data.status === "suspended") {
    throw new UnregisteredRecipientError(`la cuenta ${parsed.data.userId} está suspendida`);
  }
  return parsed.data;
}
