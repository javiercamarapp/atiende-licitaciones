/**
 * Lista de supresión, al estilo de la tabla `correo_suprimido` de Likida
 * (`docs/investigacion/salida-promocion-referencias.md` §2.2): una
 * dirección que rebotó o se quejó no vuelve a recibir correo, sin
 * excepción, hasta que alguien la quite a mano. Es DENY-ALL y FAIL-CLOSED
 * (ver `service/mail-service.ts`): si la consulta a este store falla, el
 * envío se trata como suprimido — un correo de menos nunca es tan grave
 * como seguir mandándole a una dirección que ya rebotó como spam, lo que
 * daña la reputación de TODO el dominio de envío.
 */
export type SuppressionReason = "bounce" | "complaint" | "manual" | "unsubscribe";

export interface SuppressionEntry {
  email: string;
  reason: SuppressionReason;
  /** De dónde vino la supresión: `"webhook_resend"`, `"webhook_postmark"`,
   *  `"panel_admin"`, etc. — para auditoría, no para lógica. */
  source: string;
  createdAt: string;
}

export interface SuppressionStore {
  isSuppressed(email: string): Promise<boolean>;
  suppress(email: string, reason: SuppressionReason, source: string): Promise<void>;
  /** Quitar de la lista — una acción manual y deliberada, nunca automática. */
  unsuppress(email: string): Promise<void>;
  get(email: string): Promise<SuppressionEntry | undefined>;
}

export class InMemorySuppressionStore implements SuppressionStore {
  private readonly entries = new Map<string, SuppressionEntry>();

  async isSuppressed(email: string): Promise<boolean> {
    return this.entries.has(normalize(email));
  }

  async suppress(email: string, reason: SuppressionReason, source: string): Promise<void> {
    const key = normalize(email);
    this.entries.set(key, { email: key, reason, source, createdAt: new Date().toISOString() });
  }

  async unsuppress(email: string): Promise<void> {
    this.entries.delete(normalize(email));
  }

  async get(email: string): Promise<SuppressionEntry | undefined> {
    return this.entries.get(normalize(email));
  }
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}
