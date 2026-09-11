import { Check, Sparkles } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { useOnboardingState } from "@/hooks/useOnboarding";
import type { OnboardingFieldId } from "@/lib/api/schemas";

/**
 * Patrón Likida/atiende.ai #7 (onboarding conversacional con guardas
 * deterministas): CAPA conversacional sobre el wizard de
 * `OnboardingPage.tsx` -- no lo reemplaza ni cambia su lógica de pasos
 * (sigue siendo la forma REAL de capturar cada dato); esta tira solo
 * muestra, en lenguaje natural, qué falta y por qué el onboarding no puede
 * darse por terminado todavía. Todo el contenido viene de
 * `GET /onboarding/state` (apps/api), que a su vez calcula la GUARDA
 * determinista en `packages/agents/src/onboarding.ts` -- este componente
 * NUNCA decide por sí mismo si algo falta, solo refleja lo que el backend
 * ya decidió.
 */

const REQUIRED_FIELD_LABELS: Record<"organization" | "legalName" | "taxId" | "sector", string> = {
  organization: "Organización",
  legalName: "Razón social",
  taxId: "RFC",
  sector: "Giro",
};

const REQUIRED_FIELD_ORDER: readonly (keyof typeof REQUIRED_FIELD_LABELS)[] = ["organization", "legalName", "taxId", "sector"];

function isRequiredField(field: OnboardingFieldId): field is keyof typeof REQUIRED_FIELD_LABELS {
  return field in REQUIRED_FIELD_LABELS;
}

export function OnboardingAssistant() {
  const { data, isLoading, isError } = useOnboardingState();

  // Silencioso ante carga/error: el wizard de abajo sigue funcionando
  // igual de bien sin esta capa -- nunca es un bloqueo, solo un
  // complemento. Un error real de red ya se ve reflejado en cada paso del
  // wizard por su propio `toast.error`.
  if (isLoading || isError || !data) return null;

  const missingRequired = new Set(data.missingRequired.filter(isRequiredField));

  return (
    <Card className="mb-6 border-primary/30 bg-primary/5" data-testid="onboarding-assistant">
      <CardContent className="flex items-start gap-3 p-4">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Sparkles className="h-4 w-4" aria-hidden="true" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">{data.question}</p>
          <ul aria-label="Datos obligatorios del onboarding" className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
            {REQUIRED_FIELD_ORDER.map((field) => {
              const done = !missingRequired.has(field);
              return (
                <li key={field} className={`flex items-center gap-1.5 ${done ? "text-success" : "text-muted-foreground"}`}>
                  <span
                    className={`flex h-4 w-4 items-center justify-center rounded-full ${done ? "bg-success/15" : "bg-muted"}`}
                    aria-hidden="true"
                  >
                    {done && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                  </span>
                  {REQUIRED_FIELD_LABELS[field]}
                </li>
              );
            })}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
