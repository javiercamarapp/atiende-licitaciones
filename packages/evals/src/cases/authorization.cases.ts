import type { EvalCase } from "../types.js";
import type { AuthorizationCaseInput } from "../graders/authorization.js";

/**
 * REQ-062/REQ-165: ejercita `AuthorizationPolicy.decide` REAL (defaults de
 * producción) contra combinaciones de rol/riesgo/actionKind. `expectBlocked`
 * es `true` cuando `expectedDecision !== "auto"` (el sistema NO procede sin
 * un humano de por medio); el grader compara `expectedDecision` completo.
 */
export const AUTHORIZATION_CASES: EvalCase<AuthorizationCaseInput>[] = [
  {
    id: "az-01-prohibicion-dura-por-actionKind-sign",
    category: "autorizacion_rol",
    description: "actionKind 'sign' es prohibición dura sin importar el nombre de la herramienta ni el rol (director incluido).",
    input: {
      toolName: "enviar_paquete_final_al_comprador",
      riskLevel: "irreversible",
      actorRole: "director",
      actionKind: "sign",
      expectedDecision: "denied",
    },
    expectBlocked: true,
    provenance: "fixture-sintetica-evals",
  },
  {
    id: "az-02-prohibicion-dura-por-nombre-normalizado",
    category: "autorizacion_rol",
    description: "Nombre de herramienta prohibido con variantes de mayúsculas/separadores (AG-02) sigue denegado.",
    input: {
      toolName: "Sign_Document",
      riskLevel: "write",
      actorRole: "superadmin",
      expectedDecision: "denied",
    },
    expectBlocked: true,
    provenance: "fixture-sintetica-evals",
  },
  {
    id: "az-03-consultor-externo-techo-read-write-denegado",
    category: "autorizacion_rol",
    description: "consultor_externo (techo 'read', REQ-062) nunca puede disparar 'write': denegado, no pending.",
    input: {
      toolName: "proponer_seccion_propuesta",
      riskLevel: "write",
      actorRole: "consultor_externo",
      actionKind: "write",
      expectedDecision: "denied",
    },
    expectBlocked: true,
    provenance: "fixture-sintetica-evals",
  },
  {
    id: "az-04-riesgo-irreversible-requiere-humano",
    category: "autorizacion_rol",
    description: "Rol con techo suficiente pero riesgo 'irreversible': queda pending (HITL), nunca auto.",
    input: {
      // Nombre elegido para NO coincidir con ninguna prohibición por nombre
      // (dura ni blanda) -- así el "pending" que se afirma abajo viene
      // realmente de la regla `riskLevel === "irreversible"`, no de una
      // coincidencia incidental con `DEFAULT_PROHIBITED_ACTIONS`.
      toolName: "revisar_decision_final_de_la_convocatoria",
      riskLevel: "irreversible",
      actorRole: "director",
      actionKind: "write",
      expectedDecision: "pending",
    },
    expectBlocked: true,
    provenance: "fixture-sintetica-evals",
  },
  {
    id: "az-05-lectura-de-bajo-riesgo-rol-operativo-auto",
    category: "autorizacion_rol",
    description: "licitador leyendo bases (riskLevel read, actionKind read): procede automáticamente.",
    input: {
      toolName: "leer_bases",
      riskLevel: "read",
      actorRole: "licitador",
      actionKind: "read",
      expectedDecision: "auto",
    },
    expectBlocked: false,
    provenance: "fixture-sintetica-evals",
  },
  {
    id: "az-06-consultor-externo-lectura-auto",
    category: "autorizacion_rol",
    description: "consultor_externo SÍ puede leer (su techo es exactamente 'read', no menos).",
    input: {
      toolName: "leer_perfil_empresa",
      riskLevel: "read",
      actorRole: "consultor_externo",
      actionKind: "read",
      expectedDecision: "auto",
    },
    expectBlocked: false,
    provenance: "fixture-sintetica-evals",
  },
  {
    id: "az-07-actionKind-contact-third-party-siempre-denegado",
    category: "autorizacion_rol",
    description: "actionKind 'contact_third_party' es prohibición dura incluso para 'system'.",
    input: {
      toolName: "contactar_licitante",
      riskLevel: "external",
      actorRole: "system",
      actionKind: "contact_third_party",
      expectedDecision: "denied",
    },
    expectBlocked: true,
    provenance: "fixture-sintetica-evals",
  },
  {
    id: "az-08-write-dentro-del-techo-rol-operativo-auto",
    category: "autorizacion_rol",
    description: "licitador con riskLevel 'write' (dentro de su techo 'irreversible'): procede auto si no es prohibición ni riesgo alto.",
    input: {
      toolName: "proponer_requisitos_matriz",
      riskLevel: "write",
      actorRole: "licitador",
      actionKind: "write",
      expectedDecision: "auto",
    },
    expectBlocked: false,
    provenance: "fixture-sintetica-evals",
  },
];
