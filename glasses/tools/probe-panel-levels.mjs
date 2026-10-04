/**
 * PROBE (not part of the sweep — needs a live simulator, so it is named
 * `probe-*` to stay out of `sim-all.mjs`).
 *
 * Verifies the 0.3.45 panel work on the RUNNING page, not on the pure view
 * functions: the container building, the ring routing and the boot redirect are
 * all in `main.ts`, and those are the pieces menu-sim cannot reach.
 *
 *   Change 1 — Agents and Docs each have three levels, and a level is only WHERE
 *     THE FOCUS IS, never a new screen:
 *       L1 `1:master:0:200:…|2:detail:208:368:…`      the split, the LIST lit
 *       L2 `1:master:0:200:…|2:detail:208:368:…`      the SAME split, the DETAIL lit
 *       L3 `1:detail:0:576:`                           the detail alone, whole canvas
 *     with one tap advancing a level and one double-tap popping one.
 *
 *     L1 and L2 carry byte-identical geometry: the only fields that differ are the
 *     per-pane `borderWidth:isEventCapture` pair, i.e. which of the two is lit.
 *     The probe asserts exactly that, because "the border moved and nothing else
 *     did" is the whole point of levels 1–2 — the detail is already on screen at
 *     L1, so stepping in must not swap in a different screen.
 *   Change 2 — the app BOOTS onto the Agents page.
 *
 * The geometry is read from the app's own rebuild log, which carries the pane
 * signature: `[hub] rebuildPageContainer (panel) -> {ok} {section} {level} {sig}`.
 *
 * Setup:
 *   npm run dev
 *   npx evenhub-simulator --no-glow --automation-port 9898 http://127.0.0.1:5175
 * Run:
 *   node tools/probe-panel-levels.mjs
 */
const BASE = 'http://127.0.0.1:9898';

let lastId = 0;
let fail = 0;
let skip = 0;

function check(label, ok, detail = '') {
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}
function note(label, detail = '') {
  skip += 1;
  console.log(`SKIP  ${label}${detail ? `  ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(path, body) {
  const res = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}

async function snapshot() {
  const r = await req(`/api/console?since_id=${lastId}`);
  const j = await r.json();
  const entries = j.entries ?? [];
  if (entries.length) lastId = Math.max(...entries.map((e) => e.id));
  return entries.map((e) => e.message ?? '');
}

/** Frame and save a screenshot; returns its byte length (a cheap "it drew"). */
async function shot(name) {
  const r = await req('/api/screenshot/glasses');
  const buf = Buffer.from(await r.arrayBuffer());
  const { writeFileSync } = await import('node:fs');
  writeFileSync(name, buf);
  return buf.length;
}

/** Drain the console for `seconds` (the endpoint lags the render loop). */
async function drain(seconds = 1.6) {
  const msgs = [];
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    msgs.push(...(await snapshot()));
    await sleep(300);
  }
  return msgs;
}

/** `[hub] rebuildPageContainer (panel) -> true agents 3 1:detail:0:576:…` */
function panels(msgs) {
  const out = [];
  for (const m of msgs) {
    const marker = '[hub] rebuildPageContainer (panel) ->';
    const i = m.indexOf(marker);
    if (i < 0) continue;
    const tail = m
      .slice(i + marker.length)
      .trim()
      .split(/\s+/);
    if (tail.length < 3) continue;
    out.push({
      ok: tail[0] === 'true',
      section: tail[1],
      level: Number(tail[2]),
      sig: tail.slice(3).join(' '),
    });
  }
  return out;
}

function menuIds(msgs) {
  return msgs
    .filter((m) => m.includes('[hub] menu item '))
    .map((m) => Number(m.split('[hub] menu item ')[1].trim()));
}

/**
 * The `borderWidth:isEventCapture` pair of the pane drawn at `x`/`w`. `2:1` means
 * the pane carries the 2px border and owns the ring; `0:0` means it is neither
 * lit nor listening. Those two fields are the ONLY difference between level 1 and
 * level 2, so reading them back is the proof that the border moved.
 */
function lit(sig, x, w) {
  const m = new RegExp(`:${x}:${w}:(\\d+):(\\d+):`).exec(sig);
  return m ? `${m[1]}:${m[2]}` : '';
}

/** The coordinates a pane can be drawn at — master/detail of the split, or full. */
const PANE_GEO = /:(0:200|208:368|0:576):\d+:\d+:/g;

/**
 * The signature with only the lit/ring flags masked, so two levels can be diffed
 * for everything EXCEPT the focus. Masking by geometry (not by a bare digit
 * pattern) keeps pane CONTENT from being accidentally rewritten.
 */
const contentOnly = (sig) => sig.replace(PANE_GEO, (_, geo) => `:${geo}:*:*:`);

const last = (a) => (a.length ? a[a.length - 1] : null);

/** Send one of the sim's input actions. */
const send = (action) => req('/api/input', { action });

/** Ring: `down` x rows then a tap, on the open contextual menu. */
async function pickRow(rows) {
  await send('context_menu');
  await sleep(500);
  for (let i = 0; i < rows; i += 1) {
    await send('down');
    await sleep(90);
  }
  await send('click');
  const msgs = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    msgs.push(...(await snapshot()));
    await sleep(300);
  }
  return { ids: menuIds(msgs), msgs };
}

// ── 0. the simulator must be there ─────────────────────────────────────────
{
  const r = await req('/api/ping');
  check('simulator reachable (automation API up)', (await r.text()).trim() === 'pong');
}

// ── 1. Change 2 — the app boots onto the Agents page ───────────────────────
// The hub snapshot's own `activeSection` is deliberately NOT trusted: the boot
// redirect is what decides, so a stored `docs` (which is what the seeded hub
// holds) must still come up as Agents.
let bootMsgs = [];
let bootSig = '';
{
  const t0 = Date.now();
  let seen = null;
  while (Date.now() - t0 < 30000) {
    bootMsgs.push(...(await snapshot()));
    const p = panels(bootMsgs);
    if (p.length) seen = p;
    if (seen && last(seen).section === 'agents') break;
    await sleep(400);
  }
  const p = last(panels(bootMsgs));
  bootSig = p ? p.sig : '';
  check(
    'boots onto the Agents page (not the hub snapshot’s section)',
    Boolean(p) && p.section === 'agents',
    p ? `${p.section} L${p.level}` : 'no panel rebuild logged',
  );
  check('Agents opens at L1 (the split, the list lit)', Boolean(p) && p.level === 1, p ? `L${p.level}` : '');
  check(
    'L1 is the SPLIT — the detail panel is already on screen beside the list',
    Boolean(p) && /^1:master:0:200:[^|]*\|2:detail:208:368:/.test(p.sig),
    p ? p.sig.slice(0, 70) : '',
  );
  check(
    'L1 lights the LIST and leaves the detail panel unlit',
    Boolean(p) && lit(p.sig, 0, 200) === '2:1' && lit(p.sig, 208, 368) === '0:0',
    p ? `list ${lit(p.sig, 0, 200)} · detail ${lit(p.sig, 208, 368)}` : '',
  );
}

// ── 2. Tap advances a level; level 2 moves the BORDER, not the panes ───────
let litL1 = 0;
{
  litL1 = await shot('agents-L1.png');
  await send('click');
  const msgs = await drain(1.6);
  const p = last(panels(msgs));
  check('tap 1 → L2 (the focus moved to the detail)', Boolean(p) && p.section === 'agents' && p.level === 2, p ? `${p.section} L${p.level}` : 'no rebuild');
  check(
    'L2 keeps the level-1 split: list 200px + detail 368px',
    Boolean(p) && /^1:master:0:200:[^|]*\|2:detail:208:368:/.test(p.sig),
    p ? p.sig.slice(0, 70) : '',
  );
  check(
    'L2 lights the DETAIL and leaves the list unlit',
    Boolean(p) && lit(p.sig, 0, 200) === '0:0' && lit(p.sig, 208, 368) === '2:1',
    p ? `list ${lit(p.sig, 0, 200)} · detail ${lit(p.sig, 208, 368)}` : '',
  );
  check(
    'L1 → L2 changed nothing BUT the focus (same panes, same content)',
    Boolean(p) && bootSig !== '' && contentOnly(p.sig) === contentOnly(bootSig),
    p ? p.sig.slice(0, 70) : '',
  );

  await sleep(300);
  const litL2 = await shot('agents-L2.png');
  check('L2 draws (framebuffer is not blank)', litL2 > 400, `${litL2} bytes of PNG`);

  await send('click');
  const msgs2 = await drain(1.6);
  const q = last(panels(msgs2));
  check('tap 2 → L3 (detail alone)', Boolean(q) && q.section === 'agents' && q.level === 3, q ? `${q.section} L${q.level}` : 'no rebuild');
  check(
    'L3 is ONE full-canvas container showing the DETAIL pane, unframed',
    Boolean(q) && /^1:detail:0:576:0:1:/.test(q.sig),
    q ? q.sig.slice(0, 60) : '',
  );

  await sleep(300);
  const litL3 = await shot('agents-L3.png');
  check('L3 draws', litL3 > 400, `${litL3} bytes of PNG`);
}

// ── 3. At L3 the ring pages the transcript instead of moving the cursor ────
{
  await send('down');
  const msgs = await drain(1.4);
  const p = panels(msgs);
  check(
    'a swipe at L3 does NOT step back a level',
    p.length === 0 || p.every((x) => x.level === 3),
    p.length ? `levels seen: ${p.map((x) => x.level).join(',')}` : 'no rebuild (page already last)',
  );
}

// ── 4. Double-tap pops exactly one level at a time ─────────────────────────
{
  await send('double_click');
  const a = last(panels(await drain(1.4)));
  check('double-tap 1 pops L3 → L2', Boolean(a) && a.level === 2, a ? `L${a.level}` : 'no rebuild');

  await send('double_click');
  const b = last(panels(await drain(1.4)));
  check('double-tap 2 pops L2 → L1', Boolean(b) && b.level === 1, b ? `L${b.level}` : 'no rebuild');
  check(
    'L1 again is the split with the LIST lit — the round trip ends where it began',
    Boolean(b) && /1:master:0:200:2:1:/.test(b.sig) && /2:detail:208:368:0:0:/.test(b.sig),
    b ? b.sig.slice(0, 60) : '',
  );
  check(
    'stepping back never lands on a full-canvas master list (that model is gone)',
    Boolean(b) && !b.sig.includes('1:master:0:576:'),
    b ? b.sig.slice(0, 60) : '',
  );
  // NOT another double-tap here: at L1 it is the app's exit gesture.
}

// ── 5. The Docs panel runs the same three levels ───────────────────────────
// Reached through the section menu. The row order comes from `sectionMenu`:
//   agents tab (no run, nothing to undo): Jarvis(30) Back(21) Trigger(34) Dictate(20)
//   plain tab                          : Jarvis(30) To-Do(1) Docs(2) Notes(3) Agents(4) Dictate(20)
// The delivered id is asserted against the expectation, so a wrong guess is
// reported rather than silently mis-driving the page.
{
  const back = await pickRow(1);
  const gotBack = last(back.ids);
  check('agents menu row 1 is Back(21)', gotBack === 21, `delivered ${gotBack}`);

  const r = await drain(1.2);
  const plain = last(panels(r)) ?? null;
  const section = plain ? plain.section : '<plain tab, no panels>';
  check('Back leaves the Agents panel', plain === null, section);

  const docs = await pickRow(2);
  const gotDocs = last(docs.ids);
  check('plain-tab menu row 2 is Docs(2)', gotDocs === 2, `delivered ${gotDocs}`);

  const after = await drain(1.6);
  const p = last(panels(after));
  check('Docs opens at L1 (the split, the list lit)', Boolean(p) && p.section === 'docs' && p.level === 1, p ? `${p.section} L${p.level}` : 'no rebuild');
  check(
    'Docs L1 is the SPLIT, the body already beside the list',
    Boolean(p) && /1:master:0:200:2:1:/.test(p.sig) && /2:detail:208:368:0:0:/.test(p.sig),
    p ? p.sig.slice(0, 60) : '',
  );
  check(
    'Docs L1 lists document titles (not the body)',
    Boolean(p) && /Alpha|Beta|Untitled|Doc/i.test(p.sig),
    p ? p.sig.slice(0, 90) : '',
  );

  if (p) {
    await send('click');
    const d2 = last(panels(await drain(1.6)));
    check('Docs tap 1 → L2 (the focus moved to the body)', Boolean(d2) && d2.level === 2, d2 ? `L${d2.level}` : 'no rebuild');
    check(
      'Docs L2 keeps the split and lights the BODY instead of the list',
      Boolean(d2) && /1:master:0:200:0:0:/.test(d2.sig) && /2:detail:208:368:2:1:/.test(d2.sig),
      d2 ? d2.sig.slice(0, 70) : '',
    );
    check(
      'Docs L1 → L2 changed nothing BUT the focus',
      Boolean(d2) && Boolean(p) && contentOnly(d2.sig) === contentOnly(p.sig),
      d2 ? d2.sig.slice(0, 70) : '',
    );

    await send('click');
    const d3 = last(panels(await drain(1.6)));
    check('Docs tap 2 → L3 (detail alone)', Boolean(d3) && d3.level === 3, d3 ? `L${d3.level}` : 'no rebuild');
    check(
      'Docs L3 is ONE full-canvas container showing the body',
      Boolean(d3) && /^1:detail:0:576:/.test(d3.sig),
      d3 ? d3.sig.slice(0, 60) : '',
    );

    await send('double_click');
    const d4 = last(panels(await drain(1.4)));
    check('Docs double-tap pops L3 → L2', Boolean(d4) && d4.level === 2, d4 ? `L${d4.level}` : 'no rebuild');
  }
}

console.log(
  `\n${fail === 0 ? 'ALL CHECKS PASSED' : `${fail} CHECK(S) FAILED`}${skip ? ` (${skip} skipped)` : ''}`,
);
process.exit(fail === 0 ? 0 : 1);
