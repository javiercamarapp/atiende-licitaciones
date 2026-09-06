import type { AuthorizationDecision, Role, RiskLevel } from "./types.js";
import { RISK_LEVEL_ORDER } from "./types.js";

/**
 * Acciones "duras": ni siquiera pasan por HITL dentro del sistema. Por
 * docs/AMPLIACION-BACKOFFICE.md §6-8 y REQ-045/REQ-046: presentar/enviar
 * ofertas, firmar o suplantar firma, actuar en portales oficiales y
 * contactar terceros SIEMPRE se deniegan para ejecución automática — nunca
 * llegan a `pending`. Solo el usuario humano puede realizarlas, y siempre
 * *fuera* del sistema (subir el acuse a mano, firmar en su propio
 * dispositivo, etc.). Esta lista no es configurable por tenant y ningún rol
 * —incluido `superadmin`/`system`— puede saltarla: se evalúa antes que el
 * techo de riesgo por rol y antes que las acciones "blandas" prohibidas.
 */
export const DEFAULT_HARD_PROHIBITED_ACTIONS: ReadonlySet<string> = new Set([
  "submit_proposal_to_portal",
  "submit_proposal_to_comprasmx",
  "send_proposal_externally",
  "sign_document",
  "sign_manifest",
  "impersonate_signature",
  "act_on_official_portal",
  "upload_to_comprasmx",
  "contact_third_party",
  "contact_public_official",
  "contact_competitor",
]);

/**
 * Acciones "blandas" prohibidas para `always_approve` (REQ-044/REQ-068):
 * requieren HITL (`pending`) sin importar el rol, pero — a diferencia de las
 * duras — el sistema sí puede ejecutarlas una vez que un humano con el rol
 * correcto aprueba explícitamente vía `AgentRunner.resume()`.
 */
export const DEFAULT_PROHIBITED_ACTIONS: ReadonlySet<string> = new Set([
  "make_payment",
  "set_final_price",
  "issue_final_package",
]);

/**
 * Techo de riesgo que un rol puede *disparar*, ya sea en modo `auto` o
 * solicitando `pending` (un humano sigue aprobando cualquier `pending`, así
 * que el techo no es sobre ejecución automática sino sobre qué tan lejos
 * puede llegar el flujo que ese rol inicia). Por encima del techo, la
 * solicitud se `denied` de inmediato, sin llegar siquiera a HITL.
 *
 * `consultor_externo` nunca participa en aprobaciones 2/2 (REQ-062): es el
 * único rol con techo `read` — ni siquiera puede *pedir* algo de riesgo
 * mayor, a diferencia del resto de roles operativos, que sí pueden solicitar
 * hasta `irreversible` (quedando en `pending` para que un humano con el rol
 * correcto decida). El techo nunca deja pasar una prohibición dura: esas se
 * evalúan primero e ignoran el rol por completo.
 */
const ROLE_RISK_CEILING: Record<Role, RiskLevel> = {
  director: "irreversible",
  licitador: "irreversible",
  legal: "irreversible",
  finanzas: "irreversible",
  representante_legal: "irreversible",
  consultor_externo: "read",
  system: "irreversible",
  superadmin: "irreversible",
};

export interface AuthorizationRequest {
  toolName: string;
  riskLevel: RiskLevel;
  actorRole: Role;
  /** Override por-herramienta desde el `ToolDefinition.requiresAuthorization`. */
  requiresAuthorizationForRole?: boolean;
}

export interface AuthorizationResult {
  decision: AuthorizationDecision;
  reason: string;
}

export class AuthorizationPolicy {
  private readonly hardProhibitedActions: Set<string>;
  private readonly prohibitedActions: Set<string>;
  private readonly roleCeiling: Record<Role, RiskLevel>;

  constructor(options?: {
    prohibitedActions?: Iterable<string>;
    hardProhibitedActions?: Iterable<string>;
    roleCeiling?: Partial<Record<Role, RiskLevel>>;
  }) {
    this.prohibitedActions = new Set(options?.prohibitedActions ?? DEFAULT_PROHIBITED_ACTIONS);
    this.hardProhibitedActions = new Set(options?.hardProhibitedActions ?? DEFAULT_HARD_PROHIBITED_ACTIONS);
    this.roleCeiling = { ...ROLE_RISK_CEILING, ...options?.roleCeiling };
  }

  decide(request: AuthorizationRequest): AuthorizationResult {
    // Prohibiciones duras primero, sin importar el rol: ni superadmin puede
    // hacer que el sistema ejecute esto automáticamente. Nunca son
    // "pending" — no hay ruta de aprobación dentro del sistema para ellas.
    if (this.hardProhibitedActions.has(request.toolName)) {
      return { decision: "denied", reason: "prohibicion_dura_solo_humano_fuera_del_sistema" };
    }

    const ceiling = this.roleCeiling[request.actorRole];

    // El techo de riesgo del rol manda antes que las prohibiciones blandas:
    // un rol sin permiso para cierto nivel de riesgo se deniega sin importar
    // si la acción está o no en la lista de prohibidas blandas (evita que
    // "system"/"director" cuelen algo que un consultor_externo jamás
    // debería poder ni pedir).
    if (RISK_LEVEL_ORDER[request.riskLevel] > RISK_LEVEL_ORDER[ceiling]) {
      return {
        decision: "denied",
        reason: `rol_sin_permiso_de_riesgo:${request.actorRole}:${request.riskLevel}`,
      };
    }

    if (this.prohibitedActions.has(request.toolName)) {
      return { decision: "pending", reason: "accion_prohibida_siempre_requiere_humano" };
    }

    if (request.riskLevel === "irreversible") {
      return { decision: "pending", reason: "riesgo_irreversible_requiere_humano" };
    }

    if (request.riskLevel === "external") {
      return { decision: "pending", reason: "riesgo_externo_requiere_humano" };
    }

    if (request.requiresAuthorizationForRole) {
      return { decision: "pending", reason: "politica_especifica_de_herramienta_requiere_humano" };
    }

    return { decision: "auto", reason: "riesgo_dentro_del_permiso_del_rol" };
  }
}
