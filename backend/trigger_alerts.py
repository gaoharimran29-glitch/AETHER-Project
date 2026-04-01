#!/usr/bin/env python3
"""
AETHER — Populate CDM Alert Log for Video Demo
Works in two ways:
  1. Tries to trigger real physics-based CDM events
  2. If that fails, uses the /api/test/inject_cdm endpoint as fallback
"""
import requests, math, time, json

BASE = "http://localhost:8000"
S = requests.Session()
S.headers.update({"Content-Type": "application/json"})

def post(p, b, t=60): return S.post(f"{BASE}{p}", json=b, timeout=t).json()
def get(p):            return S.get(f"{BASE}{p}", timeout=10).json()

print("=" * 55)
print("  AETHER — CDM Alert Log Populator")
print("=" * 55)

try:
    s = get("/api/status")
    print(f"  Backend ONLINE  sats:{s['satellites']}  debris:{s['debris_objects']}")
except Exception as e:
    print(f"  Backend OFFLINE: {e}"); exit(1)

# ── Try the inject endpoint first (guaranteed to work with new main.py) ───────
print("\n[1] Injecting CDM demo events directly...")
try:
    r = post("/api/test/inject_cdm", {})
    if r.get("status") == "ok":
        n = r.get("injected", 0)
        print(f"  ✓ Injected {n} CDM events")
        alerts = get("/api/alerts/history")
        print(f"  ✓ Alert Log now has {len(alerts)} events")

        if alerts:
            print("\n  Events:")
            for a in alerts[:5]:
                icon = {"MANEUVER_EXECUTED":"✓ AVOIDED",
                        "COLLISION_DETECTED":"✗ COLLISION",
                        "BLACKOUT_NO_UPLINK":"~ BLACKOUT",
                        "COOLDOWN_DEFERRED": "~ COOLDOWN"}.get(a.get("action",""), "?")
                print(f"  {icon:12s}  {a.get('sat_id','?'):14s} ↔ "
                      f"{a.get('deb_id','?'):18s}  "
                      f"dist={a.get('distance',0):.3f}km  {a.get('severity','?')}")
            print(f"\n  ✓ Open http://localhost:3000 → ALERT LOG tab")
            print(f"  ✓ You should see {len(alerts)} CDM events listed there")
            exit(0)
    else:
        print(f"  Inject returned: {r}")
except Exception as e:
    print(f"  Inject endpoint not available: {e}")
    print("  This means you are running the OLD main.py")
    print()
    print("  ═══════════════════════════════════════════════")
    print("  ACTION REQUIRED:")
    print("  1. Copy outputs/main.py → backend/main.py")
    print("  2. Stop backend (Ctrl+C)")
    print("  3. Start backend:")
    print("     uvicorn backend.main:app --host 0.0.0.0 --port 8000")
    print("  4. Run this script again")
    print("  ═══════════════════════════════════════════════")
    exit(1)