import { describe, it, expect } from 'vitest';
import { parseDisabledAgents, assertAgentNotDisabled, AgentKillSwitchError } from '../src/agents/kill-switch.js';

describe('kill-switch.ts (Ronda 6, tarea 4): kill-switch por agente vía WORKER_DISABLED_AGENTS', () => {
  it('sin la variable de entorno, ningún agente está deshabilitado', () => {
    const disabled = parseDisabledAgents({});
    expect(disabled.size).toBe(0);
    expect(() => assertAgentNotDisabled('analista_convocatorias', disabled)).not.toThrow();
  });

  it('parsea una lista separada por comas, con espacios y entradas vacías tolerados', () => {
    const disabled = parseDisabledAgents({ WORKER_DISABLED_AGENTS: ' analista_convocatorias, recordatorios ,,vigilante_cambios' });
    expect(disabled.has('analista_convocatorias')).toBe(true);
    expect(disabled.has('recordatorios')).toBe(true);
    expect(disabled.has('vigilante_cambios')).toBe(true);
    expect(disabled.has('analista_bases')).toBe(false);
  });

  it('assertAgentNotDisabled lanza AgentKillSwitchError (permanent) para un agente deshabilitado', () => {
    const disabled = parseDisabledAgents({ WORKER_DISABLED_AGENTS: 'redactor_borrador' });
    expect(() => assertAgentNotDisabled('redactor_borrador', disabled)).toThrow(AgentKillSwitchError);
    try {
      assertAgentNotDisabled('redactor_borrador', disabled);
    } catch (error) {
      expect((error as { permanent?: boolean }).permanent).toBe(true);
    }
  });

  it('un agente NO listado sigue habilitado aunque otros estén deshabilitados', () => {
    const disabled = parseDisabledAgents({ WORKER_DISABLED_AGENTS: 'redactor_borrador' });
    expect(() => assertAgentNotDisabled('analista_convocatorias', disabled)).not.toThrow();
  });
});
