import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry, type ToolDefinition } from "../src/tool-registry.js";
import { MissingActionKindError, ToolNotFoundError, ToolValidationError, UnauthorizedToolInputError } from "../src/errors.js";
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
});
