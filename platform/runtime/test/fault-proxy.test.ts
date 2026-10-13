/**
 * The fault proxy of exit criterion (6) (plan S-PLAT-I2 work item 7): `cut()` makes the gateway silent as a cut
 * link does (bytes dropped, no RST, no FIN, new connections accepted and never answered); `heal()` forwards again.
 * A loopback echo server stands in for the gateway.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect, type Socket } from 'node:net';
import { FaultProxy } from '../testing/fault-proxy.ts';
import { Closers, until } from './support.ts';

const closers = new Closers();
afterEach(() => closers.closeAll());

async function echoServer(): Promise<number> {
  const sockets = new Set<Socket>();
  const server = createServer((s) => { sockets.add(s); s.on('data', (b) => s.write(b)); s.on('error', () => s.destroy()); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.add(async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); });
  const a = server.address();
  if (a === null || typeof a === 'string') throw new Error('echo server is not listening');
  return a.port;
}

/** A client of the proxy that records what it receives and whether its socket ended or closed. */
async function client(port: number) {
  const s = connect({ host: '127.0.0.1', port });
  closers.add(async () => { s.destroy(); });
  const c = { s, got: '', ended: false, closed: false };
  s.on('data', (b) => { c.got += b.toString(); });
  s.on('end', () => { c.ended = true; });
  s.on('close', () => { c.closed = true; });
  s.on('error', () => {});
  await new Promise<void>((r) => s.once('connect', () => r()));
  return c;
}

test('should drop the bytes of a cut link and keep its sockets open, accept new connections without an answer, and forward again after heal', { timeout: 10_000 }, async () => {
  const proxy = await FaultProxy.start({ host: '127.0.0.1', port: await echoServer() });
  closers.add(() => proxy.close());
  const a = await client(proxy.port);
  a.s.write('one');
  await until(() => a.got === 'one', 5_000, 'echo through the proxy');
  proxy.cut();
  a.s.write('lost');
  await until(() => proxy.droppedBytes === 4, 5_000, 'the proxy dropped the bytes of the cut link');
  const b = await client(proxy.port);
  await until(() => proxy.accepted === 2, 5_000, 'a new connection is accepted while cut');
  b.s.write('xy');
  await until(() => proxy.droppedBytes === 6, 5_000, 'its bytes are dropped');
  assert.deepEqual([a.got, a.ended, a.closed], ['one', false, false], 'no answer, no FIN, no RST on the cut link');
  assert.deepEqual([b.got, b.ended, b.closed], ['', false, false]);
  proxy.heal();
  a.s.write('two');
  await until(() => a.got === 'onetwo', 5_000, 'the old connection forwards again after heal');
  const c = await client(proxy.port);
  c.s.write('three');
  await until(() => c.got === 'three', 5_000, 'a new connection forwards after heal');
  assert.equal(a.got, 'onetwo', 'the bytes of the cut were never delivered');
});
