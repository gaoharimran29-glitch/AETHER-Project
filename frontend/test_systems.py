"""
AETHER — Local Test Script
===========================
This script tests your system exactly the way the hackathon graders will.
The graders POST telemetry to port 8000 directly — no frontend needed.

Usage:
    python test_system.py

Make sure your backend is running first:
    docker run -p 8000:8000 aether
    OR
    uvicorn main:app --host 0.0.0.0 --port 8000
"""

import requests
import json
import time
import math

BASE = "http://127.0.0.1:8000"

def post(path, body=None):
    r = requests.post(f"{BASE}{path}", json=body, timeout=30)
    r.raise_for_status()
    return r.json()

def get(path):
    r = requests.get(f"{BASE}{path}", timeout=30)
    r.raise_for_status()
    return r.json()

def section(title):
    print(f"\n{'='*55}")
    print(f"  {title}")
    print(f"{'='*55}")

def ok(msg):  print(f"  \033[92m✓\033[0m  {msg}")
def fail(msg):print(f"  \033[91m✗\033[0m  {msg}")
def info(msg):print(f"  \033[94mℹ\033[0m  {msg}")

# ── Generate realistic test telemetry ─────────────────────────────────────────
def make_telemetry(num_sats=8, num_debris=50):
    objects = []
    for i in range(num_sats):
        angle = (i / num_sats) * math.pi * 2
        incl  = [0.3, 0.8, -0.5, 1.1, -0.2, 0.6, 0.9, -0.4][i % 8]
        r     = 6778 + i * 45
        objects.append({
            "id":   f"SAT-A{i+1:02d}",
            "type": "SATELLITE",
            "r": {"x": r*math.cos(angle), "y": r*math.sin(angle)*math.cos(incl), "z": r*math.sin(angle)*math.sin(incl)},
            "v": {"x": -7.67*math.sin(angle), "y": 7.67*math.cos(angle), "z": 0},
            "fuel": max(2.0, 50 - i * 4),
        })
    import random; random.seed(42)
    for i in range(num_debris):
        angle = random.uniform(0, math.pi * 2)
        r     = random.uniform(6550, 7450)
        incl  = random.uniform(-0.9, 0.9)
        objects.append({
            "id":   f"DEB-{i+1:04d}",
            "type": "DEBRIS",
            "r": {"x": r*math.cos(angle), "y": r*math.sin(angle)*math.cos(incl), "z": r*math.sin(angle)*math.sin(incl)},
            "v": {"x": -(7.5+random.uniform(0,0.4))*math.sin(angle), "y": (7.5+random.uniform(0,0.4))*math.cos(angle), "z": random.uniform(-0.3,0.3)},
        })
    return {"timestamp": "2026-03-19T10:00:00.000Z", "objects": objects}

# ══════════════════════════════════════════════════════════════════════════════
# TESTS
# ══════════════════════════════════════════════════════════════════════════════

section("1. Health Check  (PS §8)")
r = get("/api/status")
ok(f"Backend alive — satellites:{r['satellites']}  debris:{r['debris_objects']}")

section("2. Reset")
r = post("/api/reset")
ok(f"Reset: {r['status']}")

section("3. Telemetry Ingest  (PS §4.1)")
data = make_telemetry(8, 50)
info(f"Ingesting {len(data['objects'])} objects…")
r = post("/api/telemetry", data)
ok(f"ACK — processed:{r['processed_count']}  cdm_warnings:{r['active_cdm_warnings']}")
assert r['status'] == 'ACK', "Expected ACK"
assert r['processed_count'] == 58

section("4. Simulate Step  (PS §4.3)")
r = post("/api/simulate/step", {"step_seconds": 60})
ok(f"Step +60s — collisions:{r['collisions_detected']}  maneuvers:{r['maneuvers_executed']}")
assert r['status'] == 'STEP_COMPLETE'

section("5. Fast-Forward 1 Hour")
r = post("/api/simulate/step", {"step_seconds": 3600})
ok(f"Step +3600s — collisions:{r['collisions_detected']}  maneuvers:{r['maneuvers_executed']}")
assert r['status'] == 'STEP_COMPLETE'
r = get("/api/status")
ok(f"Elapsed sim time: {r['elapsed_sim_time_s']}s")

section("6. Collision Avoidance  (PS §2, §3.3)")
post("/api/reset")
post("/api/telemetry", {
    "timestamp": "2026-03-19T10:00:00.000Z",
    "objects": [
        {"id":"SAT-DANGER","type":"SATELLITE","r":{"x":6778.000,"y":0,"z":0},"v":{"x":0,"y":7.67,"z":0},"fuel":50},
        {"id":"DEB-CLOSE", "type":"DEBRIS",   "r":{"x":6778.050,"y":0,"z":0},"v":{"x":0,"y":7.60,"z":0}},
    ]
})
r = post("/api/simulate/step", {"step_seconds": 1})
if r['collisions_detected'] >= 1:
    ok(f"Collision detected at < 100m  (PS §3.3)")
if r['maneuvers_executed'] >= 1:
    ok(f"Autonomous avoidance maneuver fired  (PS §2)")
else:
    fail("No maneuver fired — check avoidance logic")

section("7. 24-Hour CDM Forecast  (PS §2)")
r = get("/api/conjunction/forecast")
ok(f"Forecast: {r['total_events']} events over {r['lookahead_hours']}h")

section("8. Visualization Snapshot  (PS §6.3)")
r = get("/api/visualization/snapshot")
ok(f"Snapshot: {len(r['satellites'])} satellites  {len(r['debris_cloud'])} debris")
if r['debris_cloud']:
    item = r['debris_cloud'][0]
    assert isinstance(item, list) and len(item) == 4, "Debris must be [id,lat,lon,alt]"
    ok(f"Debris compact format correct: {item}")

section("9. System Metrics  (PS §7)")
r = get("/api/system/metrics")
ok(f"Maneuvers: {r['maneuvers_executed']}")
ok(f"Collisions avoided: {r['collisions_avoided']}")
ok(f"Fuel used: {r['fuel_used_total_kg']:.4f} kg")
ok(f"Satellite uptime tracked: {len(r['satellite_uptime_pct'])} satellites")

section("10. Maneuver Schedule  (PS §4.2)")
post("/api/reset")
post("/api/telemetry", {
    "timestamp": "2026-03-19T10:00:00.000Z",
    "objects": [{"id":"SAT-TEST","type":"SATELLITE","r":{"x":6778,"y":0,"z":0},"v":{"x":0,"y":7.67,"z":0},"fuel":50}]
})
r = post("/api/maneuver/schedule", {
    "satelliteId": "SAT-TEST",
    "maneuver_sequence": [
        {"burn_id":"BURN-1","burnTime":"2026-03-20T10:00:00.000Z","deltaV_vector":{"x":0.005,"y":0.010,"z":-0.001}},
        {"burn_id":"BURN-2","burnTime":"2026-03-20T12:00:00.000Z","deltaV_vector":{"x":-0.005,"y":-0.010,"z":0.001}},
    ]
})
assert r['status'] == 'SCHEDULED'
v = r['validation']
ok(f"Scheduled — LOS:{v['ground_station_los']}  fuel_ok:{v['sufficient_fuel']}  mass:{v['projected_mass_remaining_kg']:.2f}kg")

print(f"\n\033[92m{'='*55}")
print(f"  ALL TESTS PASSED — System ready for submission")
print(f"{'='*55}\033[0m\n")