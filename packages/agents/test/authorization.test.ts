import { describe, expect, it } from "vitest";
import { AuthorizationPolicy, DEFAULT_HARD_PROHIBITED_ACTIONS, DEFAULT_PROHIBITED_ACTIONS } from "../src/authorization.js";
import type { Role } from "../src/types.js";

describe("AuthorizationPolicy", () => {
  it("autoriza automáticamente riesgo read/write dentro del techo del rol", () => {
    const policy = new AuthorizationPolicy();
    expect(policy.decide({ toolName: "list_tenders", riskLevel: "read", actorRole: "consultor_externo" }).decision).toBe("auto");
    expect(policy.decide({ toolName: "update_matrix", riskLevel: "write", actorRole: "licitador" }).decision).toBe("auto");
  });

  it("deniega a un rol que excede su techo de riesgo", () => {
    const policy = new AuthorizationPolicy();
    const result = policy.decide({ toolName: "update_matrix", riskLevel: "write", actorRole: "consultor_externo" });
    expect(result.decision).toBe("denied");
    expect(result.reason).toContain("rol_sin_permiso_de_riesgo");
  });

  it("consultor_externo nunca participa en aprobaciones 2/2: cualquier riesgo por encima de read se deniega", () => {
    const policy = new AuthorizationPolicy();
    for (const riskLevel of ["write", "external", "irreversible"] as const) {
      const result = policy.decide({ toolName: "cualquier_tool", riskLevel, actorRole: "consultor_externo" });
      expect(result.decision).toBe("denied");
    }
  });

  it("riesgo irreversible siempre queda pending sin importar el rol (salvo prohibición dura)", () => {
    const policy = new AuthorizationPolicy();
    for (const actorRole of ["director", "finanzas", "legal", "representante_legal", "system", "superadmin"] as Role[]) {
      const result = policy.decide({ toolName: "irreversible_tool", riskLevel: "irreversible", actorRole });
      expect(result.decision).toBe("pending");
    }
  });

  it("riesgo external siempre queda pending", () => {
    const policy = new AuthorizationPolicy();
    const result = policy.decide({ toolName: "notify_authority", riskLevel: "external", actorRole: "director" });
    expect(result.decision).toBe("pending");
  });

  it("las acciones blandas prohibidas (DEFAULT_PROHIBITED_ACTIONS) siempre quedan pending, nunca auto", () => {
    const policy = new AuthorizationPolicy();
    for (const toolName of DEFAULT_PROHIBITED_ACTIONS) {
      const result = policy.decide({ toolName, riskLevel: "write", actorRole: "director" });
      expect(result.decision).toBe("pending");
    }
  });

  it("politica especifica de herramienta (requiresAuthorizationForRole) fuerza pending incluso en riesgo write", () => {
    const policy = new AuthorizationPolicy();
    const result = policy.decide({
      toolName: "custom_tool",
      riskLevel: "write",
      actorRole: "licitador",
      requiresAuthorizationForRole: true,
    });
    expect(result.decision).toBe("pending");
  });

  describe("prohibiciones duras (docs/AMPLIACION-BACKOFFICE.md §6-8)", () => {
    it("las prohibiciones duras siempre son denied, nunca pending, para cualquier rol incluido superadmin", () => {
      const policy = new AuthorizationPolicy();
      const allRoles: Role[] = [
        "director",
        "licitador",
        "legal",
        "finanzas",
        "consultor_externo",
        "representante_legal",
        "system",
        "superadmin",
      ];
      for (const toolName of DEFAULT_HARD_PROHIBITED_ACTIONS) {
        for (const actorRole of allRoles) {
          const result = policy.decide({ toolName, riskLevel: "read", actorRole });
          expect(result.decision, `${toolName} con rol ${actorRole}`).toBe("denied");
          expect(result.reason).toBe("prohibicion_dura_solo_humano_fuera_del_sistema");
        }
      }
    });

    it("superadmin con el techo de riesgo más alto sigue sin poder ejecutar una prohibición dura", () => {
      const policy = new AuthorizationPolicy();
      const result = policy.decide({ toolName: "sign_document", riskLevel: "irreversible", actorRole: "superadmin" });
      expect(result.decision).toBe("denied");
    });

    it("una prohibición dura personalizada también se deniega sin importar el rol", () => {
      const policy = new AuthorizationPolicy({ hardProhibitedActions: ["custom_hard_action"] });
      const result = policy.decide({ toolName: "custom_hard_action", riskLevel: "write", actorRole: "director" });
      expect(result.decision).toBe("denied");
    });

    it("AG-03 (CRÍTICA, invariante de código): pasar hardProhibitedActions: [] NO desactiva ninguna de las prohibiciones duras por defecto — el constructor solo une, nunca reemplaza", () => {
      const policy = new AuthorizationPolicy({ hardProhibitedActions: [] });
      for (const toolName of DEFAULT_HARD_PROHIBITED_ACTIONS) {
        const result = policy.decide({ toolName, riskLevel: "read", actorRole: "superadmin" });
        expect(result.decision, `${toolName} debería seguir denied tras pasar []`).toBe("denied");
      }
    });

    it("AG-03: pasar un Set completo de reemplazo tampoco sustituye los defaults, solo se unen", () => {
      const policy = new AuthorizationPolicy({ hardProhibitedActions: new Set(["otra_accion_custom"]) });
      // El default sigue prohibido...
      expect(policy.decide({ toolName: "sign_document", riskLevel: "read", actorRole: "superadmin" }).decision).toBe(
        "denied",
      );
      // ...y la nueva se agrega, no reemplaza.
      expect(policy.decide({ toolName: "otra_accion_custom", riskLevel: "read", actorRole: "superadmin" }).decision).toBe(
        "denied",
      );
    });

    it("AG-03: lo mismo aplica a las prohibiciones blandas (prohibitedActions) — [] no las vacía", () => {
      const policy = new AuthorizationPolicy({ prohibitedActions: [] });
      for (const toolName of DEFAULT_PROHIBITED_ACTIONS) {
        const result = policy.decide({ toolName, riskLevel: "write", actorRole: "director" });
        expect(result.decision).toBe("pending");
      }
    });

    it("cubre las 4 categorías del flujo: enviar/presentar ofertas, firmar, actuar en portales, contactar terceros", () => {
      const policy = new AuthorizationPolicy();
      const categories = [
        "submit_proposal_to_comprasmx",
        "sign_document",
        "act_on_official_portal",
        "contact_third_party",
      ];
      for (const toolName of categories) {
        expect(DEFAULT_HARD_PROHIBITED_ACTIONS.has(toolName)).toBe(true);
        expect(policy.decide({ toolName, riskLevel: "write", actorRole: "director" }).decision).toBe("denied");
      }
    });

    it("AG-01 (ALTA): un actionKind prohibido deniega SIN IMPORTAR el nombre de la herramienta (alias/sinónimo)", () => {
      const policy = new AuthorizationPolicy();
      // Nombre completamente inocuo, no listado en DEFAULT_HARD_PROHIBITED_ACTIONS,
      // pero cuya categoría semántica real es "enviar oferta al comprador".
      const result = policy.decide({
        toolName: "enviar_paquete_final_al_comprador",
        riskLevel: "read",
        actorRole: "superadmin",
        actionKind: "external_send",
      });
      expect(result.decision).toBe("denied");
    });

    it("AG-01: cubre las 4 categorías de actionKind prohibido con un nombre inocuo cualquiera", () => {
      const policy = new AuthorizationPolicy();
      const prohibitedKinds = ["external_send", "sign", "portal_action", "contact_third_party"] as const;
      for (const actionKind of prohibitedKinds) {
        const result = policy.decide({
          toolName: "nombre_totalmente_inocuo_sin_relacion",
          riskLevel: "read",
          actorRole: "superadmin",
          actionKind,
        });
        expect(result.decision, `actionKind ${actionKind}`).toBe("denied");
      }
    });

    it("AG-01: actionKind read/write/payment con nombre inocuo NO se ve afectado por la prohibición dura por categoría", () => {
      const policy = new AuthorizationPolicy();
      for (const actionKind of ["read", "write"] as const) {
        const result = policy.decide({
          toolName: "nombre_totalmente_inocuo_sin_relacion",
          riskLevel: "read",
          actorRole: "director",
          actionKind,
        });
        expect(result.decision).toBe("auto");
      }
    });
  });
});
