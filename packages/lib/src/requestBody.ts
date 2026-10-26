/**
 * Read a request body only up to a stated size (#2756).
 *
 * Every Worker route that reads a body reads it here, with a cap the route
 * names. `req.json()` buffers whatever the caller sends before a single
 * field is checked, so a route that validates its fields after the read
 * has already paid for an unbounded body. This reads the declared
 * `Content-Length` first and refuses one over the cap without reading;
 * when the header is absent or wrong, it reads the stream and stops at the
 * first byte over the cap. `publicEndpointRules.test.ts` pins, for every
 * Worker, that no source file reads a request body any other way.
 *
 * The answers are stated, never thrown: a body over the cap is 413
 * `body-too-large`, a body that is not JSON (for the JSON reader) is 400
 * `invalid-json`. A route maps them to its own response shape.
 */

/** Why a body was not read. */
export type BodyRefusal = { ok: false; status: 413; error: 'body-too-large' } | { ok: false; status: 400; error: 'invalid-json' };

const TOO_LARGE: BodyRefusal = { ok: false, status: 413, error: 'body-too-large' };
const INVALID_JSON: BodyRefusal = { ok: false, status: 400, error: 'invalid-json' };

/**
 * The body's bytes, or a refusal when it is larger than `maxBytes`.
 * Never reads past the first chunk that crosses the cap.
 */
export async function readBodyBytes(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array<ArrayBuffer> } | BodyRefusal> {
  const declared = req.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) return TOO_LARGE;
  if (!req.body) return { ok: true, bytes: new Uint8Array(new ArrayBuffer(0)) };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, bytes };
}

/** The body as UTF-8 text, or a refusal when it is larger than `maxBytes`. */
export async function readBodyText(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | BodyRefusal> {
  const read = await readBodyBytes(req, maxBytes);
  return read.ok ? { ok: true, text: new TextDecoder().decode(read.bytes) } : read;
}

/** The body parsed as JSON, or a refusal when it is larger than
 *  `maxBytes` or is not JSON. */
export async function readJsonBody(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | BodyRefusal> {
  const read = await readBodyText(req, maxBytes);
  if (!read.ok) return read;
  try {
    return { ok: true, value: JSON.parse(read.text) as unknown };
  } catch {
    return INVALID_JSON;
  }
}

/** The body parsed as `multipart/form-data` (or any form encoding the
 *  request's own `Content-Type` names), or a refusal when it is larger
 *  than `maxBytes`. A body that does not parse as the form it claims is
 *  `null`. */
export async function readFormBody(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; form: FormData | null } | BodyRefusal> {
  const read = await readBodyBytes(req, maxBytes);
  if (!read.ok) return read;
  try {
    const form = await new Response(read.bytes, {
      headers: { 'content-type': req.headers.get('content-type') ?? '' },
    }).formData();
    return { ok: true, form };
  } catch {
    return { ok: true, form: null };
  }
}
