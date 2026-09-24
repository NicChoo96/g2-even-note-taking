// The DOCUMENT ORIGIN — a SECOND origin for untrusted, agent-authored pages.
//
// WHY THIS MODULE EXISTS
//   The Files page shows a stored document by framing it. Served from the
//   relay's own origin, that frame MUST carry
//   `Content-Security-Policy: sandbox allow-scripts` (see SANDBOX_CSP in
//   jarvis-files.mjs), and that policy has two measured consequences:
//
//     • it declares no `frame-src`, so a nested YouTube frame falls back to
//       `default-src 'none'` and the browser refuses it before it ever loads
//       (`ERR_BLOCKED_BY_RESPONSE`), and
//     • it withholds `allow-same-origin`, so the nested document gets an OPAQUE
//       origin — and YouTube's player needs cookies, storage and postMessage on
//       a real one, so it refuses to draw.
//
//   Both were confirmed live, not reasoned about: one video, four frames. No
//   sandbox -> the FULL player. `allow-scripts`, with or without
//   `allow-presentation` -> BLANK. `allow-scripts allow-same-origin` -> the full
//   player again. Every one of those frames successfully LOADED the youtube.com
//   document, so a URL check cannot see the difference. Only pixels can.
//
//   Two conclusions follow. First, the sandbox cannot be relaxed: the ONE flag
//   that would make video work, `allow-same-origin`, is the flag that would put
//   agent-authored HTML on our origin, which is exactly what the sandbox is for.
//   Second, it cannot be circumvented from inside the frame either — a policy is
//   applied before the document exists (so there is no far side to hand anything
//   to), sandbox flags only ever ACCUMULATE downward (there is no unsandbox),
//   and `postMessage` out of an opaque origin reports `event.origin === 'null'`,
//   so no receiver can validate a counterparty. Nothing inside the box can
//   negotiate its way out. The only fix is to stop serving the document from
//   our origin at all.
//
// THE DESIGN
//   Serve the document from a host that is not the app's host. Then the sandbox
//   is unnecessary rather than forbidden — origin separation is a STRONGER
//   guarantee than a sandbox flag, and it costs the document none of its
//   fidelity. `frame-ancestors` restricts who may embed it, and an embedded
//   player sees a real origin, so it draws.
//
//   That second host is this same relay with `DOCS_ORIGIN` set: a second
//   listener locally, a second service in production. It needs NO work on the
//   content gateway, and that is the point. The gateway keeps being what it
//   should be — a credential-holding store that no browser ever talks to
//   directly, and that no browser ever frames. The alternative would mean
//   handing the service that owns our credentials a TLS cert, a hostname, a
//   CORS policy, a header change and a ticket endpoint; each is new attack
//   surface on the one machine we would rather never reconfigure. The gateway is
//   also still plain `http://` on a bare IP, and an HTTPS app cannot frame an
//   HTTP URL at all — a hard mixed-content block with no exception — so framing
//   it was never available.
//
// THE TICKET
//   The frame URL cannot carry the owner session token: the document can read
//   `location`, so that would hand agent-authored code the key to the whole
//   store. Instead the relay — which has already authenticated the caller —
//   mints a per-document ticket, and the session token never leaves the server:
//
//     <id>.<expiry>.<HMAC-SHA256(secret, "<id>.<expiry>")>
//
//   URL-safe, ~2 minutes, bound to exactly one document id. It travels in the
//   PATH, never the query, and the response sets
//   `Referrer-Policy: strict-origin-when-cross-origin`, so a cross-origin
//   subresource the document loads sends only the host and never the path — the
//   ticket cannot leak through a `Referer` header.
//
//   Deliberately NOT single-use. A frame is legitimately re-fetched (reload,
//   HTTP retry, back navigation), and burning the ticket on first read would
//   turn a correct reload into a blank frame — the precise bug this module
//   exists to remove. The bound is instead the short TTL plus the id binding:
//   a ticket is a capability for ONE document, for about two minutes.
//
// NO COOKIES, ANYWHERE
//   This is what makes the origin split clean. The relay sets no cookie at all —
//   every credential is a Bearer token or a `?token=` parameter — so a document
//   on the second origin inherits no ambient authority for its code to spend. If
//   a cookie is ever introduced on the app origin, revisit this file first: the
//   whole argument above assumes there is none.
//
//   Note also that the document host must NOT be a subdomain of the app's own
//   registrable domain, or a `Domain=.example.com` cookie would be readable by
//   model-authored code. A genuinely different domain, or a provider-managed one
//   such as `*.digitaloceanspaces.com`, keeps that door shut.
//
// PURE BY DESIGN
//   No imports beyond `node:crypto`, no I/O, no server-boot side effect, and
//   `now` is injectable everywhere — so expiry is asserted by arithmetic in
//   files-sim.mjs rather than by waiting two minutes.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Must stay in step with the id pattern the relay's files routes accept. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Long enough for a slow frame load, short enough that a leaked URL dies. */
export const DOC_TICKET_TTL_MS = 2 * 60 * 1000;

/** Where the document origin serves. One segment — the ticket carries the id. */
export const DOC_PREFIX = '/d/';

/** A ticket is well under 200 bytes; anything longer is not one of ours. */
const TICKET_MAX_CHARS = 512;

/** A fresh HMAC key. Two processes that must agree share it through the env. */
export function newDocSecret() {
  return randomBytes(32).toString('base64url');
}

function macOf(id, expiryText, secret) {
  return createHmac('sha256', secret).update(`${id}.${expiryText}`).digest('base64url');
}

/** Constant-time compare that cannot throw on a length mismatch. */
function sameSecret(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Mint a frame ticket for ONE document.
 *
 * Throws on a malformed id rather than signing it: a ticket for an id the relay
 * would refuse is a ticket that can only ever produce a confusing blank frame.
 */
export function signDocTicket(id, { secret, ttlMs = DOC_TICKET_TTL_MS, now = Date.now() } = {}) {
  if (!ID_RE.test(String(id))) throw new Error(`signDocTicket: bad document id`);
  if (!secret) throw new Error('signDocTicket: needs a secret');
  const exp = String(now + ttlMs);
  return `${id}.${exp}.${macOf(id, exp, secret)}`;
}

/**
 * Verify a ticket and recover the document id from it, or say why not.
 *
 * The signature is checked BEFORE the expiry, so a forged ticket learns nothing
 * about the clock. The expiry is re-signed from the DECIMAL TEXT it arrived as,
 * so `…0000000077…` fails the signature instead of being normalised into the
 * value 77 — the ticket is compared, never parsed and then trusted.
 */
export function verifyDocTicket(ticket, { secret, now = Date.now() } = {}) {
  const bad = (reason) => ({ ok: false, reason });
  if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > TICKET_MAX_CHARS) {
    return bad('malformed');
  }
  const parts = ticket.split('.');
  if (parts.length !== 3) return bad('malformed');
  const [id, expText, mac] = parts;
  if (!ID_RE.test(id) || !/^\d{1,16}$/.test(expText) || !mac) return bad('malformed');
  if (!secret || !sameSecret(mac, macOf(id, expText, secret))) return bad('signature');
  const expiresAt = Number(expText);
  if (now >= expiresAt) return bad('expired');
  return { ok: true, id, expiresAt };
}

/**
 * The policy for a document on its OWN origin.
 *
 * There is deliberately no `sandbox` directive, and that is the entire point:
 * the document keeps a real origin, so an embedded player can use storage and
 * cookies belonging to the DOCUMENT host — never to the app. The remaining terms
 * bound what page-authored code may reach. The security boundary here is the
 * origin split, and this policy is not asked to carry it alone.
 *
 * `frame-ancestors` is the one term that must be right. Get it wrong and the
 * document renders blank — the exact symptom this module exists to fix — so
 * `local-sse.mjs` logs the value it settled on at boot and warns when a second
 * process cannot verify this one's tickets.
 */
export function docCsp(frameAncestors) {
  return [
    `frame-ancestors ${frameAncestors}`,
    "default-src 'self' https: http: data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http:",
    "style-src 'self' 'unsafe-inline' https: http:",
    "img-src 'self' https: http: data: blob:",
    "media-src 'self' https: http: data: blob:",
    "frame-src 'self' https: http:",
    "connect-src 'self' https: http:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** Response headers for a document served from the document origin. */
export function docResponseHeaders(frameAncestors, contentType = 'text/html; charset=utf-8') {
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': docCsp(frameAncestors),
    // NOT X-Frame-Options. It cannot express "only this app", and sending it
    // alongside frame-ancestors means the older header wins on browsers that
    // still honour it, which would block and blank the frame.
    'X-Content-Type-Options': 'nosniff',
    // Cross-origin subresources are told the HOST and never the path, so the
    // ticket in the path cannot escape through a Referer header.
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': 'private, no-store',
  };
}

/** An origin with trailing slashes stripped, or '' when it is not usable. */
export function normalizeDocOrigin(raw) {
  const s = String(raw ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+$/.test(s) ? s : '';
}

/** The absolute URL a frame points at, on the document origin. */
export function docFrameUrl(origin, ticket) {
  return `${normalizeDocOrigin(origin)}${DOC_PREFIX}${ticket}`;
}

/** The ticket out of a `/d/<ticket>` path — null when the path is not one. */
export function docTicketFromPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(DOC_PREFIX)) return null;
  const rest = pathname.slice(DOC_PREFIX.length);
  return rest.length === 0 || rest.includes('/') ? null : rest;
}
