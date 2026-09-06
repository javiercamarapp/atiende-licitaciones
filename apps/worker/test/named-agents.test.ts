import { describe, it, expect } from 'vitest';
import { NAMED_AGENTS, buildNamedAgentPlan, isNamedAgent, InvalidNamedAgentContextError } from '../src/agents/named-agents.js';

const VALID_UUID = '00000000-0000-0000-0000-000000000001';

describe('named-agents.ts (Ronda 6): planes fijos, sin improvisación del modelo', () => {
  it('isNamedAgent reconoce exactamente los 5 agentes nombrados', () => {
    expect(NAMED_AGENTS).toEqual(['analista_convocatorias', 'analista_bases', 'redactor_borrador', 'vigilante_cambios', 'recordatorios']);
    for (const name of NAMED_AGENTS) expect(isNamedAgent(name)).toBe(true);
    expect(isNamedAgent('demo-agent')).toBe(false);
    expect(isNamedAgent('cualquier_otro_nombre')).toBe(false);
  });

  it('analista_convocatorias: plan fijo de 3 pasos en orden determinista, con costo estimado > 0 en cada uno', () => {
    const plan = buildNamedAgentPlan('analista_convocatorias', { tenderId: VALID_UUID });
    expect(plan.map((s) => s.toolName)).toEqual(['leer_bases', 'leer_perfil_empresa', 'proponer_matching']);
    expect(plan.every((s) => (s.estimatedCostUsd ?? 0) > 0)).toBe(true);
    // Llamarlo de nuevo con el MISMO contexto produce el MISMO plan (determinista, sin aleatoriedad).
    const plan2 = buildNamedAgentPlan('analista_convocatorias', { tenderId: VALID_UUID });
    expect(plan2).toEqual(plan);
  });

  it('analista_bases: plan fijo de 2 pasos', () => {
    const plan = buildNamedAgentPlan('analista_bases', { tenderId: VALID_UUID });
    expect(plan.map((s) => s.toolName)).toEqual(['leer_bases', 'proponer_requisitos_matriz']);
  });

  it('redactor_borrador: un paso "proponer_seccion_propuesta" por cada sectionKey, en el orden dado', () => {
    const plan = buildNamedAgentPlan('redactor_borrador', { tenderId: VALID_UUID, sectionKeys: ['experiencia', 'capacidad_tecnica'] });
    expect(plan.map((s) => s.toolName)).toEqual(['leer_perfil_empresa', 'proponer_seccion_propuesta', 'proponer_seccion_propuesta']);
    expect((plan[1].input as { sectionKey: string }).sectionKey).toBe('experiencia');
    expect((plan[2].input as { sectionKey: string }).sectionKey).toBe('capacidad_tecnica');
  });

  it('vigilante_cambios: un único paso de resumen', () => {
    const plan = buildNamedAgentPlan('vigilante_cambios', { tenderId: VALID_UUID });
    expect(plan.map((s) => s.toolName)).toEqual(['resumir_cambios_convocatoria']);
  });

  it('recordatorios: un único paso de alerta programada', () => {
    const plan = buildNamedAgentPlan('recordatorios', {
      tenderId: VALID_UUID,
      alert: { kind: 'vencimiento', scheduledFor: new Date().toISOString(), message: 'x' },
    });
    expect(plan.map((s) => s.toolName)).toEqual(['programar_alerta']);
  });

  it.each(NAMED_AGENTS)('%s: contexto inválido/incompleto lanza InvalidNamedAgentContextError (permanent), nunca "mejor esfuerzo"', (agentName) => {
    expect(() => buildNamedAgentPlan(agentName, {})).toThrow(InvalidNamedAgentContextError);
    try {
      buildNamedAgentPlan(agentName, {});
    } catch (error) {
      expect((error as { permanent?: boolean }).permanent).toBe(true);
    }
  });

  it('redactor_borrador: sectionKeys vacío también es inválido (min(1) en el esquema)', () => {
    expect(() => buildNamedAgentPlan('redactor_borrador', { tenderId: VALID_UUID, sectionKeys: [] })).toThrow(InvalidNamedAgentContextError);
  });

  it('tenderId con formato no-UUID es inválido para cualquier agente que lo requiera', () => {
    expect(() => buildNamedAgentPlan('vigilante_cambios', { tenderId: 'no-es-un-uuid' })).toThrow(InvalidNamedAgentContextError);
  });
});
