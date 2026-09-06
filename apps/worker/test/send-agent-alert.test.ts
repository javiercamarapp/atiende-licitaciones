import { describe, it, expect, vi } from 'vitest';
import { createSendAgentAlertHandler } from '../src/handlers/send-agent-alert.js';
import { silentLogger } from './helpers.js';
import type { Job, JobHandlerContext } from '../src/queue/types.js';
import type { SendAgentAlertPayload } from '../src/handlers/send-agent-alert.js';

describe('send_agent_alert handler (Ronda 6): registra la alerta en el log, sin canal de envío real', () => {
  it('registra un warning estructurado con organization_id/tender_id/alert_kind y el mensaje', async () => {
    const logger = silentLogger();
    const warnSpy = vi.spyOn(logger, 'warn');
    const handler = createSendAgentAlertHandler();
    const job: Job<SendAgentAlertPayload> = {
      id: 'job-alert-1',
      orgId: 'org-1',
      kind: 'send_agent_alert',
      payload: { organizationId: 'org-1', tenderId: 'tender-1', kind: 'vencimiento', message: 'La convocatoria vence pronto' },
      status: 'running',
      attempts: 1,
      maxAttempts: 5,
      nextRunAt: new Date(),
      lockedAt: new Date(),
      lockedBy: 'worker-test',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const ctx: JobHandlerContext = { job: job as unknown as Job, logger, signal: new AbortController().signal };

    await handler(job, ctx);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [meta, msg] = warnSpy.mock.calls[0];
    expect(meta).toMatchObject({ organization_id: 'org-1', tender_id: 'tender-1', alert_kind: 'vencimiento' });
    expect(msg).toContain('La convocatoria vence pronto');
  });
});
