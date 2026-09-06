import { describe, it, expect } from 'vitest';
import { loadScheduleConfig, DEFAULT_SCHEDULES } from '../src/scheduler/schedule-config.js';

describe('loadScheduleConfig', () => {
  it('sin WORKER_SCHEDULE_JSON, usa DEFAULT_SCHEDULES', () => {
    expect(loadScheduleConfig({})).toEqual(DEFAULT_SCHEDULES);
  });

  it('con WORKER_SCHEDULE_JSON válido, lo usa tal cual', () => {
    const custom = [{ sourceId: 'dof', intervalMs: 5000 }];
    const result = loadScheduleConfig({ WORKER_SCHEDULE_JSON: JSON.stringify(custom) });
    expect(result).toEqual(custom);
  });

  it('con WORKER_SCHEDULE_JSON inválido (no es JSON), cae a DEFAULT_SCHEDULES en vez de tronar', () => {
    const result = loadScheduleConfig({ WORKER_SCHEDULE_JSON: '{no es json valido' });
    expect(result).toEqual(DEFAULT_SCHEDULES);
  });

  it('con WORKER_SCHEDULE_JSON como un array vacío, cae a DEFAULT_SCHEDULES (nunca deja el worker sin ninguna fuente por error de config)', () => {
    const result = loadScheduleConfig({ WORKER_SCHEDULE_JSON: '[]' });
    expect(result).toEqual(DEFAULT_SCHEDULES);
  });

  it('con WORKER_SCHEDULE_JSON que no es un array (objeto), cae a DEFAULT_SCHEDULES', () => {
    const result = loadScheduleConfig({ WORKER_SCHEDULE_JSON: JSON.stringify({ sourceId: 'dof' }) });
    expect(result).toEqual(DEFAULT_SCHEDULES);
  });
});
