import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry, type ToolDefinition } from "../src/tool-registry.js";
import {
  InvalidToolNameError,
  MissingActionKindError,
  ToolNotFoundError,
  ToolValidationError,
  UnauthorizedToolInputError,
} from "../src/errors.js";
import { ACTION_KINDS } from "../src/types.js";

function makeTool(overrides: Partial<ToolDefinition<any, any>> = {}): ToolDefinition<any, any> {
  return {
    name: "get_tender",
    description: "Obtiene una convocatoria por id",
    inputSchema: z.object({ tenderId: z.string() }),
    outputSchema: z.object({ title: z.string() }),
    riskLevel: "read",
    actionKind: "read",
    idempotent: true,
    tenantScoped: true,
    handler: async (input: { tenderId: string }) => ({ title: `convocatoria ${input.tenderId}` }),
    ...overrides,
  };
}

describe("ToolRegistry", () => {
  it("registra y recupera una herramienta por nombre", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool());
    expect(registry.has("get_tender")).toBe(true);
    expect(registry.get("get_tender").name).toBe("get_tender");
    expect(registry.list()).toHaveLength(1);
  });

  it("lanza ToolNotFoundError para una herramienta no registrada", () => {
    const registry = new ToolRegistry();
    expect(() => registry.get("no_existe")).toThrow(ToolNotFoundError);
  });

  it("valida los argumentos de entrada contra el esquema y los retorna parseados", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool());
    const parsed = registry.validateInput<{ tenderId: string }>("get_tender", { tenderId: "123" });
    expect(parsed).toEqual({ tenderId: "123" });
  });

  it("rechaza tool_calls cuyos argumentos no validan contra el esquema", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool());
    expect(() => registry.validateInput("get_tender", { tenderId: 123 })).toThrow(ToolValidationError);
    expect(() => registry.validateInput("get_tender", {})).toThrow(ToolValidationError);
    expect(() => registry.validateInput("get_tender", { tenderId: "1", extra: "no-declarado-pero-no-debe-tronar" })).not.toThrow();
  });

  it("valida la salida contra el esquema de salida", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool());
    expect(() => registry.validateOutput("get_tender", { title: "ok" })).not.toThrow();
    expect(() => registry.validateOutput("get_tender", { titulo: "campo equivocado" })).toThrow(ToolValidationError);
  });

  it("rechaza el registro si el esquema de entrada declara organizationId/tenant_id: el runtime siempre lo inyecta", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register(
        makeTool({
          name: "leaky_tool",
          inputSchema: z.object({ organizationId: z.string(), q: z.string() }),
        }),
      ),
    ).toThrow(UnauthorizedToolInputError);

    expect(() =>
      registry.register(
        makeTool({
          name: "leaky_tool_2",
          inputSchema: z.object({ tenant_id: z.string() }),
        }),
      ),
    ).toThrow(UnauthorizedToolInputError);

    expect(() =>
      registry.register(
        makeTool({
          name: "leaky_tool_3",
          inputSchema: z.object({ org_id: z.string() }),
        }),
      ),
    ).toThrow(UnauthorizedToolInputError);
  });

  it("AG-11 (MEDIA): rechaza organizationId/tenant_id/org_id anidado en cualquier profundidad, no solo el nivel raíz", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register(
        makeTool({
          name: "leaky_nested_1",
          inputSchema: z.object({ meta: z.object({ organizationId: z.string() }) }),
        }),
      ),
    ).toThrow(UnauthorizedToolInputError);

    expect(() =>
      registry.register(
        makeTool({
          name: "leaky_nested_2",
          inputSchema: z.object({ filtro: z.object({ avanzado: z.object({ tenant_id: z.string() }) }) }),
        }),
      ),
    ).toThrow(UnauthorizedToolInputError);

    expect(() =>
      registry.register(
        makeTool({
          name: "leaky_nested_optional",
          inputSchema: z.object({ meta: z.object({ org_id: z.string() }).optional() }),
        }),
      ),
    ).toThrow(UnauthorizedToolInputError);
  });

  it("AG-11: permite objetos anidados legítimos sin campos de tenant en ningún nivel", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register(
        makeTool({
          name: "nested_legit",
          inputSchema: z.object({ meta: z.object({ page: z.number(), filters: z.object({ q: z.string() }) }) }),
        }),
      ),
    ).not.toThrow();
  });

  it("permite esquemas de entrada sin campos de tenant", () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(makeTool())).not.toThrow();
  });

  describe("AG-01: actionKind obligatorio (REQ-165)", () => {
    it("rechaza el registro si la herramienta no declara actionKind", () => {
      const registry = new ToolRegistry();
      const toolWithoutActionKind = { ...makeTool(), actionKind: undefined } as unknown as ToolDefinition<any, any>;
      expect(() => registry.register(toolWithoutActionKind)).toThrow(MissingActionKindError);
    });

    it("rechaza el registro si actionKind no pertenece al enum cerrado", () => {
      const registry = new ToolRegistry();
      const toolWithBadActionKind = { ...makeTool(), actionKind: "hazlo_todo" } as unknown as ToolDefinition<any, any>;
      expect(() => registry.register(toolWithBadActionKind)).toThrow(MissingActionKindError);
    });

    it("acepta cualquier valor del enum cerrado de actionKind", () => {
      const registry = new ToolRegistry();
      for (const actionKind of ACTION_KINDS) {
        expect(() => registry.register(makeTool({ name: `tool_${actionKind}`, actionKind }))).not.toThrow();
      }
    });
  });

  describe("AG-02 (ALTA): nombres de herramienta ASCII snake_case estrictos (anti-homoglifo)", () => {
    it("rechaza un nombre con letra cirílica homógrafa de la 's' latina (U+0455)", () => {
      const registry = new ToolRegistry();
      // "ѕign_document": la primera letra es CYRILLIC SMALL LETTER DZE (U+0455), no la 's' latina.
      expect(() => registry.register(makeTool({ name: "ѕign_document" }))).toThrow(InvalidToolNameError);
    });

    it("rechaza un nombre con mayúsculas", () => {
      const registry = new ToolRegistry();
      expect(() => registry.register(makeTool({ name: "Sign_Document" }))).toThrow(InvalidToolNameError);
    });

    it("rechaza nombres con espacios, guiones o puntos", () => {
      const registry = new ToolRegistry();
      expect(() => registry.register(makeTool({ name: "sign document" }))).toThrow(InvalidToolNameError);
      expect(() => registry.register(makeTool({ name: "sign-document" }))).toThrow(InvalidToolNameError);
      expect(() => registry.register(makeTool({ name: "sign.document" }))).toThrow(InvalidToolNameError);
    });

    it("acepta nombres ASCII snake_case válidos", () => {
      const registry = new ToolRegistry();
      expect(() => registry.register(makeTool({ name: "sign_document_v2" }))).not.toThrow();
      expect(() => registry.register(makeTool({ name: "get_tender_123" }))).not.toThrow();
    });
  });
});
