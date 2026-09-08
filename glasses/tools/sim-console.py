import json, sys, urllib.request

base = "http://127.0.0.1:9898"
since = 0
tail = int(sys.argv[1]) if len(sys.argv) > 1 else 40
try:
    with urllib.request.urlopen(f"{base}/api/console?since_id={since}", timeout=10) as r:
        data = json.load(r)
except Exception as e:
    print("console fetch failed:", e)
    sys.exit(0)

msgs = data.get("logs") or data.get("messages") or data.get("entries") or []
if not isinstance(msgs, list):
    print(json.dumps(data)[:2000])
    sys.exit(0)
for m in msgs[-tail:]:
    if isinstance(m, str):
        print(m[:300])
        continue
    lvl = m.get("level") or m.get("type") or "?"
    txt = m.get("text") or m.get("message") or m.get("args") or ""
    if isinstance(txt, list):
        txt = " ".join(str(x) for x in txt)
    print(f"[{lvl}] {str(txt)[:300]}")
print(f"--- {len(msgs)} message(s) ---")
