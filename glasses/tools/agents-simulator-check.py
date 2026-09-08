"""Headless verification of the Agents feature against the live simulator.

Asserts on the app's own console logs (`[hub] render`, `[hub] menu item`,
`[hub] rebuildPageContainer (agents)`) plus framebuffer lit-pixel counts from the
RGBA alpha channel -- never on screenshot text: the OS menu overlay is drawn in a
layer the framebuffer lacks (it shows up as an empty rectangle).

Simulator facts this harness is built around
--------------------------------------------
* `context_menu` TOGGLES the OS overlay and it stays open for several seconds.
  While open, the overlay DIMS the page, so the lit-pixel count DROPS.
* `click` on the glasses page delivers a CLICK_EVENT to the app (toggle item).
  `double_click` is the app's exit gesture, so it must come LAST.
* `down` on a single full-width text container produces textEvent type 2
  (SCROLL_BOTTOM_EVENT) -> the app's onSwipe(1), i.e. it moves the cursor.
* The console endpoint lags the render loop by ~1s, so every assertion drains the
  console with a single `snapshot()` call after settling.

Menu layouts (sections.ts sectionMenu)
  * Any tab    : Dictate(20) To-Do(1) Docs(2) Notes(3) Agents(4)
  * Agents tab : Dictate(20) Back(21) Select Agents(30) New Agents(31)
                 [Delete Agents(32) Run(33) when agents exist]

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
    return [m for m in msgs if "[hub] rebuildPageContainer (agents)" in m]


def agent_focus(msgs):
    """The rebuild log is `... (agents) -> {ok} {agentFocus} {signature}`."""
    for m in reversed(agent_rebuilds(msgs)):
        tail = m.split("->", 1)[-1].split()
        if len(tail) >= 2:
            return tail[1]
    return ""


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


def wait_render(timeout=25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        msgs, _ = snapshot()
        if renders(msgs):
            return msgs
        time.sleep(0.4)
    return []


# ── 1. Ready + baseline (seed sets activeSection=todo, 2 tasks) ─────────────
check("simulator reachable", _req("/api/ping").decode().strip() == "pong")
msgs = wait_render()
r = renders(msgs)
check("app rendered a page", bool(r), json.dumps(r[-1]) if r else "no render log")
check("starts on the To-Do tab", bool(r) and r[-1].get("section") == "todo", json.dumps(r[-1]) if r else "")
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

# ── 3. `down`/`up` reach the app as scroll events (cursor moves) ────────────
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

# ── 5. Master/detail layout draws with the seeded data ──────────────────────
# The dual-container rebuild fires as part of the section switch, so it is
# already in the messages drained by pick(4) -- keep them and top up.
msgs = msgs + drain(1.5)
lit_master = lit_pixels(shot("agents-master.png"))
check("agents page draws both panes", lit_master > 400, f"{lit_master} lit px")
reb = agent_rebuilds(msgs)
check("dual-container page built", bool(reb), (reb[-1][-60:] if reb else ""))
check("master pane owns focus on entry", agent_focus(msgs) == "master", agent_focus(msgs))
check(
    "master pane lists the seeded agents",
    any("Researcher" in m and "Summarizer" in m for m in reb),
    (reb[-1][-90:] if reb else ""),
)
check(
    "detail pane shows the agent, its tool and session",
    any("tavily_search" in m and "session 1/2" in m for m in reb),
    (reb[-1][-140:] if reb else ""),
)

# ── 6. Tap hands control to the detail pane ─────────────────────────────────
send("click")
time.sleep(1.4)
msgs = drain(1.5)
lit_detail = lit_pixels(shot("agents-detail.png"))
reb = agent_rebuilds(msgs)
check("tap rebuilds the agents page", bool(reb), (reb[-1][-40:] if reb else ""))
check("tap focuses the detail pane", agent_focus(msgs) == "detail", agent_focus(msgs))
check("detail pane looks different from the master", lit_detail != lit_master, f"{lit_master} vs {lit_detail} lit px")

# ── 7. Agents menu -> Select Agents (30) returns control to master ──────────
ids, msgs = pick(2)
check("agents menu delivered Select Agents (30)", 30 in ids, str(ids))
check("Select Agents focuses the master pane", agent_focus(msgs) == "master", agent_focus(msgs))

# ── 8. Agents menu -> Back (21) leaves the agents view ──────────────────────
ids, msgs = pick(1)
check("agents menu delivered Back (21)", 21 in ids, str(ids))
r = renders(msgs)
check(
    "Back restores a normal tab",
    any(x.get("section") in ("todo", "docs", "notes") for x in r),
    json.dumps(r[-1]) if r else "",
)

# ── 9. Agents menu -> Run (33) starts dictation to capture the prompt ───────
pick(4)  # back into agents
ids, msgs = pick(5)
check("agents menu delivered Run (33)", 33 in ids, str(ids))
check(
    "Run starts dictation to capture the prompt",
    any("[dictate]" in m for m in msgs),
    " | ".join(m[:70] for m in msgs if "[dictate]" in m)[:140],
)

# ── 10. No uncaught errors in the WebView console ───────────────────────────
msgs, _ = snapshot()
errs = [m for m in msgs if "error" in m.lower() and "favicon" not in m.lower()]
check("no console errors", not errs, " | ".join(m[:70] for m in errs)[:160])

# ── 11. Double-tap exits (opt-in: it shuts the page down, so the simulator
#        must be restarted before the next run) ─────────────────────────────
# The app handles DOUBLE_CLICK_EVENT by calling shutDownPageContainer(1) and
# logs nothing, so assert on the delivered event + the page going blank.
if "--exit" in sys.argv:
    send("double_click")
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
