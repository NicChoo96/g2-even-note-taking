// Publishing a document through the HUB, which is the only path that records it.
//
// WHY THIS EXISTS
//   `jarvis_files publish` used the gateway's MCP family (`create_session`), which
//   writes the BODY. The Files page lists the hub's `file_ref` registry
//   (`GET /hub/files`). Two API families on one service, and only one of them
//   records what exists — so a run could truthfully report "Published … read back
//   at version 1" and the page would show nothing at all. That is the bug the
//   wearer reported four times, and it was never a hallucination.
//
//   The captured backend spec is explicit about `POST /hub/files`: "Publish a body
//   to the gateway, then record the reference to it." One call, one authority.
//
// WHY IT IS A MODULE
//   The rev retry is the part that can go wrong silently. `rev` is the hub's write
//   token and it travels in the BODY, so a second writer between our read and our
//   write is answered `412` with the current rev in `details.current`. Getting that
//   wrong turns every publish into a failed one, and importing `local-sse.mjs` to
//   test it starts a server — so the logic lives here, where a harness can drive
//   it with a fake client.

/**
 * POST one `file_ref` write, adopting the hub's rev if it refuses ours.
 *
 * @param {{ call: (method: string, path: string, opts: object) => Promise<{ok:boolean,status:number,text:string}> }} client
 *        the hub client from `hubRuntime()` — a passthrough, not a hub client
 * @param {object} body  `html`/`title`/`agent`/`tags`/`slug`, plus `id` for an update
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok: boolean, error: string, file: object|null, retried: boolean}>}
 */
export async function publishThroughHub(client, body, signal) {
  if (!client) return { ok: false, error: 'the hub is not configured', file: null, retried: false };

  const send = (rev) =>
    client.call('POST', '/files', {
      // No `rev` at all on the first attempt: sending an empty one is a value,
      // and the hub would read it as a deliberate stale write.
      body: rev ? { ...body, rev } : { ...body },
      signal,
    });

  let r = await send('');
  let retried = false;

  if (!r.ok && (r.status === 412 || r.status === 409)) {
    const current = readCurrentRev(r.text);
    // A rev we cannot read is NOT guessed at. Guessing a write token is how two
    // writers start overwriting each other, and the refusal is already honest.
    if (current) {
      retried = true;
      r = await send(current);
    }
  }

  if (!r.ok) return { ok: false, error: `${r.status} ${String(r.text ?? '').slice(0, 300)}`, file: null, retried };

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

/** The rev a 412/409 names, or '' when the body does not carry one. */
function readCurrentRev(text) {
  try {
    const parsed = JSON.parse(String(text ?? ''));
    const current = parsed?.details?.current ?? parsed?.current ?? null;
    const rev = current?.rev ?? parsed?.rev ?? '';
    return typeof rev === 'string' ? rev : '';
  } catch {
    return '';
  }
}
