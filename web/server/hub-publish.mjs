// Publishing a document through the HUB, which is the only path that records it.
//
// WHY THIS EXISTS
//   `jarvis_files publish` used the gateway's MCP family (`create_session`), which
//   writes the BODY. The Files page lists the hub's `file_ref` registry
//   (`GET /hub/files`). Two API families on one service, and only one of them
//   records what exists — so a run could truthfully report "Published … read back
//   at version 1" and the page would show nothing at all.
//
// THE REV IS NOT OPTIONAL, AND THAT WAS THE BUG LEFT IN
//   A hub write must name the revision it is writing AGAINST, in the BODY. The
//   first cut of this file sent none and waited for a `412`; the hub answers
//   `400 REV_REQUIRED` instead, so nothing was ever recorded and every publish
//   fell through to the warning path. Probed live:
//
//     {"ok":false,"error":"this route needs the rev you are writing against",
//      "code":"REV_REQUIRED","details":{"field":"rev"}}
//
//   So the rev is READ FIRST (`GET /files` answers it at the top level) and sent
//   with the write. A writer that loses a race is answered `STALE_REV`, whose
//   refusal carries the winning rev as a SIBLING at `details.rev` — NOT at
//   `details.current.rev`, which is always null, because `details.current` holds
//   the hub STATE. The browser client documents the same trap; reading the wrong
//   key is a silent no-retry that looks exactly like "the hub refuses writes".
//
// WHY IT IS A MODULE
//   Importing `local-sse.mjs` starts a server, so a harness could not reach any of
//   this. Here it is driven with a fake client.

/**
 * One `file_ref` write, with the rev read first and one stale retry.
 *
 * @param {{ call: (method: string, path: string, opts: object) => Promise<{ok:boolean,status:number,text:string}> }} client
 * @param {object} body  `html`/`title`/`agent`/`tags`/`slug`, plus `id` for an update
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok: boolean, error: string, file: object|null, retried: boolean}>}
 */
export async function publishThroughHub(client, body, signal) {
  if (!client) return { ok: false, error: 'the hub is not configured', file: null, retried: false };

  // 1. The rev we are writing against. Nothing else matters if this fails,
  //    because the hub will refuse the write outright.
  const rev = await readRev(client, signal);
  if (rev === null) {
    return {
      ok: false,
      error: 'could not read the current revision from the hub (GET /files)',
      file: null,
      retried: false,
    };
  }

  // 2. The write, naming that rev. `rev` is a NUMBER on the wire, so it is passed
  //    through unmodified rather than stringified.
  let r = await client.call('POST', '/files', { body: { ...body, rev }, signal });
  let retried = false;

  // 3. Lost the race: adopt the winning rev and try ONCE more.
  if (!r.ok) {
    const failure = readFailure(r.text);
    const next = failure.code === 'STALE_REV' ? failure.rev : null;
    if (next !== null && next !== rev) {
      retried = true;
      r = await client.call('POST', '/files', { body: { ...body, rev: next }, signal });
    }
  }

  if (!r.ok) {
    // `REV_REQUIRED` here would mean the hub ignored the rev we sent, which is a
    // different fault from a lost race; either way the text is the truth, and the
    // caller turns it into a warning the wearer can read.
    return { ok: false, error: `${r.status} ${String(r.text ?? '').slice(0, 300)}`, file: null, retried };
  }

  try {
    const parsed = JSON.parse(r.text || '{}');
    // The record comes back under `file` — not `item`, which is what the todo,
    // doc and agent routes use. Getting that wrong loses the new id, and the id
    // is the only handle on a page that was just published.
    return { ok: true, error: '', file: parsed?.file ?? null, retried };
  } catch {
    return { ok: true, error: '', file: null, retried };
  }
}

/** The hub's current rev, from a read that is cheap because it pages by one. */
async function readRev(client, signal) {
  try {
    const r = await client.call('GET', '/files?limit=1', { signal });
    if (!r.ok) return null;
    const parsed = JSON.parse(r.text || '{}');
    const n = Number(parsed?.rev);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * The machine code and the winning rev out of a refusal.
 *
 * `details.rev` is the sibling that carries the number; `details.current` holds
 * the hub STATE and has no `rev` of its own.
 */
function readFailure(text) {
  try {
    const parsed = JSON.parse(String(text ?? ''));
    const code = String(parsed?.code ?? '');
    const n = Number(parsed?.details?.rev);
    return { code, rev: Number.isFinite(n) ? n : null };
  } catch {
    return { code: '', rev: null };
  }
}
