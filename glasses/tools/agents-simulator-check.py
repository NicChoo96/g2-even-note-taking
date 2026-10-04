"""Headless verification of the Agents feature against the live simulator.

Asserts on the app's own console logs (`[hub] render`, `[hub] menu item`,
`[hub] rebuildPageContainer (panel)`) plus framebuffer lit-pixel counts from the
RGBA alpha channel -- never on screenshot text: the OS menu overlay is drawn in a
layer the framebuffer lacks (it shows up as an empty rectangle).

Panel levels (sections.ts, 0.3.45)
----------------------------------
The Agents AND the Docs tab run the SAME three-level model, so the ring is routed
by the PAGE level rather than by which container received the event:
  * level 1  master list alone, ONE full-canvas container
  * level 2  master list (200px) + detail panel (368px at x=208)
  * level 3  detail alone, ONE full-canvas container
One tap advances a level; one double-tap steps back (L3->L2->L1) and at level 1
it is the app's exit gesture. The rebuild log therefore leads with the section and
the LEVEL: `[hub] rebuildPageContainer (panel) -> {ok} {section} {level} {sig}`.
`[hub] render` reports the section, the text length and the cursor.

Simulator facts this harness is built around
--------------------------------------------
* `context_menu` TOGGLES the OS overlay and it stays open for several seconds.
  While open, the overlay DIMS the page, so the lit-pixel count DROPS.
* `click` on the glasses page delivers a CLICK_EVENT to the app (advance a level).
  `double_click` pops a level, so only send it where a level is left to pop --
  at level 1 it shuts the page down.
* `down` on a single full-width text container produces textEvent type 2
  (SCROLL_BOTTOM_EVENT) -> the app's onSwipe(1), i.e. it moves the cursor, or
  pages the detail pane at level 3.
* The console endpoint lags the render loop by ~1s, so every assertion drains the
  console with a single `snapshot()` call after settling.

Menu layouts (sections.ts sectionMenu) -- the ROW INDEX is the ring `down` count
  * Plain tab  : Jarvis(30) [Undo AI] To-Do(1) Docs(2) Notes(3) Agents(4) Dictate(20)
  * Agents tab : Jarvis(30) [Undo AI] Back(21) [Trigger(34)|Stop(35)] Dictate(20)
  * Docs tab   : Jarvis(30) [Undo AI] Back(21) New Docs(10) [Select/Delete] Dictate(20)
`Undo AI` appears only when there is something to revert, so read the delivered id
back out of `[hub] menu item N` instead of trusting a fixed row index. The section
switchers are HIDDEN on the Agents/Docs tabs, so Back is the only way off them.

The app BOOTS onto the Agents page (main.ts `bootRedirect`), whatever section the
hub snapshot happens to carry, so every run starts there.

Run the seed first:  python tools/seed-agents-state.py
Usage:              python tools/agents-simulator-check.py [--exit]
                    (--exit shuts the page down; restart the simulator after)
"""
import json
import struct
import sys
import time
import urllib.request
import zlib

BASE = "http://127.0.0.1:9898"
RELAY = "http://127.0.0.1:5198"
RELAY_TOKEN = "devownerecb53dde7bf41d07"
FAIL = 0
_last_id = 0

# Console details carry the ▲▼ / — glyphs the app draws; don't crash on a
# cp1252 stdout (Windows default when the output is piped).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def check(label, ok, detail=""):
    global FAIL
    if not ok:
        FAIL += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"  {detail}" if detail else ""))


def _req(path, data=None, method="GET"):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read()


def shot(name=None):
    raw = _req("/api/screenshot/glasses")
    if name:
        with open(name, "wb") as f:
            f.write(raw)
    return raw


def lit_pixels(png_bytes):
    """Count alpha>0 pixels (pure stdlib PNG decode: filters 0-4)."""
    data = png_bytes
    pos, width, height, idat = 8, 0, 0, b""
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        ctype = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        if ctype == b"IHDR":
            width, height, depth, color = struct.unpack(">IIBB", body[:10])
            assert depth == 8 and color == 6, f"unexpected PNG depth={depth} color={color}"
        elif ctype == b"IDAT":
            idat += body
        pos += 12 + length
    raw = zlib.decompress(idat)
    stride = width * 4
    count, prev = 0, bytearray(stride)
    i = 0
    for _ in range(height):
        filt = raw[i]
        i += 1
        line = bytearray(raw[i : i + stride])
        i += stride
        if filt == 1:
            for x in range(4, stride):
                line[x] = (line[x] + line[x - 4]) & 0xFF
        elif filt == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 0xFF
        elif filt == 3:
            for x in range(stride):
                left = line[x - 4] if x >= 4 else 0
                line[x] = (line[x] + ((left + prev[x]) >> 1)) & 0xFF
        elif filt == 4:
            for x in range(stride):
                a = line[x - 4] if x >= 4 else 0
                b = prev[x]
                c = prev[x - 4] if x >= 4 else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pred) & 0xFF
        for x in range(3, stride, 4):
            if line[x] > 0:
                count += 1
        prev = line
    return count


def snapshot(name=None):
    """Drain new console entries and grab one framebuffer frame, atomically."""
    global _last_id
    entries = json.loads(_req(f"/api/console?since_id={_last_id}")).get("entries", [])
    if entries:
        _last_id = max(e["id"] for e in entries)
    msgs = [e.get("message", "") for e in entries]
    return msgs, lit_pixels(shot(name))


def renders(msgs):
    out = []
    for m in msgs:
        if "[hub] render" in m:
            try:
                out.append(json.loads(m.split("[hub] render ", 1)[1]))
            except Exception:
                pass
    return out


def menu_items(msgs):
    out = []
    for m in msgs:
        if "[hub] menu item " in m:
            try:
                out.append(int(m.split("[hub] menu item ", 1)[1].strip()))
            except Exception:
                pass
    return out


def agent_rebuilds(msgs):
    """Panel rebuilds. Both panels share one renderer, so the tag is `(panel)`
    rather than `(agents)` (0.3.45) and the line carries the section and level."""
    return [m for m in msgs if "[hub] rebuildPageContainer (panel)" in m]


def relay_runs():
    """The relay's run store (proves the run left the WebView and went server-side)."""
    req = urllib.request.Request(
        RELAY + "/api/agent/runs",
        headers={"Authorization": f"Bearer {RELAY_TOKEN}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read()).get("runs", [])
    except Exception:
        return []


def panel_state(msgs):
    """Newest panel rebuild as `(section, level)`.

    The log is `... (panel) -> {ok} {section} {level} {signature}` -- the old
    `{agentFocus}` field became the `{level}` of the shared 3-level model, so
    every `agent_focus(...) == 'master'|'detail'` check is now a LEVEL check:
    L1/L2 route the ring to the master list, L3 to the detail.
    """
    for m in reversed(agent_rebuilds(msgs)):
        tail = m.split("->", 1)[-1].split()
        if len(tail) >= 3:
            try:
                return (tail[1], int(tail[2]))
            except ValueError:
                continue
    return ("", 0)


def panel_level(msgs):
    """The level of the newest panel rebuild (0 when none was logged)."""
    return panel_state(msgs)[1]


def drain(seconds=2.4, step=0.3):
    """Accumulate console entries over `seconds` -- the console endpoint lags
    the render loop, so a single snapshot can miss the rebuild that just ran."""
    msgs = []
    t0 = time.time()
    while time.time() - t0 < seconds:
        m, _ = snapshot()
        msgs += m
        time.sleep(step)
    return msgs


def send(action):
    _req("/api/input", {"action": action}, "POST")


def drive(seq, gap=0.09):
    for a in seq:
        send(a)
        time.sleep(gap)


def pick(rows):
    """Open the contextual menu and select item #`rows` (0-based)."""
    send("context_menu")
    time.sleep(0.5)
    drive(["down"] * rows + ["click"])
    time.sleep(1.2)  # let the click land and the app re-render
    msgs = drain(1.5)  # then wait out the console lag
    return menu_items(msgs), msgs


# ── 1. Ready + boot section ────────────────────────────────────────────────
check("simulator reachable", _req("/api/ping").decode().strip() == "pong")


def wait_section(want, timeout=30):
    """Wait until a `[hub] render` log reports `want` as the section."""
    t0 = time.time()
    seen = []
    while time.time() - t0 < timeout:
        m, _ = snapshot()
        seen += renders(m)
        if any(x.get("section") == want for x in seen):
            return seen
        time.sleep(0.4)
    return seen


# 0.3.45: the app BOOTS onto the Agents page (`bootRedirect` in main.ts) whatever
# section the hub snapshot carries -- and the seed deliberately leaves the hub on
# another tab -- so the first frames may still show that stored section and the
# redirect has to be waited for.
r = wait_section("agents")
check("app rendered a page", bool(r), json.dumps(r[-1]) if r else "no render log")
check(
    "boots onto the Agents page (not the hub snapshot's section)",
    bool(r) and r[-1].get("section") == "agents",
    json.dumps(r[-1]) if r else "",
)
msgs, base = snapshot()
check("baseline page has content", base > 400, f"{base} lit px")

# ── 2. Contextual menu opens: the overlay DIMS the page (lit drops) ─────────
send("context_menu")
time.sleep(0.6)
msgs, dimmed = snapshot("menu-open.png")
check("context menu opens (page dims under the overlay)", base - dimmed > 200, f"{base} -> {dimmed} lit px")
send("context_menu")  # toggle closed
time.sleep(0.8)
msgs, restored = snapshot()
check("menu closes and the page restores", abs(restored - base) < base * 0.15, f"{dimmed} -> {restored} (base {base})")

# ── 3. Back leaves the panel; `down`/`up` then arrive as scroll events ──────
# The section switchers are HIDDEN on the Agents/Docs tabs, so Back is the only
# way off the panel. The cursor checks need a plain tab: the render log's
# `cursor` reports the To-Do cursor, which the panel does not own.
ids, msgs = pick(1)
check("agents menu row 1 delivered Back (21)", bool(ids) and ids[-1] == 21, str(ids))
r = renders(msgs)
check(
    "Back leaves the panel for a plain tab",
    any(x.get("section") in ("todo", "docs", "notes") for x in r),
    json.dumps(r[-1]) if r else "",
)
msgs, plain = snapshot()
check("plain tab draws content", plain > 400, f"{plain} lit px")

send("down")
time.sleep(1.2)
msgs, _ = snapshot()
r = renders(msgs)
check("down moves the To-Do cursor", any(x.get("cursor") == 1 for x in r), json.dumps(r[-1]) if r else "")
send("up")
time.sleep(1.2)
msgs, _ = snapshot()
r = renders(msgs)
check("up moves the cursor back", any(x.get("cursor") == 0 for x in r), json.dumps(r[-1]) if r else "")

# ── 4. Switcher -> Agents section (menu item 4) ─────────────────────────────
ids, msgs = pick(4)
check("switcher delivered Agents (4)", 4 in ids, str(ids))
r = renders(msgs)
check("menu switched to the agents section", any(x.get("section") == "agents" for x in r), json.dumps(r[-1]) if r else "")

# ── 5. The panel draws L1 (master list alone) with the seeded data ─────────
# The rebuild fires as part of the section switch, so it is already in the
# messages drained by pick(4) -- keep them and top up.
msgs = msgs + drain(1.5)
lit_master = lit_pixels(shot("agents-L1.png"))
check("agents page draws", lit_master > 400, f"{lit_master} lit px")
reb = agent_rebuilds(msgs)
check("panel page rebuilt on entry", bool(reb), (reb[-1][-60:] if reb else ""))
check("Agents opens at L1 (master list alone)", panel_level(msgs) == 1, f"L{panel_level(msgs)}")
check(
    "L1 is ONE full-canvas container labelled master",
    any("1:master:0:576:" in m for m in reb),
    (reb[-1][-70:] if reb else ""),
)
check(
    "master list shows the seeded agents",
    any("Researcher" in m and "Summarizer" in m for m in reb),
    (reb[-1][-90:] if reb else ""),
)

# ── 6. Tap advances a level; the second tap fills the screen (L1 -> L2 -> L3) ─
send("click")
time.sleep(1.4)
msgs = drain(1.5)
lit_split = lit_pixels(shot("agents-L2.png"))
reb = agent_rebuilds(msgs)
check("tap 1 rebuilds the agents page", bool(reb), (reb[-1][-40:] if reb else ""))
check("tap 1 advances to L2 (list + detail)", panel_level(msgs) == 2, f"L{panel_level(msgs)}")
check(
    "L2 splits the page into master (200px) + detail (368px at x=208)",
    any("1:master:0:200:" in m and "|2:detail:208:368:" in m for m in reb),
    (reb[-1][-80:] if reb else ""),
)
check(
    "the detail pane looks different from the master",
    lit_split != lit_master,
    f"{lit_master} vs {lit_split} lit px",
)

send("click")
time.sleep(1.6)
msgs = drain(1.5)
lit_full = lit_pixels(shot("agents-L3-fullscreen.png"))
reb = agent_rebuilds(msgs)
check("tap 2 advances to L3 (detail alone, full screen)", panel_level(msgs) == 3, f"L{panel_level(msgs)}")
check(
    "L3 is ONE full-canvas container labelled detail",
    any("1:detail:0:576:" in m for m in reb),
    (reb[-1][-80:] if reb else ""),
)
check(
    "L3 draws a different page from L2 (the detail re-wrapped to the canvas)",
    lit_full != lit_split,
    f"{lit_split} vs {lit_full} lit px",
)

# ── 7. Double-tap pops exactly one level (L3 -> L2 -> L1) ────────────────────
# A double-tap at L1 is the app's EXIT gesture, so still having content on the
# page after the second pop proves the pops ran in order instead of jumping out.
send("double_click")  # L3 -> L2
msgs = drain(1.6)
check("double-tap pops L3 -> L2 (list + detail again)", panel_level(msgs) == 2, f"L{panel_level(msgs)}")
check(
    "L2 is back to two containers",
    any("|2:detail:208:368:" in m for m in agent_rebuilds(msgs)),
    (agent_rebuilds(msgs)[-1][-70:] if agent_rebuilds(msgs) else ""),
)
send("double_click")  # L2 -> L1
msgs = drain(1.6)
check("double-tap pops L2 -> L1 (master list alone)", panel_level(msgs) == 1, f"L{panel_level(msgs)}")
still = lit_pixels(shot("agents-popped-to-L1.png"))
check(
    "page is still up at L1 (a double-tap there would have exited)",
    still > 400,
    f"{still} lit px",
)

# ── 8. Agents menu -> Trigger (34) runs the agent's SAVED prompt ────────────
# No dictation: the run is POSTed to the relay (server-side), which streams the
# transcript back as `run` frames the detail pane renders turn by turn. Trigger
# from L2 so the detail pane (which shows the transcript) is on the page.
# Agents-tab menu: Jarvis(30), [Undo AI], Back(21), [Trigger(34)|Stop(35)], Dictate(20)
# -- the section switchers are hidden, so the run control is row 2.
send("click")  # L1 -> L2
msgs = drain(1.2)
runs_before = {r.get("id") for r in relay_runs()}
ids, msgs = pick(2)
check("agents menu row 2 delivered Trigger (34)", 34 in ids, str(ids))
check(
    "Trigger does NOT open dictation",
    not any("[dictate]" in m for m in msgs),
    " | ".join(m[:70] for m in msgs if "[dictate]" in m)[:140],
)
run_msgs = drain(22.0)  # a real run does LLM -> tool HTTP -> LLM; allow it to finish
reb = agent_rebuilds(run_msgs)
check(
    "Trigger repaints the detail pane with run output",
    any(("Thinking" in m) or ("You:" in m) or ("arching" in m) for m in reb),
    " | ".join(m[-110:] for m in reb)[:200],
)
new_runs = [r for r in relay_runs() if r.get("id") not in runs_before and r.get("agentId") == "ag1"]
check(
    "relay recorded the run (GET /api/agent/runs)",
    bool(new_runs),
    json.dumps([(r.get("agentId"), r.get("status"), r.get("prompt", "")[:24]) for r in new_runs]),
)
check(
    "relay ran the agent's SAVED prompt",
    any("AI this week" in (r.get("prompt") or "") for r in new_runs),
    json.dumps([r.get("prompt") for r in new_runs])[:160],
)
check(
    "relay run finished cleanly (no guardrail/key error)",
    bool(new_runs) and not any(r.get("error") for r in new_runs),
    json.dumps([(r.get("status"), (r.get("error") or "")[:80]) for r in new_runs])[:240],
)

# ── 9. No uncaught errors in the WebView console ────────────────────────────
msgs, _ = snapshot()
errs = [m for m in msgs if "error" in m.lower() and "favicon" not in m.lower()]
check("no console errors", not errs, " | ".join(m[:70] for m in errs)[:160])

# ── 10. Double-tap at L1 exits (opt-in: it shuts the page down, so the
#        simulator must be restarted before the next run) ─────────────────
# The app handles DOUBLE_CLICK_EVENT at level 1 by calling
# shutDownPageContainer(1) and logs nothing, so assert on the delivered event +
# the page going blank.
if "--exit" in sys.argv:
    # Section 8 left the ring on the DETAIL, and a double-tap there only pops a
    # level -- step back to L1 first so the EXIT gesture is what gets tested.
    send("double_click")  # L2 -> L1
    time.sleep(1.4)
    drain(0.8)
    send("double_click")  # L1 -> shut the page down
    time.sleep(2.0)
    msgs = drain(1.2)
    check(
        "double-tap delivers DOUBLE_CLICK_EVENT (3)",
        any('"eventType":3' in m for m in msgs),
        " | ".join(m[:70] for m in msgs if '"eventType":3' in m)[:120],
    )
    blank = lit_pixels(shot())
    check("double-tap shuts the page down (framebuffer blank)", blank == 0, f"{blank} lit px")
else:
    print("SKIP  double-tap exit gesture (pass --exit; restart the simulator afterwards)")

print(f"\n{FAIL} FAILURE(S)" if FAIL else "\nALL PASS")
sys.exit(1 if FAIL else 0)
