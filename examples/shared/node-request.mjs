// Node `http` request → web `Request` for the example servers.
//
// The body is read into memory first (bounded), never handed over as `Readable.toWeb(incoming)`: a handler that answers
// without reading the body, or stops reading at its size cap, cancels that web stream while Node keeps pushing data
// into it, and the resulting "Controller is already closed" error is thrown outside any request and kills the process.

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/** Reads at most `maxBytes` of the body. Returns `undefined` when the body is larger (answer 413) or the client went away. */
export async function readBody(incoming, maxBytes = DEFAULT_MAX_BYTES) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > maxBytes) { incoming.resume(); return undefined; }
      chunks.push(chunk);
    }
  } catch { return undefined; }
  return Buffer.concat(chunks);
}

/** The web `Request` for an incoming Node request, or `undefined` when its body is over `maxBytes` or unreadable. */
export async function webRequest(incoming, url, { signal, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const init = { method: incoming.method, headers: incoming.headers, ...(signal ? { signal } : {}) };
  if (incoming.method === 'GET' || incoming.method === 'HEAD') return new Request(url, init);
  const body = await readBody(incoming, maxBytes);
  return body === undefined ? undefined : new Request(url, { ...init, body });
}
