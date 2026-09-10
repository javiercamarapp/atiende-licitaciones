// Formato de fecha/hora en America/Mexico_City (REQ: plazos/aclaraciones de
// convocatorias en la zona horaria real del dominio, nunca UTC crudo ni la
// zona del navegador del usuario). `Intl.DateTimeFormat` con `timeZone`
// explícito no depende de ninguna librería adicional.
const TIME_ZONE = "America/Mexico_City";

const dateTimeFormatter = new Intl.DateTimeFormat("es-MX", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const dateFormatter = new Intl.DateTimeFormat("es-MX", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "short",
  day: "2-digit",
});

export function formatDateTimeMx(iso: string | null | undefined): string {
  if (!iso) return "Sin fecha";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Fecha inválida";
  return `${dateTimeFormatter.format(date)} (CDMX)`;
}

export function formatDateMx(iso: string | null | undefined): string {
  if (!iso) return "Sin fecha";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Fecha inválida";
  return dateFormatter.format(date);
}

/** Fecha de hoy en CDMX, formato corto ("10 sept 2026") — para la píldora de fecha del header (ver PanelHeaderActions). */
export function formatTodayMx(): string {
  return dateFormatter.format(new Date());
}

/** Días restantes hasta `iso` (redondeado hacia arriba), o `null` si no hay fecha. Negativo si ya pasó. */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const diffMs = date.getTime() - Date.now();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}
