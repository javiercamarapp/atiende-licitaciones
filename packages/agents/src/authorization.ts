import type { ActionKind, AuthorizationDecision, Role, RiskLevel } from "./types.js";
import { RISK_LEVEL_ORDER } from "./types.js";
import { InvalidRoleCeilingError } from "./errors.js";

/**
 * AG-04: `Object.freeze()` sobre un `Set` NO impide `.add()`/`.delete()`/
 * `.clear()` — el freeze solo congela las propiedades propias del objeto,
 * pero los métodos de `Set` operan sobre un slot interno que `freeze` no
 * toca. Este `Proxy` es la única forma de hacer que un `Set` exportado sea
 * REALMENTE inmutable en runtime: intercepta las 3 mutaciones y lanza,
 * mientras deja pasar `has`/`values`/iteración/`size` sin cambios.
 */
function freezeSet<T>(source: Iterable<T>): ReadonlySet<T> {
  const target = new Set(source);
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === "add" || prop === "delete" || prop === "clear") {
        return () => {
          throw new Error(
            "Este Set es una constante congelada del núcleo de seguridad y no se puede modificar en runtime " +
              "(AG-04): usa las opciones del constructor de AuthorizationPolicy para AÑADIR entradas.",
          );
        };
      }
      const value = Reflect.get(obj, prop, obj);
      return typeof value === "function" ? value.bind(obj) : value;
    },
  }) as ReadonlySet<T>;
}

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
export const DEFAULT_HARD_PROHIBITED_ACTIONS: ReadonlySet<string> = freezeSet([
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
export const DEFAULT_PROHIBITED_ACTIONS: ReadonlySet<string> = freezeSet([
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

/**
 * Normaliza un nombre de herramienta para comparación (AG-02): NFKC +
 * minúsculas + elimina separadores comunes (`_ - . ` espacio). Esto hace
 * que variantes de mayúsculas/separadores del MISMO nombre ASCII
 * (`Sign_Document`, `SIGN-DOCUMENT`, `sign document`) coincidan con el
 * nombre canónico en la lista de prohibiciones duras. No pretende resolver
 * homoglifos entre alfabetos distintos (p. ej. cirílico/latino, que NFKC no
 * unifica porque son códigos distintos, no formas de compatibilidad del
 * mismo carácter) — esa vía se cierra en origen exigiendo nombres ASCII
 * puros en `ToolRegistry.register()` (ver `InvalidToolNameError`).
 */
export function normalizeToolName(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[\s_.-]+/g, "");
}

function normalizedSet(values: Iterable<string>): ReadonlySet<string> {
  const result = new Set<string>();
  for (const value of values) result.add(normalizeToolName(value));
  // AG-18: mismo tratamiento que unionWithDefaults — la versión normalizada
  // por-instancia (la que `decide()` realmente consulta) tampoco puede ser
  // un Set mutable plano.
  return freezeSet(result);
}

/**
 * Fusiona defaults congelados con adiciones del llamador SIN NUNCA reducir
 * el resultado por debajo del default (AG-03): siempre unión, nunca
 * reemplazo, sin importar qué iterable llegue en `additions` (incluida una
 * lista vacía).
 */
function unionWithDefaults(defaults: ReadonlySet<string>, additions?: Iterable<string>): ReadonlySet<string> {
  const result = new Set(defaults);
  if (additions) {
    for (const item of additions) result.add(item);
  }
  // AG-18: el Set por-instancia resultante de la unión también debe ser
  // realmente inmutable en runtime, no solo el default de módulo que
  // AG-04 protegió — de lo contrario una referencia a la instancia puede
  // `.delete()`/`.clear()` una prohibición vía reflexión sobre el campo
  // `private` (protección solo de compilación en TypeScript).
  return freezeSet(result);
}

/**
 * AG-17 (ALTA, REQ-062): valida el `roleCeiling` que llega por opciones del
 * constructor contra el default (`ROLE_RISK_CEILING`) y devuelve el
 * resultado fusionado — pero a diferencia de un `{ ...default, ...override }`
 * ingenuo (el bug original), aquí un override que SUBIRÍA el techo de
 * cualquier rol por encima de su default lanza `InvalidRoleCeilingError`
 * en vez de aplicarse. Bajar el techo (hacerlo más restrictivo) sí se
 * permite libremente. Como `consultor_externo` ya tiene el default más bajo
 * posible (`read`, orden 0), esto lo vuelve un techo verdaderamente
 * invariante: la ÚNICA forma de "override" que no lanza para ese rol es
 * pasar exactamente `"read"` de nuevo, nunca nada por encima.
 */
function clampRoleCeiling(overrides?: Partial<Record<Role, RiskLevel>>): Record<Role, RiskLevel> {
  const result: Record<Role, RiskLevel> = { ...ROLE_RISK_CEILING };
  if (!overrides) return result;
  for (const role of Object.keys(overrides) as Role[]) {
    const override = overrides[role];
    if (override === undefined) continue;
    const defaultCeiling = ROLE_RISK_CEILING[role];
    if (defaultCeiling === undefined) continue; // rol desconocido fuera del enum Role: se ignora, no puede inventar un rol nuevo.
    if (RISK_LEVEL_ORDER[override] > RISK_LEVEL_ORDER[defaultCeiling]) {
      throw new InvalidRoleCeilingError(role, override, defaultCeiling);
    }
    result[role] = override;
  }
  return result;
}

export interface AuthorizationRequest {
  toolName: string;
  riskLevel: RiskLevel;
  actorRole: Role;
  /** Override por-herramienta desde el `ToolDefinition.requiresAuthorization`. */
  requiresAuthorizationForRole?: boolean;
  /**
   * Categoría semántica real de la herramienta (`ToolDefinition.actionKind`,
   * AG-01). Cuando está presente y pertenece a
   * `HARD_PROHIBITED_ACTION_KINDS`, se deniega como prohibición dura sin
   * importar el nombre de la herramienta. Opcional aquí (para no romper
   * llamadores directos de `AuthorizationPolicy` fuera de `AgentRunner`),
   * pero `ToolRegistry.register()` lo exige siempre, así que todo lo que
   * pasa por `AgentRunner` siempre lo trae.
   */
  actionKind?: ActionKind;
}

export interface AuthorizationResult {
  decision: AuthorizationDecision;
  reason: string;
}

/**
 * Categorías de `ActionKind` que SIEMPRE son prohibición dura (REQ-165),
 * sin importar el nombre de la herramienta ni el rol (AG-01). A diferencia
 * de `DEFAULT_HARD_PROHIBITED_ACTIONS` (por nombre, ampliable pero nunca
 * reducible — ver AG-03), esta lista NO tiene ninguna opción de
 * constructor: es un enum cerrado fijo, no inyectable de ninguna forma.
 */
const HARD_PROHIBITED_ACTION_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "external_send",
  "sign",
  "portal_action",
  "contact_third_party",
]);

export class AuthorizationPolicy {
  private readonly hardProhibitedActions: ReadonlySet<string>;
  private readonly normalizedHardProhibitedActions: ReadonlySet<string>;
  private readonly prohibitedActions: ReadonlySet<string>;
  private readonly normalizedProhibitedActions: ReadonlySet<string>;
  private readonly roleCeiling: Readonly<Record<Role, RiskLevel>>;

  constructor(options?: {
    /** Herramientas ADICIONALES a tratar como prohibidas blandas. Nunca reemplaza `DEFAULT_PROHIBITED_ACTIONS` (AG-03). */
    prohibitedActions?: Iterable<string>;
    /** Herramientas ADICIONALES a tratar como prohibición dura. Nunca reemplaza `DEFAULT_HARD_PROHIBITED_ACTIONS` (AG-03). */
    hardProhibitedActions?: Iterable<string>;
    roleCeiling?: Partial<Record<Role, RiskLevel>>;
  }) {
    // INVARIANTE DE CÓDIGO (AG-03, REQ-165): las prohibiciones duras y
    // blandas por defecto nunca son reemplazables desde configuración de
    // constructor ni de tenant — solo se puede AÑADIR a ellas. Pasar `[]` (o
    // cualquier iterable, vacío o no) jamás reduce el conjunto resultante
    // por debajo de los defaults: siempre es una UNIÓN, nunca una asignación.
    this.prohibitedActions = unionWithDefaults(DEFAULT_PROHIBITED_ACTIONS, options?.prohibitedActions);
    this.hardProhibitedActions = unionWithDefaults(DEFAULT_HARD_PROHIBITED_ACTIONS, options?.hardProhibitedActions);
    // AG-02: además del Set exacto (compatibilidad/introspección), se
    // guarda una versión normalizada (NFKC + minúsculas + sin separadores)
    // para que decide() nunca compare nombres crudos sin normalizar.
    this.normalizedProhibitedActions = normalizedSet(this.prohibitedActions);
    this.normalizedHardProhibitedActions = normalizedSet(this.hardProhibitedActions);
    // AG-17 (ALTA, REQ-062): `roleCeiling` solo puede BAJAR (hacer más
    // restrictivo) el techo por defecto de un rol, nunca subirlo. A
    // diferencia de `hardProhibitedActions`/`prohibitedActions` (AG-03,
    // unión-nunca-reemplazo), aquí "unión" no tendría sentido porque el
    // dominio es un orden total (RiskLevel), no un conjunto — así que la
    // invariante correcta es "nunca por encima del default" y se hace
    // cumplir lanzando en el constructor, no clampeando en silencio: un
    // llamador que intenta subir el techo de cualquier rol (en particular
    // `consultor_externo`, el único capado en `read` por REQ-062: "nunca
    // 2/2") debe enterarse de inmediato, no obtener silenciosamente un
    // techo distinto al que pidió.
    this.roleCeiling = Object.freeze(clampRoleCeiling(options?.roleCeiling));
    // AG-18: congela también la instancia completa — así, además de que los
    // propios `Set`s son inmutables vía `freezeSet()`, ninguno de estos
    // campos puede REASIGNARSE por reflexión (`(policy as any).campo = x`)
    // saltándose el constructor. `readonly` de TypeScript es una
    // protección solo de compilación; `Object.freeze(this)` es la que
    // realmente falla en runtime (los módulos ES siempre corren en modo
    // estricto, así que una asignación a una propiedad congelada lanza
    // `TypeError`, no falla en silencio).
    Object.freeze(this);
  }

  decide(request: AuthorizationRequest): AuthorizationResult {
    // AG-01: clasificación por actionKind semántico PRIMERO — no depende en
    // absoluto del nombre de la herramienta, así que un alias/sinónimo con
    // nombre inocuo (p. ej. "enviar_paquete_final_al_comprador") no puede
    // evadir la prohibición si su actionKind real es
    // external_send/sign/portal_action/contact_third_party.
    if (request.actionKind && HARD_PROHIBITED_ACTION_KINDS.has(request.actionKind)) {
      return { decision: "denied", reason: "prohibicion_dura_por_actionKind_solo_humano_fuera_del_sistema" };
    }

    // Prohibiciones duras por nombre, sin importar el rol: ni superadmin
    // puede hacer que el sistema ejecute esto automáticamente. Nunca son
    // "pending" — no hay ruta de aprobación dentro del sistema para ellas.
    // AG-02: se compara la forma NORMALIZADA (NFKC + minúsculas + sin
    // separadores) del nombre, no el string crudo — así "Sign_Document",
    // "SIGN-DOCUMENT" o "sign document" coinciden con "sign_document".
    const normalizedToolName = normalizeToolName(request.toolName);
    if (this.normalizedHardProhibitedActions.has(normalizedToolName)) {
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

    if (this.normalizedProhibitedActions.has(normalizedToolName)) {
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
