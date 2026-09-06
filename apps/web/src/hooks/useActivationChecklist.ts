// Checklist de activación (ronda 7, docs/investigacion/salida-promocion-referencias.md:
// "checklist por hechos reales", nunca casillas que se marcan solas). Cada
// ítem se calcula leyendo un endpoint real ya existente -- ninguno es un
// flag inventado ni queda en localStorage salvo donde se documenta la
// excepción abajo.
import { useAuth } from "@/hooks/useAuth";
import { useCompanyProfile, useDocuments, useRates } from "@/hooks/useCompany";
import { useTenders } from "@/hooks/useTenders";
import { useTwoFactorStatus } from "@/hooks/useTwoFactor";

export interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
  /** Ruta del módulo donde se completa este paso. */
  href: string;
}

export interface ActivationChecklist {
  items: ChecklistItem[];
  completedCount: number;
  totalCount: number;
  isLoading: boolean;
  isError: boolean;
}

export function useActivationChecklist(): ActivationChecklist {
  const { currentOrgId } = useAuth();
  const profile = useCompanyProfile();
  const documents = useDocuments();
  const rates = useRates();
  const tenders = useTenders({ limit: 1 });
  const twoFactor = useTwoFactorStatus();

  const queries = [profile, documents, rates, tenders, twoFactor];
  const isLoading = Boolean(currentOrgId) && queries.some((q) => q.isLoading);
  const isError = queries.some((q) => q.isError);

  const items: ChecklistItem[] = [
    {
      id: "perfil",
      label: "Perfil de empresa completo (razón social y RFC)",
      done: Boolean(profile.data?.legalName && profile.data?.taxId),
      href: "/empresa/perfil-capacidades",
    },
    {
      id: "documento",
      label: "Al menos un documento vigente",
      done: Boolean(documents.data?.some((doc) => doc.status === "valid")),
      href: "/empresa/documentos-vigencias",
    },
    {
      id: "tarifa",
      label: "Al menos una tarifa aprobada",
      done: Boolean(rates.data?.some((rate) => rate.status === "approved")),
      href: "/empresa/tarifas-aprobadas",
    },
    {
      id: "convocatoria",
      // Nota honesta: apps/api no expone ningún endpoint de "convocatoria
      // vista" (se revisó el listado completo de rutas de tenders, ver
      // apps/api/README.md) -- no hay forma de registrar una vista real sin
      // agregarlo ahí (fuera del alcance de esta ronda, solo apps/web). En
      // vez de inventar un flag local (localStorage) que no sería un
      // "hecho real" leído de la API, este ítem usa el hecho real más
      // cercano que SÍ expone la API: que el descubrimiento ya te haya
      // mostrado al menos una convocatoria disponible para revisar.
      label: "Primera convocatoria disponible para revisar",
      done: Boolean(tenders.data?.items && tenders.data.items.length > 0),
      href: "/convocatorias/descubrimiento",
    },
    {
      id: "2fa",
      label: "Verificación en dos pasos (2FA) activa",
      done: Boolean(twoFactor.data?.enrolled),
      href: "/configuracion",
    },
  ];

  return {
    items,
    completedCount: items.filter((item) => item.done).length,
    totalCount: items.length,
    isLoading,
    isError,
  };
}
