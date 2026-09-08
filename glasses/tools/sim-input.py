import json, sys, time, urllib.request

BASE = "http://127.0.0.1:9898"


def post(path, payload):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.read().decode()


def shot(name):
    with urllib.request.urlopen(BASE + "/api/screenshot/glasses", timeout=10) as r:
        data = r.read()
    with open(name, "wb") as f:
        f.write(data)
    return len(data)


action = sys.argv[1] if len(sys.argv) > 1 else "context_menu"
prefix = sys.argv[2] if len(sys.argv) > 2 else "shot"
count = int(sys.argv[3]) if len(sys.argv) > 3 else 4
delay = float(sys.argv[4]) if len(sys.argv) > 4 else 0.12

print(post("/api/input", {"action": action}))
for i in range(count):
    time.sleep(delay)
    print(prefix + str(i) + ".png", shot(prefix + str(i) + ".png"), "bytes")
