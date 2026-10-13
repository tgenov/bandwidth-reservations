/**
 * A TCP fault proxy between owners and one SQL gateway (plan S-PLAT-I2 exit criterion 6). `cut()` makes the
 * gateway silent, as a cut link does: bytes in both directions are dropped and new connections get no answer,
 * but no socket is closed (no RST, no FIN), so a client sees only timeouts. `heal()` forwards again on new
 * connections. It never touches the dev cell's containers.
 */
import { createServer, connect, type Server, type Socket } from 'node:net';

export class FaultProxy {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private cutNow = false;
  readonly target: { host: string; port: number };
  /** Connections accepted, for tests. */
  accepted = 0;

  private constructor(target: { host: string; port: number }) {
    this.target = target;
    this.server = createServer((client) => this.onClient(client));
  }

  /** Starts a proxy on a free local port. */
  static async start(target: { host: string; port: number }): Promise<FaultProxy> {
    const p = new FaultProxy(target);
    await new Promise<void>((resolve) => p.server.listen(0, '127.0.0.1', resolve));
    return p;
  }

  get port(): number {
    const a = this.server.address();
    if (a === null || typeof a === 'string') throw new Error('proxy is not listening');
    return a.port;
  }

  /** A connection string through this proxy. */
  url(base: string): string {
    const u = new URL(base);
    u.hostname = '127.0.0.1';
    u.port = String(this.port);
    return u.toString();
  }

  cut(): void {
    this.cutNow = true;
  }

  heal(): void {
    this.cutNow = false;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private onClient(client: Socket): void {
    this.accepted += 1;
    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
    client.on('error', () => client.destroy());
    if (this.cutNow) return;                   // accepted, never answered
    const up = connect(this.target);
    this.sockets.add(up);
    up.on('close', () => { this.sockets.delete(up); client.destroy(); });
    up.on('error', () => up.destroy());
    client.on('close', () => up.destroy());
    client.on('data', (b) => { if (!this.cutNow) up.write(b); });
    up.on('data', (b) => { if (!this.cutNow) client.write(b); });
  }
}
