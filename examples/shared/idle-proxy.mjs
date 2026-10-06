// A tiny TCP reverse proxy that behaves like a load balancer's idle timeout (an AWS ALB closes a connection after 60 s without
// bytes in either direction): every connection silent for `idleMs` is closed on both sides. Journeys put the studio behind it to
// prove the chat stream survives through heartbeats and reconnects by itself when the proxy drops it.
//
//   PROXY_TARGET=http://127.0.0.1:4180 PROXY_IDLE_MS=5000 PROXY_PORT=4280 node examples/shared/idle-proxy.mjs
import { createConnection, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

/** Start the proxy in front of `target` (an http:// origin). `cut()` drops every open connection, as a proxy restart would. */
export async function startIdleProxy({ target, idleMs = 5000, port = 0 }) {
  const upstream = new URL(target);
  const open = new Set(), stats = { connections: 0, idleClosed: 0, cut: 0 };
  const server = createServer(client => {
    stats.connections++;
    const backend = createConnection({ host: upstream.hostname, port: Number(upstream.port || 80) });
    const pair = { client, backend };
    open.add(pair);
    let timer;
    const close = () => { clearTimeout(timer); open.delete(pair); client.destroy(); backend.destroy(); };
    const idle = () => { clearTimeout(timer); timer = setTimeout(() => { stats.idleClosed++; close(); }, idleMs); };
    for (const [from, to] of [[client, backend], [backend, client]]) {
      from.on('data', chunk => { idle(); if (!to.write(chunk)) { from.pause(); to.once('drain', () => from.resume()); } });
      from.on('end', () => to.end());
      from.on('error', close);
      from.on('close', close);
    }
    idle();
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const address = server.address().port;
  return {
    url: `http://127.0.0.1:${address}/`, port: address, stats,
    cut: () => { for (const { client, backend } of [...open]) { stats.cut++; client.destroy(); backend.destroy(); } },
    close: async () => { for (const { client, backend } of [...open]) { client.destroy(); backend.destroy(); } await new Promise(resolve => server.close(resolve)); },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const proxy = await startIdleProxy({ target: process.env.PROXY_TARGET ?? 'http://127.0.0.1:4180', idleMs: Number(process.env.PROXY_IDLE_MS ?? 5000), port: Number(process.env.PROXY_PORT ?? 0) });
  console.log(`idle-closing proxy on ${proxy.url} (idle timeout ${process.env.PROXY_IDLE_MS ?? 5000} ms) -> ${process.env.PROXY_TARGET ?? 'http://127.0.0.1:4180'}`);
}
