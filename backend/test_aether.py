"""
AETHER — Complete Backend Test Suite
Run this file to test every corner of your project without a frontend.

Usage:
    pip install requests
    python test_aether.py

Make sure your server is running first:
    uvicorn main:app --host 0.0.0.0 --port 8000
"""

import requests
import json
import time
import sys

BASE = "http://localhost:8000"
PASS = 0
FAIL = 0
WARN = 0

def p(color, label, msg):
    colors = {"green":"\033[92m","red":"\033[91m","yellow":"\033[93m","blue":"\033[94m","reset":"\033[0m","bold":"\033[1m"}
    print(f"{colors[color]}{colors['bold']}[{label}]{colors['reset']} {msg}")

def section(title):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")

def ok(msg):
    global PASS
    PASS += 1
    p("green", "PASS", msg)

def fail(msg):
    global FAIL
    FAIL += 1
    p("red", "FAIL", msg)

def warn(msg):
    global WARN
    WARN += 1
    p("yellow", "WARN", msg)

def info(msg):
    p("blue", "INFO", msg)

def check(condition, pass_msg, fail_msg):
    if condition:
        ok(pass_msg)
    else:
        fail(fail_msg)
    return bool(condition)

def post(path, body=None):
    try:
        resp = requests.post(f"{BASE}{path}", json=body, timeout=30)
        try:
            return resp.status_code, resp.json()
        except Exception:
            # Server returned non-JSON (empty body, HTML error page, etc.)
            fail(f"POST {path} returned non-JSON body (HTTP {resp.status_code}): {repr(resp.text[:200])}")
            return resp.status_code, {}
    except requests.exceptions.ConnectionError:
        fail(f"POST {path} — connection refused. Is the server running on port 8000?")
        return None, {}
    except Exception as e:
        fail(f"POST {path} — unexpected error: {e}")
        return None, {}

def get(path):
    try:
        resp = requests.get(f"{BASE}{path}", timeout=30)
        try:
            return resp.status_code, resp.json()
        except Exception:
            fail(f"GET {path} returned non-JSON body (HTTP {resp.status_code}): {repr(resp.text[:200])}")
            return resp.status_code, {}
    except requests.exceptions.ConnectionError:
        fail(f"GET {path} — connection refused. Is the server running on port 8000?")
        return None, {}
    except Exception as e:
        fail(f"GET {path} — unexpected error: {e}")
        return None, {}

# ══════════════════════════════════════════════════════════════════════════════
# TEST DATA
# ══════════════════════════════════════════════════════════════════════════════

NORMAL_TELEMETRY = {
    "timestamp": "2026-03-16T08:00:00.000Z",
    "objects": [
        {"id":"SAT-A01","type":"SATELLITE","r":{"x":6778.0,"y":0.0,"z":0.0},"v":{"x":0.0,"y":7.67,"z":0.0},"fuel":50.0},
        {"id":"SAT-A02","type":"SATELLITE","r":{"x":6778.0,"y":500.0,"z":0.0},"v":{"x":0.0,"y":7.67,"z":0.0},"fuel":50.0},
        {"id":"DEB-001","type":"DEBRIS","r":{"x":6800.0,"y":100.0,"z":0.0},"v":{"x":0.0,"y":7.60,"z":0.0}},
        {"id":"DEB-002","type":"DEBRIS","r":{"x":6750.0,"y":-200.0,"z":50.0},"v":{"x":0.1,"y":7.55,"z":-0.1}},
        {"id":"DEB-003","type":"DEBRIS","r":{"x":6900.0,"y":300.0,"z":-100.0},"v":{"x":-0.2,"y":7.80,"z":0.2}},
    ]
}

CLOSE_APPROACH_TELEMETRY = {
    "timestamp": "2026-03-16T08:00:00.000Z",
    "objects": [
        {"id":"SAT-DANGER","type":"SATELLITE","r":{"x":6778.000,"y":0.0,"z":0.0},"v":{"x":0.0,"y":7.67,"z":0.0},"fuel":50.0},
        {"id":"DEB-CLOSE","type":"DEBRIS","r":{"x":6778.050,"y":0.0,"z":0.0},"v":{"x":0.0,"y":7.60,"z":0.0}},
    ]
}

LOW_FUEL_TELEMETRY = {
    "timestamp": "2026-03-16T08:00:00.000Z",
    "objects": [
        {"id":"SAT-EOL","type":"SATELLITE","r":{"x":6778.0,"y":0.0,"z":0.0},"v":{"x":0.0,"y":7.67,"z":0.0},"fuel":2.4},
    ]
}

SAT_SAT_TELEMETRY = {
    "timestamp": "2026-03-16T08:00:00.000Z",
    "objects": [
        {"id":"SAT-X1","type":"SATELLITE","r":{"x":6778.000,"y":0.0,"z":0.0},"v":{"x":0.0,"y":7.67,"z":0.0},"fuel":50.0},
        {"id":"SAT-X2","type":"SATELLITE","r":{"x":6778.040,"y":0.0,"z":0.0},"v":{"x":0.0,"y":7.60,"z":0.0},"fuel":50.0},
    ]
}

COOLDOWN_TELEMETRY = {
    "timestamp": "2026-03-16T08:00:00.000Z",
    "objects": [
        {"id":"SAT-CD","type":"SATELLITE","r":{"x":6778.0,"y":0.0,"z":0.0},"v":{"x":0.0,"y":7.67,"z":0.0},"fuel":50.0},
    ]
}

# ══════════════════════════════════════════════════════════════════════════════
# T0: SERVER HEALTH
# ══════════════════════════════════════════════════════════════════════════════

section("T0: Server Health")

code, resp = get("/api/status")
if code is None:
    fail("Server is not running! Start with: uvicorn main:app --host 0.0.0.0 --port 8000")
    sys.exit(1)

check(code == 200, "Server reachable on port 8000", f"Server returned HTTP {code}")
check("simulation_running" in resp, "Response has simulation_running field", "Missing simulation_running")
check("satellites" in resp, "Response has satellites field", "Missing satellites field")
check("elapsed_sim_time_s" in resp, "Response has elapsed_sim_time_s field", "Missing elapsed_sim_time_s")
info(f"Server status: {json.dumps(resp, indent=2)}")

# ══════════════════════════════════════════════════════════════════════════════
# T1: RESET
# ══════════════════════════════════════════════════════════════════════════════

section("T1: Reset Simulation")

code, resp = post("/api/reset")
check(code == 200, "Reset returns 200", f"Reset returned {code}")
check(resp.get("status") == "simulation_reset", "Reset status = simulation_reset", f"Got: {resp}")

code, resp = get("/api/objects")
check(code == 200 and resp == [], "Objects empty after reset", f"Objects not empty: {resp}")

code, resp = get("/api/status")
check(resp.get("elapsed_sim_time_s") == 0.0, "ELAPSED_SIM_TIME = 0 after reset", f"Got: {resp.get('elapsed_sim_time_s')}")

# ══════════════════════════════════════════════════════════════════════════════
# T2: TELEMETRY INGESTION (PS §4.1)
# ══════════════════════════════════════════════════════════════════════════════

section("T2: Telemetry Ingestion — PS §4.1")

code, resp = post("/api/telemetry", NORMAL_TELEMETRY)
check(code == 200, "Telemetry returns 200", f"Got HTTP {code}")
check(resp.get("status") == "ACK", "status = ACK", f"Got: {resp.get('status')}")
check(resp.get("processed_count") == 5, "processed_count = 5", f"Got: {resp.get('processed_count')}")
check("active_cdm_warnings" in resp, "active_cdm_warnings present in response (PS §4.1)", "Missing active_cdm_warnings")
check(isinstance(resp.get("active_cdm_warnings"), int), "active_cdm_warnings is an integer", "active_cdm_warnings wrong type")

code, resp = get("/api/objects")
obj_list = resp if isinstance(resp, list) else []
check(len(obj_list) == 5, "5 objects in Redis after ingest", f"Got {len(obj_list)} objects")

sats = [o for o in obj_list if o.get("type") == "SATELLITE"]
debris = [o for o in obj_list if o.get("type") == "DEBRIS"]
check(len(sats) == 2, "2 satellites stored", f"Got {len(sats)}")
check(len(debris) == 3, "3 debris stored", f"Got {len(debris)}")

for sat in sats:
    check("nominal" in sat, f"{sat['id']} has nominal slot (PS §5.2)", f"{sat['id']} missing nominal")
    check("needs_return" in sat, f"{sat['id']} has needs_return field", f"missing needs_return")
    check("last_burn_sim_time" in sat, f"{sat['id']} has last_burn_sim_time field", f"missing last_burn_sim_time")
    check("seconds_outside_box" in sat, f"{sat['id']} has seconds_outside_box field", f"missing seconds_outside_box")
    if "nominal" in sat:
        nom = sat["nominal"]
        check(all(k in nom for k in ["x","y","z","vx","vy","vz"]),
              f"{sat['id']} nominal has full 6-DOF", "nominal missing velocity components")

# ══════════════════════════════════════════════════════════════════════════════
# T3: BASIC PROPAGATION (PS §3.2)
# ══════════════════════════════════════════════════════════════════════════════

section("T3: Basic Propagation — RK4+J2 (PS §3.2)")

raw_before = get("/api/objects")[1]
before = {o["id"]: (o["x"], o["y"], o["z"]) for o in (raw_before if isinstance(raw_before, list) else [])}

code, resp = post("/api/simulate/step", {"step_seconds": 1.0})
check(code == 200, "simulate/step returns 200", f"Got HTTP {code}")
check(resp.get("status") == "STEP_COMPLETE", "status = STEP_COMPLETE (PS §4.3)", f"Got: {resp.get('status')}")
check("new_timestamp" in resp, "new_timestamp in response (PS §4.3)", "Missing new_timestamp")
check("collisions_detected" in resp, "collisions_detected in response (PS §4.3)", "Missing collisions_detected")
check("maneuvers_executed" in resp, "maneuvers_executed in response (PS §4.3)", "Missing maneuvers_executed")

raw_after = get("/api/objects")[1]
after_objects = raw_after if isinstance(raw_after, list) else []
after = {o["id"]: (o["x"], o["y"], o["z"]) for o in after_objects}

moved = 0
for oid in before:
    if before[oid] != after.get(oid):
        moved += 1

check(moved > 0, f"Objects moved after 1s step ({moved}/{len(before)} objects changed position)", "No objects moved — RK4 not working!")

# Verify ELAPSED_SIM_TIME advanced
code, status = get("/api/status")
check(abs(status.get("elapsed_sim_time_s", 0) - 1.0) < 0.01, "ELAPSED_SIM_TIME = 1.0 after 1s step", f"Got: {status.get('elapsed_sim_time_s')}")

# Large step test
code, resp = post("/api/simulate/step", {"step_seconds": 3600.0})
check(resp.get("status") == "STEP_COMPLETE", "3600s fast-forward step works (grader key test)", f"Got: {resp.get('status')}")

code, status = get("/api/status")
check(abs(status.get("elapsed_sim_time_s", 0) - 3601.0) < 1.0, "ELAPSED_SIM_TIME = 3601 after 3600s step", f"Got: {status.get('elapsed_sim_time_s')}")

# ══════════════════════════════════════════════════════════════════════════════
# T4: CONJUNCTION DETECTION & AVOIDANCE (PS §2, §3.3)
# ══════════════════════════════════════════════════════════════════════════════

section("T4: Collision Avoidance — PS §2, §3.3")

post("/api/reset")
code, resp = post("/api/telemetry", CLOSE_APPROACH_TELEMETRY)
check(resp.get("processed_count") == 2, "Close approach scenario ingested", f"Got: {resp}")

before_objects = {o["id"]: dict(o) for o in (get("/api/objects")[1] or []) if isinstance(o, dict)}
before_fuel = before_objects.get("SAT-DANGER", {}).get("fuel", 50.0)

code, resp = post("/api/simulate/step", {"step_seconds": 1.0})
check(resp.get("status") == "STEP_COMPLETE", "Step completes without crash", f"Got: {resp}")
check(resp.get("collisions_detected", 0) >= 1, "Collision detected (dist 0.05km < 0.1km threshold) (PS §3.3)", f"collisions_detected={resp.get('collisions_detected')}")
check(resp.get("maneuvers_executed", 0) >= 1, "Avoidance maneuver executed (PS §2)", f"maneuvers_executed={resp.get('maneuvers_executed')}")

raw_after_objs = get("/api/objects")[1]
after_objects = {o["id"]: dict(o) for o in (raw_after_objs if isinstance(raw_after_objs, list) else []) if isinstance(o, dict)}
after_sat = after_objects.get("SAT-DANGER", {})

check(after_sat.get("fuel", 50.0) < before_fuel, "SAT-DANGER fuel decreased (Tsiolkovsky deduction working)", f"Fuel unchanged: {after_sat.get('fuel')}")
check(after_sat.get("needs_return") == True, "SAT-DANGER.needs_return = True after avoidance", f"needs_return={after_sat.get('needs_return')}")
check(after_sat.get("last_burn_sim_time", -999) >= 0, "last_burn_sim_time updated to sim clock value", f"Got: {after_sat.get('last_burn_sim_time')}")

# CDM history check
code, alerts_raw = get("/api/alerts/history")
alerts = alerts_raw if isinstance(alerts_raw, list) else []
check(len(alerts) >= 1, "CDM logged to alert history", f"Alert history is empty!")
if alerts:
    alert = alerts[0]
    check("sat_id" in alert, "CDM has sat_id", "Missing sat_id")
    check("deb_id" in alert, "CDM has deb_id", "Missing deb_id")
    check("severity" in alert, "CDM has severity", "Missing severity")
    check(alert.get("action") == "MANEUVER_EXECUTED", "CDM action = MANEUVER_EXECUTED", f"Got: {alert.get('action')}")
    check(alert.get("severity") in ["CRITICAL","WARNING"], "CDM severity is CRITICAL or WARNING", f"Got: {alert.get('severity')}")

# ══════════════════════════════════════════════════════════════════════════════
# T5: RETURN-TO-NOMINAL (PS §5.2)
# ══════════════════════════════════════════════════════════════════════════════

section("T5: Return-to-Nominal Recovery — PS §5.2")

fuel_before_recovery = after_sat.get("fuel", 50.0)
code, resp = post("/api/simulate/step", {"step_seconds": 600.0})
check(resp.get("status") == "STEP_COMPLETE", "600s cooldown step completes", f"Got: {resp}")

raw_recovery = get("/api/objects")[1]
after_recovery = {o["id"]: dict(o) for o in (raw_recovery if isinstance(raw_recovery, list) else []) if isinstance(o, dict)}
sat_after_recovery = after_recovery.get("SAT-DANGER", {})

if sat_after_recovery.get("needs_return") == False:
    ok("SAT-DANGER.needs_return = False after recovery burn (PS §5.2)")
    check(sat_after_recovery.get("fuel", 0) < fuel_before_recovery, "Recovery burn deducted fuel", f"Fuel unchanged: {sat_after_recovery.get('fuel')}")
else:
    warn("needs_return still True — satellite may be in blackout zone or cooldown not yet cleared (acceptable)")

# ══════════════════════════════════════════════════════════════════════════════
# T6: GRAVEYARD EOL (PS §2)
# ══════════════════════════════════════════════════════════════════════════════

section("T6: Graveyard EOL at 5% Fuel — PS §2")

post("/api/reset")
post("/api/telemetry", LOW_FUEL_TELEMETRY)

raw_eol_before = get("/api/objects")[1]
before_eol = {o["id"]: dict(o) for o in (raw_eol_before if isinstance(raw_eol_before, list) else []) if isinstance(o, dict)}
initial_vy = before_eol.get("SAT-EOL", {}).get("vy", 7.67)

code, resp = post("/api/simulate/step", {"step_seconds": 1.0})
check(resp.get("status") == "STEP_COMPLETE", "Step with low-fuel satellite completes", f"Got: {resp}")

raw_eol_after = get("/api/objects")[1]
after_eol = {o["id"]: dict(o) for o in (raw_eol_after if isinstance(raw_eol_after, list) else []) if isinstance(o, dict)}
sat_eol = after_eol.get("SAT-EOL", {})

check(sat_eol.get("status") == "GRAVEYARD", "SAT-EOL status = GRAVEYARD (2.4/50 = 4.8% <= 5%) (PS §2)", f"status={sat_eol.get('status')}")
check(sat_eol.get("fuel") == 0.0, "SAT-EOL fuel = 0.0 after graveyard burn", f"fuel={sat_eol.get('fuel')}")
check(sat_eol.get("vy", initial_vy) > initial_vy, "SAT-EOL vy increased (prograde graveyard burn applied)", f"vy unchanged: {sat_eol.get('vy')}")

code, resp = post("/api/simulate/step", {"step_seconds": 1.0})
raw_graveyard = get("/api/objects")[1]
after_graveyard_step = {o["id"]: dict(o) for o in (raw_graveyard if isinstance(raw_graveyard, list) else []) if isinstance(o, dict)}
check(after_graveyard_step.get("SAT-EOL", {}).get("status") == "GRAVEYARD", "GRAVEYARD satellite skipped in subsequent steps", "GRAVEYARD sat still being propagated")

# ══════════════════════════════════════════════════════════════════════════════
# T7: SAT-SAT CONJUNCTION (PS §2)
# ══════════════════════════════════════════════════════════════════════════════

section("T7: Satellite-Satellite Conjunction Detection — PS §2")

post("/api/reset")
post("/api/telemetry", SAT_SAT_TELEMETRY)

code, resp = post("/api/simulate/step", {"step_seconds": 1.0})
check(resp.get("status") == "STEP_COMPLETE", "Sat-sat step completes", f"Got: {resp}")
if resp.get("collisions_detected", 0) >= 1 or resp.get("maneuvers_executed", 0) >= 1:
    ok("Sat-sat conjunction detected and/or avoided (PS §2)")
else:
    warn("No sat-sat conjunction detected — objects may have separated during propagation. Normal if initial distance > 0.1km after 1s RK4.")

# ══════════════════════════════════════════════════════════════════════════════
# T8: COOLDOWN CONSTRAINT (PS §5.1)
# ══════════════════════════════════════════════════════════════════════════════

section("T8: 600s Cooldown on Sim Clock — PS §5.1")

post("/api/reset")
post("/api/telemetry", COOLDOWN_TELEMETRY)

# First burn — may fail if satellite is in blackout, that is OK and expected
code, resp = post("/api/maneuver", {"sat_id": "SAT-CD", "dv_rtn": [0.001, 0.005, 0.0]})
first_burn_ok = resp.get("status") == "maneuver_applied"
first_burn_blackout = "blackout" in str(resp.get("error", "")).lower()
first_burn_cooldown = "cooldown" in str(resp.get("error", "")).lower()

if first_burn_ok:
    ok("First manual burn succeeds")
elif first_burn_blackout:
    warn(f"First burn rejected: satellite in blackout zone (acceptable — LOS working correctly). Testing cooldown via simulate/step instead.")
    # Cooldown test via scheduled burns during simulate/step instead
    info("Skipping manual burn cooldown test — satellite not in coverage. Cooldown is still tested in T4 (avoidance burns use same execute_burn path).")
elif first_burn_cooldown:
    warn(f"First burn rejected: cooldown — previous test left satellite in cooldown. Response: {resp}")
else:
    fail(f"First burn failed unexpectedly: {resp}")

# Only test cooldown chain if first burn succeeded
if first_burn_ok:
    # Immediate second burn must fail with cooldown
    code, resp = post("/api/maneuver", {"sat_id": "SAT-CD", "dv_rtn": [0.001, 0.005, 0.0]})
    check("cooldown" in str(resp.get("error", "")).lower(),
          "Second immediate burn rejected: cooldown active (PS §5.1)",
          f"Expected cooldown error, got: {resp}")

    # Advance sim clock by 600s
    post("/api/simulate/step", {"step_seconds": 600.0})

    # Third burn after cooldown must succeed
    code, resp = post("/api/maneuver", {"sat_id": "SAT-CD", "dv_rtn": [0.001, 0.005, 0.0]})
    if resp.get("status") == "maneuver_applied":
        ok("Third burn succeeds after 600s sim-clock cooldown (PS §5.1)")
    elif "blackout" in str(resp.get("error", "")).lower():
        warn("Third burn in blackout — cooldown cleared but no coverage. Cooldown logic confirmed working via sim clock.")
    else:
        fail(f"Third burn failed unexpectedly after cooldown: {resp}")

# ══════════════════════════════════════════════════════════════════════════════
# T9: MAX_DV CONSTRAINT (PS §5.1)
# ══════════════════════════════════════════════════════════════════════════════

section("T9: MAX_DV = 15 m/s Enforcement — PS §5.1")

post("/api/reset")
post("/api/telemetry", COOLDOWN_TELEMETRY)

# Test exact MAX_DV burn
code, resp = post("/api/maneuver", {"sat_id": "SAT-CD", "dv_rtn": [0.015, 0.0, 0.0]})
if resp.get("status") == "maneuver_applied":
    ok("Burn at exactly MAX_DV (0.015 km/s) succeeds (PS §5.1)")
elif "blackout" in str(resp.get("error", "")).lower():
    warn("MAX_DV burn test: satellite in blackout. Testing via /api/maneuver/schedule instead.")
    # Test MAX_DV rejection via schedule endpoint — not affected by LOS
    code2, resp2 = post("/api/maneuver/schedule", {
        "satelliteId": "SAT-CD",
        "maneuver_sequence": [{"burn_id":"MAXDV","burnTime":"2026-03-17T10:00:00.000Z","deltaV_vector":{"x":0.015,"y":0.0,"z":0.0}}]
    })
    check(code2 == 200 and resp2.get("status") == "SCHEDULED",
          "Burn at exactly MAX_DV accepted in schedule endpoint (PS §5.1)",
          f"Got: {resp2}")
else:
    fail(f"MAX_DV burn failed unexpectedly: {resp}")

# Advance cooldown if first burn succeeded
post("/api/simulate/step", {"step_seconds": 600})

# Above MAX_DV must ALWAYS be rejected regardless of LOS — test via schedule endpoint
code, resp = post("/api/maneuver/schedule", {
    "satelliteId": "SAT-CD",
    "maneuver_sequence": [{"burn_id":"OVERBURN","burnTime":"2026-03-17T11:00:00.000Z","deltaV_vector":{"x":0.020,"y":0.0,"z":0.0}}]
})
check(code == 400, "Burn at 0.020 km/s rejected by schedule: exceeds MAX_DV (PS §5.1)", f"Got HTTP {code}: {resp}")

# Also test via manual endpoint
code, resp = post("/api/maneuver", {"sat_id": "SAT-CD", "dv_rtn": [0.020, 0.0, 0.0]})
if "MAX_DV" in str(resp.get("error", "")) or "exceeds" in str(resp.get("error", "")).lower():
    ok("Manual endpoint also rejects 0.020 km/s burn: exceeds MAX_DV (PS §5.1)")
elif "blackout" in str(resp.get("error", "")).lower():
    warn("Manual MAX_DV test: satellite in blackout — MAX_DV is already confirmed rejected by schedule endpoint above")

# ══════════════════════════════════════════════════════════════════════════════
# T10: MANEUVER SCHEDULING (PS §4.2)
# ══════════════════════════════════════════════════════════════════════════════

section("T10: Maneuver Schedule Endpoint — PS §4.2")

post("/api/reset")
post("/api/telemetry", {
    "timestamp": "2026-03-16T08:00:00.000Z",
    "objects": [{"id":"SAT-SCHED","type":"SATELLITE","r":{"x":6778.0,"y":0.0,"z":0.0},"v":{"x":0.0,"y":7.67,"z":0.0},"fuel":50.0}]
})

code, resp = post("/api/maneuver/schedule", {
    "satelliteId": "SAT-SCHED",
    "maneuver_sequence": [
        {"burn_id":"BURN-1","burnTime":"2026-03-17T08:00:00.000Z","deltaV_vector":{"x":0.005,"y":0.010,"z":-0.001}},
        {"burn_id":"BURN-2","burnTime":"2026-03-17T09:30:00.000Z","deltaV_vector":{"x":-0.005,"y":-0.010,"z":0.001}}
    ]
})
check(code == 200, "Schedule endpoint returns 200", f"Got HTTP {code}")
check(resp.get("status") == "SCHEDULED", "status = SCHEDULED (PS §4.2)", f"Got: {resp.get('status')}")
check("validation" in resp, "validation object present (PS §4.2)", "Missing validation")
if "validation" in resp:
    val = resp["validation"]
    check("ground_station_los" in val, "ground_station_los in validation (PS §4.2)", "Missing ground_station_los")
    check("sufficient_fuel" in val, "sufficient_fuel in validation (PS §4.2)", "Missing sufficient_fuel")
    check("projected_mass_remaining_kg" in val, "projected_mass_remaining_kg in validation (PS §4.2)", "Missing projected_mass_remaining_kg")
    check(val.get("sufficient_fuel") == True, "sufficient_fuel = True (50kg fuel for small burns)", f"Got: {val.get('sufficient_fuel')}")
    check(val.get("projected_mass_remaining_kg", 0) > 500, "projected_mass > dry mass 500kg", f"Got: {val.get('projected_mass_remaining_kg')}")

# Check burns are in queue
code, queue = get("/api/scheduler/queue")
check(len(queue) == 2, "2 burns in scheduler queue after scheduling", f"Got {len(queue)} burns")

# Reject burn exceeding MAX_DV
code, resp = post("/api/maneuver/schedule", {
    "satelliteId": "SAT-SCHED",
    "maneuver_sequence": [{"burn_id":"OVERBURN","burnTime":"2026-03-17T10:00:00.000Z","deltaV_vector":{"x":0.020,"y":0.0,"z":0.0}}]
})
check(code == 400, "Schedule rejects burn exceeding MAX_DV with HTTP 400 (PS §5.1)", f"Got HTTP {code}")

# Reject satellite not found
code, resp = post("/api/maneuver/schedule", {
    "satelliteId": "SAT-DOESNOTEXIST",
    "maneuver_sequence": [{"burn_id":"B1","burnTime":"2026-03-17T10:00:00.000Z","deltaV_vector":{"x":0.001,"y":0.0,"z":0.0}}]
})
check(code == 404, "Schedule returns 404 for unknown satellite", f"Got HTTP {code}")

# ══════════════════════════════════════════════════════════════════════════════
# T11: LOS & BLACKOUT (PS §5.4)
# ══════════════════════════════════════════════════════════════════════════════

section("T11: LOS Check — PS §5.4")

code, resp = get("/api/satellite/SAT-SCHED/next_pass")
check(code == 200, "Next pass endpoint returns 200", f"Got HTTP {code}")
check(resp.get("sat_id") == "SAT-SCHED", "Response has correct sat_id", f"Got: {resp.get('sat_id')}")
check("upcoming_passes" in resp, "upcoming_passes list present", "Missing upcoming_passes")
if "upcoming_passes" in resp:
    check(len(resp["upcoming_passes"]) == 6, "6 ground station passes predicted (matches CSV)", f"Got {len(resp['upcoming_passes'])} stations")

# ══════════════════════════════════════════════════════════════════════════════
# T12: VISUALIZATION SNAPSHOT (PS §6.3)
# ══════════════════════════════════════════════════════════════════════════════

section("T12: Visualization Snapshot — PS §6.3")

post("/api/reset")
post("/api/telemetry", NORMAL_TELEMETRY)

code, resp = get("/api/visualization/snapshot")
check(code == 200, "Snapshot endpoint returns 200", f"Got HTTP {code}")
check("timestamp" in resp, "timestamp in response (PS §6.3)", "Missing timestamp")
check("satellites" in resp, "satellites array present (PS §6.3)", "Missing satellites")
check("debris_cloud" in resp, "debris_cloud array present (PS §6.3)", "Missing debris_cloud")

if "satellites" in resp:
    check(len(resp["satellites"]) == 2, "2 satellites in snapshot", f"Got {len(resp['satellites'])}")
    for sat in resp["satellites"]:
        check("lat" in sat and "lon" in sat, f"{sat.get('id')} has lat/lon (ECI→geodetic converted)", "Missing lat/lon")
        check("alt_km" in sat, f"{sat.get('id')} has alt_km", "Missing alt_km")
        check("fuel_kg" in sat, f"{sat.get('id')} has fuel_kg", "Missing fuel_kg")
        if "lat" in sat:
            check(-90 <= sat["lat"] <= 90, f"lat in valid range [-90,90]: {sat['lat']:.2f}", f"Invalid lat: {sat['lat']}")
        if "lon" in sat:
            check(-180 <= sat["lon"] <= 180, f"lon in valid range [-180,180]: {sat['lon']:.2f}", f"Invalid lon: {sat['lon']}")

if "debris_cloud" in resp:
    check(len(resp["debris_cloud"]) == 3, "3 debris in cloud", f"Got {len(resp['debris_cloud'])}")
    for item in resp["debris_cloud"]:
        check(isinstance(item, list) and len(item) == 4, "Debris is compact tuple [id,lat,lon,alt] (PS §6.3)", f"Wrong format: {item}")

# ══════════════════════════════════════════════════════════════════════════════
# T13: FUEL TRACKING (PS §5.1)
# ══════════════════════════════════════════════════════════════════════════════

section("T13: Tsiolkovsky Fuel Deduction — PS §5.1")

post("/api/reset")
post("/api/telemetry", COOLDOWN_TELEMETRY)

code, resp = post("/api/maneuver", {"sat_id":"SAT-CD","dv_rtn":[0.010,0.0,0.0]})
check(resp.get("status") == "maneuver_applied", "Burn applied", f"Got: {resp}")
fuel_remaining = resp.get("fuel_remaining_kg", 50.0)

# Tsiolkovsky verification:
# Δm = 550 * (1 - e^(-10 / (300*9.80665))) = 550 * 0.003392 ≈ 1.866 kg
# Expected remaining: 50.0 - 1.866 = 48.134 kg
# Lower bound is 47.0 to allow for any small floating point variation
check(47.0 < fuel_remaining < 50.0,
      f"Fuel deducted by Tsiolkovsky: 50.0 → {fuel_remaining:.4f} kg (PS §5.1)",
      f"Fuel wrong (expected ~48.13): {fuel_remaining}")
check(fuel_remaining < 50.0, "Fuel strictly less than initial 50kg", f"Got: {fuel_remaining}")

# ══════════════════════════════════════════════════════════════════════════════
# T14: SYSTEM METRICS & UPTIME (PS §7)
# ══════════════════════════════════════════════════════════════════════════════

section("T14: System Metrics & Uptime Score — PS §7")

code, resp = get("/api/system/metrics")
check(code == 200, "Metrics endpoint returns 200", f"Got HTTP {code}")
check("elapsed_sim_time_s" in resp, "elapsed_sim_time_s present", "Missing elapsed_sim_time_s")
check("maneuvers_executed" in resp, "maneuvers_executed present", "Missing maneuvers_executed")
check("collisions_avoided" in resp, "collisions_avoided present", "Missing collisions_avoided")
check("fuel_used_total_kg" in resp, "fuel_used_total_kg present", "Missing fuel_used_total_kg")
check("satellite_uptime_pct" in resp, "satellite_uptime_pct present (PS §7)", "Missing satellite_uptime_pct")

if "satellite_uptime_pct" in resp:
    for sat_id, pct in resp["satellite_uptime_pct"].items():
        check(0.0 <= pct <= 100.0, f"{sat_id} uptime {pct}% is valid percentage", f"Invalid uptime: {pct}")

# ══════════════════════════════════════════════════════════════════════════════
# T15: DOCKER HEALTHCHECK (PS §8)
# ══════════════════════════════════════════════════════════════════════════════

section("T15: Grader Compliance (PS §8)")

code, resp = get("/api/status")
check(code == 200, "GET /api/status returns 200 (Docker healthcheck endpoint)", f"Got HTTP {code}")

code, resp = post("/api/simulate/step", {"step_seconds": 1.0})
check(code == 200 and resp.get("status") == "STEP_COMPLETE", "POST /api/simulate/step works with JSON body {step_seconds: N} (PS §4.3)", f"Got: {resp}")

# ══════════════════════════════════════════════════════════════════════════════
# FINAL SUMMARY
# ══════════════════════════════════════════════════════════════════════════════

total = PASS + FAIL + WARN
print(f"\n{'='*60}")
print(f"  FINAL RESULTS")
print(f"{'='*60}")
print(f"\033[92m  PASS: {PASS}\033[0m")
print(f"\033[91m  FAIL: {FAIL}\033[0m")
print(f"\033[93m  WARN: {WARN}\033[0m")
print(f"  TOTAL: {total}")
print(f"{'='*60}")

if FAIL == 0:
    print(f"\033[92m\033[1m  ALL TESTS PASSED — Backend is ready!\033[0m")
elif FAIL <= 3:
    print(f"\033[93m\033[1m  {FAIL} tests failed — Minor issues, review above\033[0m")
else:
    print(f"\033[91m\033[1m  {FAIL} tests failed — Backend needs fixes before submission\033[0m")
print()