#!/usr/bin/env python3
"""
AETHER — Populate CDM Alert Log for Video Demo
Does NOT reset. Run after benchmark.py.
"""
import requests, math, time

BASE = "http://localhost:8000"
S = requests.Session()
S.headers.update({"Content-Type": "application/json"})

def post(p, b): return S.post(f"{BASE}{p}", json=b, timeout=60).json()
def get(p):     return S.get(f"{BASE}{p}", timeout=10).json()

# Check backend
try:
    s = get("/api/status")
    print(f"Backend ONLINE — sats:{s['satellites']}  debris:{s['debris_objects']}")
except Exception as e:
    print(f"Backend offline: {e}"); exit(1)

MU = 398600.4418
R  = 6778.0
VC = math.sqrt(MU / R)

# ── Ingest 6 sat+debris pairs ─────────────────────────────────────────────────
# Debris at 50m on crossing orbit — INSIDE 100m collision threshold immediately
# calculate_risk(0.050km) = CRITICAL regardless of any prior burns
objects = []
for i in range(6):
    a    = (i / 6) * 2 * math.pi
    incl = math.radians(98)       # crossing orbit
    sep  = 0.050                  # 50m — always CRITICAL (< 100m threshold)
    r_d  = R + sep
    vc_d = math.sqrt(MU / r_d)

    objects.append({"id": f"SAT-CDM-{i+1:02d}", "type": "SATELLITE",
        "r": {"x": R*math.cos(a),  "y": R*math.sin(a),  "z": 0.0},
        "v": {"x":-VC*math.sin(a), "y": VC*math.cos(a), "z": 0.0},
        "fuel": 50.0})

    objects.append({"id": f"DEB-CDM-{i+1:05d}", "type": "DEBRIS",
        "r": {"x": r_d*math.cos(a),
              "y": r_d*math.sin(a)*math.cos(incl),
              "z": r_d*math.sin(a)*math.sin(incl)},
        "v": {"x":-vc_d*math.sin(a),
              "y": vc_d*math.cos(a)*math.cos(incl),
              "z": vc_d*math.cos(a)*math.sin(incl)}})

print(f"\nIngesting {len(objects)} objects (6 pairs, debris 50m away)...")
r = post("/api/telemetry", {"timestamp": "2026-03-19T12:00:00Z", "objects": objects})
print(f"  {r}")

print("\nRunning steps...")
for i in range(15):
    res = post("/api/simulate/step", {"step_seconds": 60})
    col = res.get("collisions_detected", 0)
    mnv = res.get("maneuvers_executed",  0)
    n   = len(get("/api/alerts/history"))
    print(f"  +{(i+1)*60:4d}s  col={col}  mnv={mnv}  alerts={n}", end="")
    if col: print("  ◄ COLLISION", end="")
    if mnv: print("  ◄ BURN", end="")
    if n:   print(f"  ● {n} logged", end="")
    print()
    if n >= 3: break

alerts = get("/api/alerts/history")
print(f"\nFINAL: {len(alerts)} CDM events in Alert Log")
if alerts:
    for a in alerts[:6]:
        icon = {"MANEUVER_EXECUTED":"✓ AVOIDED",
                "COLLISION_DETECTED":"✗ COLLISION",
                "BLACKOUT_NO_UPLINK":"~ BLACKOUT",
                "COOLDOWN_DEFERRED": "~ COOLDOWN",
                "LOW_PROBABILITY":   "~ LOW_PROB",
                "DETECTED":          "i DETECTED"}.get(a.get("action",""), "?")
        print(f"  {icon:14s}  {a.get('sat_id','?'):14s} vs {a.get('deb_id','?'):16s}"
              f"  dist={a.get('distance',0):.4f}km  {a.get('severity','?')}")
    print(f"\nOpen http://localhost:3000 → ALERT LOG tab ✓")
else:
    print("\nStill empty — make sure you replaced backend/main.py with outputs/main.py")
    print("and restarted the backend before running this script.")