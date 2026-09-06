import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry, type ToolDefinition } from "../src/tool-registry.js";
import {
  ForbiddenRuntimeInputFieldError,
  InvalidDeclaredEffectsError,
  InvalidToolNameError,
  MissingActionKindError,
  RuntimeArgsTooDeepError,
  SchemaTooDeepError,
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
    declaredEffects: ["read_only"],
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

  describe("AG-20 (MEDIA): findForbiddenFieldRecursive desciende en combinadores de Zod más allá de objeto/array/wrapper", () => {
    it("rechaza organizationId escondido en CUALQUIER rama de un z.union", () => {
      const registry = new ToolRegistry();
      expect(() =>
        registry.register(
          makeTool({
            name: "union_leaky",
            inputSchema: z.union([z.object({ foo: z.string() }), z.object({ organizationId: z.string() })]),
          }),
        ),
      ).toThrow(UnauthorizedToolInputError);
    });

    it("rechaza organizationId en una rama de un z.discriminatedUnion", () => {
      const registry = new ToolRegistry();
      expect(() =>
        registry.register(
          makeTool({
            name: "discriminated_union_leaky",
            inputSchema: z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("a"), foo: z.string() }),
              z.object({ kind: z.literal("b"), organizationId: z.string() }),
            ]),
          }),
        ),
      ).toThrow(UnauthorizedToolInputError);
    });

    it("rechaza organizationId dentro del tipo de valor de un z.record", () => {
      const registry = new ToolRegistry();
      expect(() =>
        registry.register(
          makeTool({
            name: "record_leaky",
            inputSchema: z.record(z.string(), z.object({ organizationId: z.string() })),
          }),
        ),
      ).toThrow(UnauthorizedToolInputError);
    });

    it("rechaza organizationId dentro del tipo de valor de un z.map", () => {
      const registry = new ToolRegistry();
      expect(() =>
        registry.register(
          makeTool({
            name: "map_leaky",
            inputSchema: z.object({ config: z.map(z.string(), z.object({ tenant_id: z.string() })) }),
          }),
        ),
      ).toThrow(UnauthorizedToolInputError);
    });

    it("rechaza organizationId dentro de un operando de z.intersection", () => {
      const registry = new ToolRegistry();
      expect(() =>
        registry.register(
          makeTool({
            name: "intersection_leaky",
            inputSchema: z.intersection(z.object({ foo: z.string() }), z.object({ organizationId: z.string() })),
          }),
        ),
      ).toThrow(UnauthorizedToolInputError);
    });

    it("rechaza organizationId dentro de un item posicional de z.tuple", () => {
      const registry = new ToolRegistry();
      expect(() =>
        registry.register(
          makeTool({
            name: "tuple_leaky",
            inputSchema: z.object({
              par: z.tuple([z.string(), z.object({ organizationId: z.string() })]),
            }),
          }),
        ),
      ).toThrow(UnauthorizedToolInputError);
    });

    it("rechaza organizationId dentro de un esquema auto-referenciado con z.lazy", () => {
      const registry = new ToolRegistry();
      type Node = { organizationId?: string; children?: Node[] };
      const nodeSchema: z.ZodType<Node> = z.lazy(() =>
        z.object({
          organizationId: z.string().optional(),
          children: z.array(nodeSchema).optional(),
        }),
      );
      expect(() =>
        registry.register(
          makeTool({
            name: "lazy_leaky",
            inputSchema: z.object({ tree: nodeSchema }),
          }),
        ),
      ).toThrow(UnauthorizedToolInputError);
    });

    it("permite z.lazy() auto-referenciado legítimo, sin campos de tenant, sin recursión infinita", () => {
      const registry = new ToolRegistry();
      type Node = { name: string; children?: Node[] };
      const nodeSchema: z.ZodType<Node> = z.lazy(() =>
        z.object({
          name: z.string(),
          children: z.array(nodeSchema).optional(),
        }),
      );
      expect(() =>
        registry.register(
          makeTool({
            name: "lazy_legit",
            inputSchema: z.object({ tree: nodeSchema }),
          }),
        ),
      ).not.toThrow();
    });

    it("permite z.union/z.record/z.intersection/z.tuple legítimos sin campos de tenant en ninguna rama", () => {
      const registry = new ToolRegistry();
      expect(() =>
        registry.register(
          makeTool({
            name: "union_legit",
            inputSchema: z.union([z.object({ foo: z.string() }), z.object({ bar: z.string() })]),
          }),
        ),
      ).not.toThrow();

      expect(() =>
        registry.register(
          makeTool({
            name: "record_legit",
            inputSchema: z.record(z.string(), z.object({ q: z.string() })),
          }),
        ),
      ).not.toThrow();

      expect(() =>
        registry.register(
          makeTool({
            name: "intersection_legit",
            inputSchema: z.intersection(z.object({ foo: z.string() }), z.object({ bar: z.string() })),
          }),
        ),
      ).not.toThrow();

      expect(() =>
        registry.register(
          makeTool({
            name: "tuple_legit",
            inputSchema: z.object({ par: z.tuple([z.string(), z.object({ bar: z.string() })]) }),
          }),
        ),
      ).not.toThrow();
    });

    it("sigue rechazando el caso ya cubierto por AG-11 (objeto anidado directo) tras la extensión de AG-20", () => {
      const registry = new ToolRegistry();
      expect(() =>
        registry.register(
          makeTool({
            name: "control_nested_direct",
            inputSchema: z.object({ meta: z.object({ organizationId: z.string() }) }),
          }),
        ),
      ).toThrow(UnauthorizedToolInputError);
    });
  });

  describe("AG-22 (MEDIA): ZodPipeline/ZodBranded, keyType de ZodRecord/ZodMap, guarda de profundidad, verificación de runtime", () => {
    it("rechaza organizationId detrás de .pipe() (ZodPipeline)", () => {
      const registry = new ToolRegistry();
      expect(() =>
        registry.register(
          makeTool({
            name: "pipeline_leaky",
            inputSchema: z.object({ organizationId: z.string() }).pipe(z.object({ organizationId: z.string() })),
          }),
        ),
      ).toThrow(UnauthorizedToolInputError);
    });

    it("rechaza organizationId detrás de .brand() (ZodBranded)", () => {
      const registry = new ToolRegistry();
      expect(() =>
        registry.register(
          makeTool({
            name: "branded_leaky",
            inputSchema: z.object({ organizationId: z.string() }).brand<"Foo">(),
          }),
        ),
      ).toThrow(UnauthorizedToolInputError);
    });

    it("permite .pipe()/.brand() legítimos sin campos de tenant", () => {
      const registry = new ToolRegistry();
      expect(() =>
        registry.register(
          makeTool({
            name: "pipeline_legit",
            inputSchema: z.object({ q: z.string() }).pipe(z.object({ q: z.string() })),
          }),
        ),
      ).not.toThrow();
      expect(() =>
        registry.register(
          makeTool({
            name: "branded_legit",
            inputSchema: z.object({ q: z.string() }).brand<"Foo">(),
          }),
        ),
      ).not.toThrow();
    });

    it("rechaza organizationId como miembro literal del keyType (z.enum) de un z.record", () => {
      const registry = new ToolRegistry();
      const Keys = z.enum(["organizationId", "otherKey"]);
      expect(() =>
        registry.register(
          makeTool({
            name: "record_enum_key_leaky",
            inputSchema: z.record(Keys, z.string()),
          }),
        ),
      ).toThrow(UnauthorizedToolInputError);
    });

    it("rechaza organizationId como miembro literal del keyType (z.nativeEnum) de un z.map", () => {
      const registry = new ToolRegistry();
      enum TenantKeys {
        Forbidden = "organizationId",
        Ok = "other",
      }
      expect(() =>
        registry.register(
          makeTool({
            name: "map_native_enum_key_leaky",
            inputSchema: z.object({ config: z.map(z.nativeEnum(TenantKeys), z.string()) }),
          }),
        ),
      ).toThrow(UnauthorizedToolInputError);
    });

    it("rechaza organizationId como z.literal keyType de un z.record", () => {
      const registry = new ToolRegistry();
      expect(() =>
        registry.register(
          makeTool({
            name: "record_literal_key_leaky",
            inputSchema: z.record(z.literal("organizationId"), z.string()),
          }),
        ),
      ).toThrow(UnauthorizedToolInputError);
    });

    it("permite z.record/z.map con keyType enum legítimo (ningún miembro es un campo prohibido)", () => {
      const registry = new ToolRegistry();
      const Keys = z.enum(["foo", "bar"]);
      expect(() =>
        registry.register(
          makeTool({
            name: "record_enum_key_legit",
            inputSchema: z.record(Keys, z.string()),
          }),
        ),
      ).not.toThrow();
    });

    it("límite arquitectónico documentado: z.record(z.string(), ...) de clave genérica NO se rechaza en el registro (nada que declarar estáticamente)", () => {
      const registry = new ToolRegistry();
      expect(() =>
        registry.register(
          makeTool({
            name: "generic_key_record_registers_fine",
            inputSchema: z.object({ meta: z.record(z.string(), z.string()) }),
          }),
        ),
      ).not.toThrow();
    });

    it("rechaza el registro con SchemaTooDeepError (no RangeError) ante un esquema no cíclico de ~20 000 niveles", () => {
      const registry = new ToolRegistry();
      let schema: z.ZodTypeAny = z.object({ value: z.string() });
      for (let i = 0; i < 20_000; i++) {
        schema = z.object({ nested: schema });
      }
      try {
        registry.register(makeTool({ name: "too_deep", inputSchema: schema }));
        throw new Error("no debería llegar aquí: se esperaba SchemaTooDeepError");
      } catch (error) {
        expect(error).toBeInstanceOf(SchemaTooDeepError);
        expect(error).not.toBeInstanceOf(RangeError);
      }
    });

    it("z.lazy() cíclico real sigue funcionando sin disparar la guarda de profundidad (el Set 'seen' por identidad ya lo cubre)", () => {
      const registry = new ToolRegistry();
      type Node = { name: string; children?: Node[] };
      const nodeSchema: z.ZodType<Node> = z.lazy(() =>
        z.object({ name: z.string(), children: z.array(nodeSchema).optional() }),
      );
      expect(() =>
        registry.register(makeTool({ name: "lazy_cyclic_control", inputSchema: z.object({ tree: nodeSchema }) })),
      ).not.toThrow();
    });

    describe("verificación en TIEMPO DE EJECUCIÓN (validateInput) para z.record/z.map de clave genérica", () => {
      it("rechaza en runtime argumentos cuya clave real (dentro de un z.record de clave genérica) sea organizationId", () => {
        const registry = new ToolRegistry();
        registry.register(
          makeTool({
            name: "generic_record_tool",
            inputSchema: z.object({ meta: z.record(z.string(), z.string()) }),
          }),
        );
        expect(() =>
          registry.validateInput("generic_record_tool", { meta: { organizationId: "attacker-tenant" } }),
        ).toThrow(ForbiddenRuntimeInputFieldError);
      });

      it("rechaza en runtime organizationId anidado en cualquier profundidad dentro de los argumentos reales", () => {
        const registry = new ToolRegistry();
        registry.register(
          makeTool({
            name: "generic_nested_tool",
            inputSchema: z.object({ meta: z.record(z.string(), z.record(z.string(), z.string())) }),
          }),
        );
        expect(() =>
          registry.validateInput("generic_nested_tool", {
            meta: { a: { organizationId: "attacker-tenant" } },
          }),
        ).toThrow(ForbiddenRuntimeInputFieldError);
      });

      it("permite argumentos legítimos sin claves prohibidas en un z.record de clave genérica", () => {
        const registry = new ToolRegistry();
        registry.register(
          makeTool({
            name: "generic_record_legit",
            inputSchema: z.object({ meta: z.record(z.string(), z.string()) }),
          }),
        );
        expect(() => registry.validateInput("generic_record_legit", { meta: { foo: "bar" } })).not.toThrow();
      });

      it("rechaza con RuntimeArgsTooDeepError (no RangeError) ante argumentos con anidamiento profundo patológico", () => {
        const registry = new ToolRegistry();
        registry.register(
          makeTool({
            name: "deep_args_tool",
            inputSchema: z.object({ meta: z.record(z.string(), z.any()) }),
          }),
        );
        let value: Record<string, unknown> = { leaf: true };
        for (let i = 0; i < 500; i++) {
          value = { nested: value };
        }
        try {
          registry.validateInput("deep_args_tool", { meta: value });
          throw new Error("no debería llegar aquí: se esperaba RuntimeArgsTooDeepError");
        } catch (error) {
          expect(error).toBeInstanceOf(RuntimeArgsTooDeepError);
          expect(error).not.toBeInstanceOf(RangeError);
        }
      });
    });
  });

  it("permite esquemas de entrada sin campos de tenant", () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(makeTool())).not.toThrow();
  });

  describe("AG-23 (MEDIA): normaliza la clave antes de comparar contra campos prohibidos (NFKC + minúsculas + sin separadores + prefijo/sufijo)", () => {
    const POSITIVE_VARIANTS = [
      "ORG_ID",
      "org-id",
      "Org.Id",
      "org id",
      "ｏｒｇ＿ｉｄ", // fullwidth (NFKC-normalizable)
      "x_org_id", // sufijo deliberado
      "orgId", // control: ya se detectaba por igualdad estricta antes de AG-23, debe seguir bloqueándose
    ];

    const NEGATIVE_VARIANTS = ["organizacion_nombre", "origin_id", "tenderId"];

    it.each(POSITIVE_VARIANTS)(
      "rechaza en el REGISTRO (chequeo estático) la variante de clave %j",
      (variant) => {
        const registry = new ToolRegistry();
        expect(() =>
          registry.register(
            makeTool({
              name: "ag23_static_tool",
              inputSchema: z.object({ [variant]: z.string(), q: z.string() }),
            }),
          ),
        ).toThrow(UnauthorizedToolInputError);
      },
    );

    it.each(POSITIVE_VARIANTS)(
      "rechaza en RUNTIME (validateInput, dentro de un z.record de clave genérica) la variante de clave %j",
      (variant) => {
        const registry = new ToolRegistry();
        registry.register(
          makeTool({
            name: "ag23_runtime_tool",
            inputSchema: z.object({ meta: z.record(z.string(), z.string()) }),
          }),
        );
        expect(() => registry.validateInput("ag23_runtime_tool", { meta: { [variant]: "attacker-tenant" } })).toThrow(
          ForbiddenRuntimeInputFieldError,
        );
      },
    );

    it.each(NEGATIVE_VARIANTS)(
      "NO rechaza en el registro el nombre de campo legítimo %j (no debe haber falso positivo)",
      (fieldName) => {
        const registry = new ToolRegistry();
        expect(() =>
          registry.register(
            makeTool({
              name: "ag23_static_negative_tool",
              inputSchema: z.object({ [fieldName]: z.string(), q: z.string() }),
            }),
          ),
        ).not.toThrow();
      },
    );

    it.each(NEGATIVE_VARIANTS)(
      "NO rechaza en runtime el nombre de campo legítimo %j (no debe haber falso positivo)",
      (fieldName) => {
        const registry = new ToolRegistry();
        registry.register(
          makeTool({
            name: "ag23_runtime_negative_tool",
            inputSchema: z.object({ meta: z.record(z.string(), z.string()) }),
          }),
        );
        expect(() =>
          registry.validateInput("ag23_runtime_negative_tool", { meta: { [fieldName]: "valor-legitimo" } }),
        ).not.toThrow();
      },
    );

    it("rechaza org_id_override (prefijo orgid) y tenantId2 (tenantid + sufijo numérico) en runtime", () => {
      const registry = new ToolRegistry();
      registry.register(
        makeTool({
          name: "ag23_affix_tool",
          inputSchema: z.object({ meta: z.record(z.string(), z.string()) }),
        }),
      );
      expect(() =>
        registry.validateInput("ag23_affix_tool", { meta: { org_id_override: "attacker-tenant" } }),
      ).toThrow(ForbiddenRuntimeInputFieldError);
      expect(() => registry.validateInput("ag23_affix_tool", { meta: { tenantId2: "attacker-tenant" } })).toThrow(
        ForbiddenRuntimeInputFieldError,
      );
    });

    it("sigue detectando las 6 grafías canónicas originales sin cambios de comportamiento", () => {
      const registry = new ToolRegistry();
      const canonicalFields = ["organizationId", "organization_id", "tenantId", "tenant_id", "orgId", "org_id"];
      canonicalFields.forEach((field, index) => {
        expect(() =>
          registry.register(makeTool({ name: `canonical_tool_${index}`, inputSchema: z.object({ [field]: z.string() }) })),
        ).toThrow(UnauthorizedToolInputError);
      });
    });
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

  describe("AG-05 (MEDIA): declaredEffects obligatorio y consistente con riskLevel", () => {
    it("rechaza el registro si la herramienta no declara declaredEffects", () => {
      const registry = new ToolRegistry();
      const toolWithout = { ...makeTool(), declaredEffects: undefined } as unknown as ToolDefinition<any, any>;
      expect(() => registry.register(toolWithout)).toThrow(InvalidDeclaredEffectsError);
    });

    it("rechaza declaredEffects vacío", () => {
      const registry = new ToolRegistry();
      expect(() => registry.register(makeTool({ declaredEffects: [] }))).toThrow(InvalidDeclaredEffectsError);
    });

    it("rechaza un valor de efecto fuera del enum cerrado", () => {
      const registry = new ToolRegistry();
      const bad = { ...makeTool(), declaredEffects: ["hace_de_todo"] } as unknown as ToolDefinition<any, any>;
      expect(() => registry.register(bad)).toThrow(InvalidDeclaredEffectsError);
    });

    it("rechaza un handler riskLevel='read' que declara un efecto fuera de read_only (contradicción explícita)", () => {
      const registry = new ToolRegistry();
      expect(() =>
        registry.register(makeTool({ riskLevel: "read", declaredEffects: ["external_send"] })),
      ).toThrow(InvalidDeclaredEffectsError);
      expect(() =>
        registry.register(makeTool({ name: "otro", riskLevel: "read", declaredEffects: ["read_only", "sign"] })),
      ).toThrow(InvalidDeclaredEffectsError);
    });

    it("acepta riskLevel='read' con declaredEffects: ['read_only']", () => {
      const registry = new ToolRegistry();
      expect(() => registry.register(makeTool({ riskLevel: "read", declaredEffects: ["read_only"] }))).not.toThrow();
    });

    it("permite que herramientas de riesgo mayor (write/external/irreversible) declaren efectos no-read_only", () => {
      const registry = new ToolRegistry();
      expect(() =>
        registry.register(makeTool({ name: "firmar", riskLevel: "irreversible", actionKind: "sign", declaredEffects: ["sign"] })),
      ).not.toThrow();
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
