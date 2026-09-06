export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Limita, por host, cuántas peticiones concurrentes se permiten (REQ-076:
 * 1-2 conexiones simultáneas por portal) y el espaciado mínimo entre inicios
 * de petición (REQ-079: ≤1 req/s). Las llamadas a `acquire()` se atienden en
 * orden de llegada (FIFO) y de forma determinista respecto al `Clock`
 * inyectado, para poder probarse con fake timers.
 */
export class HostThrottle {
  private active = 0;
  private lastStartMs = -Infinity;
  private turnChain: Promise<void> = Promise.resolve();
  private waiters: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly minIntervalMs: number,
    private readonly clock: Clock = realClock,
  ) {}

  /** Espera el turno (cupo + espaciado) y devuelve una función `release()` a invocar al terminar la petición. */
  async acquire(): Promise<() => void> {
    let releaseTurn!: () => void;
    const myTurn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const previous = this.turnChain;
    this.turnChain = previous.then(() => myTurn);
    await previous;

    await this.waitForFreeSlot();

    const now = this.clock.now();
    const earliestStart = this.lastStartMs + this.minIntervalMs;
    const waitMs = Math.max(0, earliestStart - now);
    if (waitMs > 0) {
      await this.clock.sleep(waitMs);
    }
    this.lastStartMs = this.clock.now();
    this.active += 1;
    releaseTurn();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.wakeNextWaiter();
    };
  }

  private waitForFreeSlot(): Promise<void> {
    if (this.active < this.concurrency) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private wakeNextWaiter(): void {
    const next = this.waiters.shift();
    if (next) next();
  }
}

/** Registro de throttles, uno por host, creados perezosamente con la misma configuración. */
export class HostThrottleRegistry {
  private readonly throttles = new Map<string, HostThrottle>();

  constructor(
    private readonly concurrency: number,
    private readonly minIntervalMs: number,
    private readonly clock: Clock = realClock,
  ) {}

  forHost(host: string): HostThrottle {
    let throttle = this.throttles.get(host);
    if (!throttle) {
      throttle = new HostThrottle(this.concurrency, this.minIntervalMs, this.clock);
      this.throttles.set(host, throttle);
    }
    return throttle;
  }
}
