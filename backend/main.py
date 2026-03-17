"""
AETHER — Autonomous Constellation Manager
National Space Hackathon 2026, IIT Delhi
Backend: FastAPI + Redis + custom physics modules
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict
import redis
import json
import numpy as np
import os
import asyncio
import logging
import math
from datetime import datetime, timezone
import time
from dotenv import load_dotenv

# ── Internal modules ──────────────────────────────────────────────────────────
from spatial_algo.kd_tree      import check_for_conjunctions
from physics.rk4_integrator    import rk4_step
from maneuver.maneuver_planner import apply_maneuver, send_to_graveyard
from optimizer.fleet_optimizer import find_best_maneuver
from conjunction.collision_probability   import calculate_risk
from conjunction.monte_carlo_collision   import monte_carlo_collision_probability
from conjunction.tca_solver    import find_tca
from physics.fuel_model        import update_mass
from comms.los_checker         import LOSChecker
from comms.pass_predictor      import estimate_next_pass
from navigation.station_keeper import is_outside_box, recovery_delta_v

load_dotenv()

# ══════════════════════════════════════════════════════════════════════════════
# LOGGING
# ══════════════════════════════════════════════════════════════════════════════

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - [%(name)s] %(message)s",
)
logger = logging.getLogger("AETHER-CORE")

# ══════════════════════════════════════════════════════════════════════════════
# PHYSICAL & MISSION CONSTANTS  (PS §3.2, §5.1, §5.2, §5.4)
# ══════════════════════════════════════════════════════════════════════════════

MU              = 398600.4418   # km³/s²
RE              = 6378.137      # km
J2              = 1.08263e-3

DRY_MASS        = 500.0         # kg   PS §5.1
INITIAL_FUEL    = 50.0          # kg   PS §5.1
ISP             = 300.0         # s    PS §5.1
G0              = 9.80665       # m/s² PS §5.1
MAX_DV          = 0.015         # km/s = 15 m/s per burn  PS §5.1
COOLDOWN_S      = 600.0         # s between burns  PS §5.1
STATION_BOX_KM  = 10.0          # km spherical radius  PS §5.2
FUEL_EOL_PCT    = 5.0           # % threshold → graveyard  PS §2
COMMAND_LATENCY = 10.0          # s signal delay  PS §5.4
CONJ_THRESHOLD  = 0.1           # km = 100 m  PS §3.3

# 24-hour CDM lookahead  PS §2
LOOKAHEAD_S     = 86_400.0
LOOKAHEAD_STEP  = 60.0          # propagation granularity (s)

# ══════════════════════════════════════════════════════════════════════════════
# GLOBAL SIMULATION STATE
# ══════════════════════════════════════════════════════════════════════════════

SIM_START_WALL      = datetime.now(timezone.utc)
SIM_WALL_TIMESTAMP  = datetime.now(timezone.utc)  # advances with each tick
ELAPSED_SIM_TIME    = 0.0                         # simulation clock (s)
SIMULATION_RUNNING  = False

TOTAL_MANEUVERS           = 0
TOTAL_COLLISIONS_AVOIDED  = 0
TOTAL_FUEL_USED           = 0.0

# ══════════════════════════════════════════════════════════════════════════════
# FASTAPI + CORS
# ══════════════════════════════════════════════════════════════════════════════

app = FastAPI(title="AETHER Autonomous Constellation Manager")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

# ══════════════════════════════════════════════════════════════════════════════
# REDIS
# ══════════════════════════════════════════════════════════════════════════════

REDIS_HOST     = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT     = int(os.getenv("REDIS_PORT", 6379))
r              = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
ALERT_KEY      = "alert_stats"
BURN_QUEUE_KEY = "burn_queue"
CDM_HISTORY_KEY= "cdm_history"

# ══════════════════════════════════════════════════════════════════════════════
# GROUND STATION SETUP  (PS §5.4, §5.5.1)
# Normalise CSV column names so we never hit a KeyError at runtime.
# LOSChecker.stations comes from pd.DataFrame.to_dict('records') so keys
# match the CSV header exactly: "Latitude", "Longitude", "Elevation_m", etc.
# ══════════════════════════════════════════════════════════════════════════════

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
GS_CSV_PATH = os.path.join(BASE_DIR, "data", "ground_stations.csv")
los_checker = LOSChecker(GS_CSV_PATH)

_STATIONS: List[dict] = []
for _raw in los_checker.stations:
    _STATIONS.append({
        "name":       _raw.get("Station_Name",          _raw.get("name", "Unknown")),
        "lat":        float(_raw.get("Latitude",         _raw.get("lat",  0))),
        "lon":        float(_raw.get("Longitude",        _raw.get("lon",  0))),
        "alt_m":      float(_raw.get("Elevation_m",      _raw.get("alt",  0))),
        # Per-station elevation mask (PS §5.5.1)
        "min_el_deg": float(_raw.get("Min_Elevation_Angle_deg",
                                     _raw.get("min_el_deg", 5.0))),
    })

# ══════════════════════════════════════════════════════════════════════════════
# DATA MODELS
# ══════════════════════════════════════════════════════════════════════════════

class Vector3(BaseModel):
    x: float; y: float; z: float

class SpaceObject(BaseModel):
    id:   str
    type: str
    r:    Vector3
    v:    Vector3
    fuel: float = INITIAL_FUEL

class TelemetryRequest(BaseModel):
    timestamp: str
    objects:   List[SpaceObject]

class BurnCommand(BaseModel):
    burn_id:       str
    burnTime:      str      # ISO-8601
    deltaV_vector: Vector3  # ECI km/s  (PS §4.2)

class ManeuverScheduleRequest(BaseModel):
    satelliteId:       str
    maneuver_sequence: List[BurnCommand]

class SimStepRequest(BaseModel):
    step_seconds: float = 1.0   # PS §4.3 JSON body

class ManualManeuverRequest(BaseModel):
    sat_id: str
    dv_rtn: List[float]

# ══════════════════════════════════════════════════════════════════════════════
# UTILITY HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def redis_scan(pattern: str) -> List[str]:
    cursor, keys = 0, []
    while True:
        cursor, batch = r.scan(cursor=cursor, match=pattern)
        keys.extend(batch)
        if cursor == 0:
            break
    return keys


def eci_to_latlon(x: float, y: float, z: float):
    """ECI km → geodetic (lat°, lon°, alt km)."""
    r_mag = math.sqrt(x*x + y*y + z*z)
    lat   = math.degrees(math.asin(z / r_mag))
    lon   = math.degrees(math.atan2(y, x))
    alt   = r_mag - RE
    return lat, lon, alt


def lat_lon_to_eci(lat_deg: float, lon_deg: float, alt_m: float,
                   sim_time_s: float = 0.0) -> np.ndarray:
    """
    Geodetic → ECI with Earth-rotation correction.
    Matches the rotation model inside LOSChecker  (PS §5.4).
    """
    EARTH_ROT = 7.292115e-5          # rad/s
    theta     = EARTH_ROT * sim_time_s
    lat_r     = math.radians(lat_deg)
    lon_r     = math.radians(lon_deg) + theta
    r_surf    = RE + alt_m / 1000.0
    return np.array([
        r_surf * math.cos(lat_r) * math.cos(lon_r),
        r_surf * math.cos(lat_r) * math.sin(lon_r),
        r_surf * math.sin(lat_r),
    ])


def has_los(sat_pos: np.ndarray, sim_time_s: float = 0.0) -> bool:
    """
    True if ≥ 1 ground station has unobstructed LOS to the satellite.
    Checks:
      • Earth occlusion (ray-sphere intersection test)
      • Per-station minimum elevation angle mask  (PS §5.5.1)
    Uses rotating Earth model  (PS §5.4).
    """
    for st in _STATIONS:
        gs_pos = lat_lon_to_eci(st["lat"], st["lon"], st["alt_m"], sim_time_s)
        diff   = sat_pos - gs_pos
        dist   = float(np.linalg.norm(diff))
        if dist < 1e-6:
            continue

        # Earth occlusion: parametric ray-sphere test GS→sat
        a    = float(np.dot(diff, diff))
        b    = float(2.0 * np.dot(gs_pos, diff))
        c    = float(np.dot(gs_pos, gs_pos) - RE * RE)
        disc = b * b - 4.0 * a * c
        if disc > 0:
            t1 = (-b - math.sqrt(disc)) / (2.0 * a)
            t2 = (-b + math.sqrt(disc)) / (2.0 * a)
            if (0.0 < t1 < 1.0) or (0.0 < t2 < 1.0):
                continue   # Earth blocks signal

        # Elevation angle  (PS §5.5.1)
        gs_unit   = gs_pos / np.linalg.norm(gs_pos)
        cos_angle = float(np.clip(np.dot(diff / dist, gs_unit), -1.0, 1.0))
        elevation = math.degrees(math.asin(cos_angle))

        if elevation >= st["min_el_deg"]:
            return True
    return False


def count_active_cdm_warnings() -> int:
    """Count CDM alerts raised in the last hour."""
    count = 0
    for raw in r.lrange(CDM_HISTORY_KEY, 0, -1):
        try:
            ts = datetime.fromisoformat(
                     json.loads(raw)["timestamp"].replace("Z", "+00:00"))
            if (datetime.now(timezone.utc) - ts).total_seconds() < 3600:
                count += 1
        except Exception:
            pass
    return count


# ══════════════════════════════════════════════════════════════════════════════
# BURN QUEUE HELPERS  (PS §4.2)
# ══════════════════════════════════════════════════════════════════════════════

def enqueue_burn(sat_id: str, burn_id: str,
                 burn_time_iso: str, dv: List[float]) -> None:
    r.rpush(BURN_QUEUE_KEY, json.dumps({
        "sat_id":        sat_id,
        "burn_id":       burn_id,
        "burn_time_iso": burn_time_iso,
        "dv_x": dv[0], "dv_y": dv[1], "dv_z": dv[2],
    }))


def _rebuild_burn_queue(current_iso: str) -> List[dict]:
    """Internal: atomically split queue into due / future."""
    current_dt = datetime.fromisoformat(current_iso.replace("Z", "+00:00"))
    all_raw    = r.lrange(BURN_QUEUE_KEY, 0, -1)
    due, keep  = [], []
    for raw in all_raw:
        entry = json.loads(raw)
        bt    = datetime.fromisoformat(
                    entry["burn_time_iso"].replace("Z", "+00:00"))
        if bt <= current_dt:
            due.append(entry)
        else:
            keep.append(raw)
    r.delete(BURN_QUEUE_KEY)
    for raw in keep:
        r.rpush(BURN_QUEUE_KEY, raw)
    return due


# ══════════════════════════════════════════════════════════════════════════════
# CORE BURN EXECUTOR  (all PS §5.1 constraints enforced in one place)
# ══════════════════════════════════════════════════════════════════════════════

def execute_burn(sat: dict, dv: List[float],
                 sim_time: float):
    """
    Apply delta-v to sat dict, enforcing:
      • MAX_DV cap  (PS §5.1)
      • Fuel availability
      • 600-s cooldown on simulation clock  (PS §5.1)
      • 10-s command latency via RK4  (PS §5.4)
      • Tsiolkovsky fuel deduction  (PS §5.1)
    Returns (updated_sat_dict, fuel_used_kg).
    Raises ValueError on any constraint failure.
    """
    dv_arr = np.array(dv, dtype=float)
    dv_mag = float(np.linalg.norm(dv_arr))

    # 1. MAX_DV hard cap  (PS §5.1)
    if dv_mag > MAX_DV + 1e-9:
        raise ValueError(
            f"|ΔV| {dv_mag:.5f} km/s exceeds MAX_DV {MAX_DV} km/s")

    # 2. Fuel check
    fuel = float(sat.get("fuel", 0.0))
    if fuel <= 0.0:
        raise ValueError(f"{sat['id']}: no fuel remaining")

    # 3. Cooldown on simulation clock  (PS §5.1)
    last_b  = float(sat.get("last_burn_sim_time", -(COOLDOWN_S + 1.0)))
    elapsed = sim_time - last_b
    if elapsed < COOLDOWN_S:
        raise ValueError(
            f"{sat['id']}: cooldown active — "
            f"{COOLDOWN_S - elapsed:.0f}s remaining")

    # 4. Propagate state to burn time (10-s latency)  (PS §5.4)
    state         = np.array([float(sat[k])
                               for k in ("x","y","z","vx","vy","vz")])
    state_at_burn = rk4_step(state, COMMAND_LATENCY)

    # 5. Apply maneuver — RTN→ECI inside apply_maneuver  (PS §5.3)
    new_state = apply_maneuver(state_at_burn, dv_arr.tolist())

    # 6. Tsiolkovsky fuel deduction  (PS §5.1)
    _, fuel_used = update_mass(DRY_MASS + fuel, dv_mag)
    new_fuel     = max(0.0, fuel - fuel_used)

    sat.update({
        "x":  float(new_state[0]), "y":  float(new_state[1]),
        "z":  float(new_state[2]),
        "vx": float(new_state[3]), "vy": float(new_state[4]),
        "vz": float(new_state[5]),
        "fuel":               new_fuel,
        "last_maneuver":      datetime.now(timezone.utc).isoformat(),
        "last_burn_sim_time": sim_time,
    })
    return sat, float(fuel_used)


def retire_to_graveyard(sat: dict) -> dict:
    """
    EOL: prograde MAX_DV burn via send_to_graveyard()  (PS §2).
    Raises semi-major axis into disposal orbit.
    """
    state     = np.array([float(sat[k])
                           for k in ("x","y","z","vx","vy","vz")])
    new_state = send_to_graveyard(rk4_step(state, COMMAND_LATENCY))
    sat.update({
        "x":  float(new_state[0]), "y":  float(new_state[1]),
        "z":  float(new_state[2]),
        "vx": float(new_state[3]), "vy": float(new_state[4]),
        "vz": float(new_state[5]),
        "status":             "GRAVEYARD",
        "fuel":               0.0,
        "needs_return":       False,
        "last_burn_sim_time": ELAPSED_SIM_TIME,
    })
    logger.warning(f"EOL: {sat['id']} moved to GRAVEYARD orbit.")
    return sat


# ══════════════════════════════════════════════════════════════════════════════
# 24-HOUR CDM FORECAST  (PS §2)
# ══════════════════════════════════════════════════════════════════════════════

def scan_24h_conjunctions(sats_data: List[dict],
                          debris_data: List[dict]) -> List[dict]:
    """
    Propagates all objects in LOOKAHEAD_STEP increments up to LOOKAHEAD_S.
    Runs KD-tree check at each step.
    Returns de-duplicated list of predicted events with TCA offset + severity.
    """
    if not sats_data or not debris_data:
        return []

    active_sats = [s for s in sats_data if s.get("status") != "GRAVEYARD"]
    if not active_sats:
        return []

    sat_states = {
        s["id"]: np.array([float(s[k])
                           for k in ("x","y","z","vx","vy","vz")])
        for s in active_sats
    }
    deb_states = {
        d["id"]: np.array([float(d[k])
                           for k in ("x","y","z","vx","vy","vz")])
        for d in debris_data
    }
    sat_meta = {s["id"]: s for s in active_sats}
    deb_meta = {d["id"]: d for d in debris_data}

    events, seen = [], set()
    n_steps      = int(LOOKAHEAD_S / LOOKAHEAD_STEP)

    for step_i in range(1, n_steps + 1):
        for sid in sat_states:
            sat_states[sid] = rk4_step(sat_states[sid], LOOKAHEAD_STEP)
        for did in deb_states:
            deb_states[did] = rk4_step(deb_states[did], LOOKAHEAD_STEP)

        t = step_i * LOOKAHEAD_STEP

        tmp_sats = []
        for sid, st in sat_states.items():
            tmp = dict(sat_meta[sid])
            tmp.update({"x": st[0],"y": st[1],"z": st[2],
                        "vx": st[3],"vy": st[4],"vz": st[5]})
            tmp_sats.append(tmp)

        tmp_debs = []
        for did, st in deb_states.items():
            tmp = dict(deb_meta[did])
            tmp.update({"x": st[0],"y": st[1],"z": st[2],
                        "vx": st[3],"vy": st[4],"vz": st[5]})
            tmp_debs.append(tmp)

        for d in check_for_conjunctions(tmp_sats, tmp_debs):
            pair = (d["sat_id"], d["deb_id"])
            if pair in seen:
                continue
            seen.add(pair)
            min_dist, _ = find_tca(sat_states[d["sat_id"]],
                                   deb_states[d["deb_id"]])
            _, severity = calculate_risk(min_dist)
            events.append({
                "sat_id":       d["sat_id"],
                "deb_id":       d["deb_id"],
                "tca_offset_s": float(t),
                "min_dist_km":  float(min_dist),
                "severity":     severity,
            })

    return events


# ══════════════════════════════════════════════════════════════════════════════
# REST API ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/status")
async def system_status():
    return {
        "simulation_running": SIMULATION_RUNNING,
        "satellites":         len(redis_scan("SATELLITE:*")),
        "debris_objects":     len(redis_scan("DEBRIS:*")),
        "alerts":             r.hgetall(ALERT_KEY),
        "elapsed_sim_time_s": ELAPSED_SIM_TIME,
        "sim_timestamp":      SIM_WALL_TIMESTAMP.isoformat(),
    }


# ── Telemetry Ingestion  PS §4.1 ──────────────────────────────────────────────
@app.post("/api/telemetry")
async def ingest_telemetry(data: TelemetryRequest):
    processed = 0
    for obj in data.objects:
        key          = f"{obj.type}:{obj.id}"
        existing_raw = r.get(key)
        existing     = json.loads(existing_raw) if existing_raw else {}

        obj_data = {
            "id":   obj.id,
            "type": obj.type,
            "x":  obj.r.x, "y":  obj.r.y, "z":  obj.r.z,
            "vx": obj.v.x, "vy": obj.v.y, "vz": obj.v.z,
            "fuel":   obj.fuel,
            "status": existing.get("status", "ACTIVE"),
            # Full 6-DOF nominal slot set only on first ingest  (PS §5.2)
            "nominal": existing.get("nominal", {
                "x":  obj.r.x, "y":  obj.r.y, "z":  obj.r.z,
                "vx": obj.v.x, "vy": obj.v.y, "vz": obj.v.z,
            }),
            "needs_return":        existing.get("needs_return", False),
            "last_burn_sim_time":  existing.get("last_burn_sim_time",
                                                -(COOLDOWN_S + 1.0)),
            "seconds_outside_box": existing.get("seconds_outside_box", 0.0),
        }
        r.set(key, json.dumps(obj_data))
        processed += 1

    return {
        "status":              "ACK",
        "processed_count":     processed,
        "active_cdm_warnings": count_active_cdm_warnings(),   # PS §4.1
    }


# ── Maneuver Scheduling  PS §4.2 ──────────────────────────────────────────────
@app.post("/api/maneuver/schedule")
async def schedule_maneuver(req: ManeuverScheduleRequest):
    sat_key = f"SATELLITE:{req.satelliteId}"
    raw     = r.get(sat_key)
    if not raw:
        raise HTTPException(status_code=404, detail="Satellite not found")

    sat     = json.loads(raw)
    sat_pos = np.array([float(sat["x"]), float(sat["y"]), float(sat["z"])])
    fuel_kg = float(sat.get("fuel", 0.0))

    gs_los       = has_los(sat_pos, ELAPSED_SIM_TIME)
    total_dv_mag = 0.0

    for burn in req.maneuver_sequence:
        dv     = [burn.deltaV_vector.x,
                  burn.deltaV_vector.y,
                  burn.deltaV_vector.z]
        dv_mag = float(np.linalg.norm(dv))

        # Hard reject: exceeds MAX_DV  (PS §5.1)
        if dv_mag > MAX_DV + 1e-9:
            raise HTTPException(
                status_code=400,
                detail=(f"Burn '{burn.burn_id}': |ΔV|={dv_mag:.5f} km/s "
                        f"exceeds MAX_DV={MAX_DV} km/s"))

        # Hard reject: too soon  (PS §5.4)
        burn_dt  = datetime.fromisoformat(burn.burnTime.replace("Z", "+00:00"))
        sim_now  = SIM_WALL_TIMESTAMP if SIM_WALL_TIMESTAMP.tzinfo \
                   else SIM_WALL_TIMESTAMP.replace(tzinfo=timezone.utc)
        if burn_dt.timestamp() < sim_now.timestamp() + COMMAND_LATENCY:
            raise HTTPException(
                status_code=400,
                detail=(f"Burn '{burn.burn_id}' violates 10-s latency rule. "
                        f"Earliest allowed: now + {COMMAND_LATENCY}s"))

        total_dv_mag += dv_mag
        enqueue_burn(req.satelliteId, burn.burn_id, burn.burnTime, dv)

    _, total_fuel = update_mass(DRY_MASS + fuel_kg, total_dv_mag)
    sufficient    = fuel_kg >= total_fuel
    projected_kg  = max(DRY_MASS, DRY_MASS + fuel_kg - total_fuel)

    return {
        "status": "SCHEDULED",
        "validation": {
            "ground_station_los":          gs_los,
            "sufficient_fuel":             sufficient,
            "projected_mass_remaining_kg": round(projected_kg, 3),
        },
    }


# ── Simulation Step  PS §4.3 ──────────────────────────────────────────────────
@app.post("/api/simulate/step")
async def simulate_step(req: SimStepRequest):
    global ELAPSED_SIM_TIME, SIM_WALL_TIMESTAMP
    global TOTAL_MANEUVERS, TOTAL_COLLISIONS_AVOIDED, TOTAL_FUEL_USED

    dt = float(req.step_seconds)

    try:
        ELAPSED_SIM_TIME  += dt
        SIM_WALL_TIMESTAMP = datetime.now(timezone.utc)

        maneuvers_executed  = 0
        collisions_detected = 0

        # ── PHASE 1: PROPAGATION  PS §3.2 ────────────────────────────────
        for key in redis_scan("SATELLITE:*") + redis_scan("DEBRIS:*"):
            raw = r.get(key)
            if not raw:
                continue
            obj = json.loads(raw)
            if obj.get("status") == "GRAVEYARD":
                continue

            state     = np.array([float(obj[k])
                                   for k in ("x","y","z","vx","vy","vz")])
            new_state = rk4_step(state, dt)

            obj.update({
                "x":  float(new_state[0]), "y":  float(new_state[1]),
                "z":  float(new_state[2]),
                "vx": float(new_state[3]), "vy": float(new_state[4]),
                "vz": float(new_state[5]),
                "last_update": SIM_WALL_TIMESTAMP.isoformat(),
            })

            if "SATELLITE" in key:
                fuel_pct = (obj.get("fuel", 0.0) / INITIAL_FUEL) * 100.0
                nominal  = obj.get("nominal")

                # EOL  (PS §2)
                if fuel_pct <= FUEL_EOL_PCT \
                        and obj.get("status") != "GRAVEYARD":
                    obj = retire_to_graveyard(obj)
                    r.set(key, json.dumps(obj))
                    continue

                if obj.get("status") == "GRAVEYARD":
                    r.set(key, json.dumps(obj))
                    continue

                # Station-keeping  (PS §5.2)
                if nominal:
                    nom_pos = np.array([nominal["x"],
                                        nominal["y"],
                                        nominal["z"]])
                    if is_outside_box(new_state[:3], nom_pos):
                        obj["seconds_outside_box"] = \
                            obj.get("seconds_outside_box", 0.0) + dt

                        if obj.get("fuel", 0.0) <= 0.0:
                            obj["status"] = "GRAVEYARD"
                            logger.warning(
                                f"SK: {obj['id']} no fuel → GRAVEYARD")
                        else:
                            last_b  = float(obj.get("last_burn_sim_time",
                                                    -(COOLDOWN_S + 1.0)))
                            cd_ok   = (ELAPSED_SIM_TIME - last_b) >= COOLDOWN_S
                            sat_pos = new_state[:3]

                            if has_los(sat_pos, ELAPSED_SIM_TIME) and cd_ok:
                                dv_corr = recovery_delta_v(new_state, nom_pos)
                                dv_arr  = np.array(dv_corr, dtype=float)
                                dv_mag  = float(np.linalg.norm(dv_arr))

                                if dv_mag > 1e-9:
                                    if dv_mag > MAX_DV:
                                        dv_arr  = dv_arr / dv_mag * MAX_DV
                                        dv_mag  = MAX_DV
                                        dv_corr = dv_arr.tolist()

                                    s_burn = rk4_step(new_state,
                                                      COMMAND_LATENCY)
                                    corr   = apply_maneuver(s_burn, dv_corr)
                                    _, f_u = update_mass(
                                        DRY_MASS + obj.get("fuel", 0.0),
                                        dv_mag)

                                    obj.update({
                                        "vx": float(corr[3]),
                                        "vy": float(corr[4]),
                                        "vz": float(corr[5]),
                                        "fuel": max(0.0,
                                            obj.get("fuel", 0.0) - f_u),
                                        "last_maneuver":
                                            SIM_WALL_TIMESTAMP.isoformat(),
                                        "last_burn_sim_time":
                                            ELAPSED_SIM_TIME,
                                        "needs_return": False,
                                    })
                                    TOTAL_FUEL_USED    += f_u
                                    TOTAL_MANEUVERS    += 1
                                    maneuvers_executed += 1
                                    logger.info(
                                        f"SK: {obj['id']} "
                                        f"dv={dv_mag*1000:.2f} m/s")
                            else:
                                logger.debug(
                                    f"SK: {obj['id']} — "
                                    f"{'blackout' if not has_los(new_state[:3], ELAPSED_SIM_TIME) else 'cooldown'}")
                    else:
                        obj["seconds_outside_box"] = max(
                            0.0, obj.get("seconds_outside_box", 0.0) - dt)

            r.set(key, json.dumps(obj))

        # ── PHASE 2: SCHEDULED BURNS  PS §4.2 ────────────────────────────
        for burn in _rebuild_burn_queue(SIM_WALL_TIMESTAMP.isoformat()):
            sat_key = f"SATELLITE:{burn['sat_id']}"
            raw     = r.get(sat_key)
            if not raw:
                continue
            sat = json.loads(raw)
            if sat.get("status") == "GRAVEYARD":
                continue

            sat_pos = np.array([float(sat["x"]),
                                 float(sat["y"]),
                                 float(sat["z"])])

            if not has_los(sat_pos, ELAPSED_SIM_TIME):
                logger.warning(
                    f"Burn '{burn['burn_id']}' REJECTED — "
                    f"{burn['sat_id']} in blackout  (PS §5.4)")
                continue

            try:
                sat, f_u = execute_burn(
                    sat, [burn["dv_x"], burn["dv_y"], burn["dv_z"]],
                    ELAPSED_SIM_TIME)
                r.set(sat_key, json.dumps(sat))
                TOTAL_MANEUVERS    += 1
                TOTAL_FUEL_USED    += f_u
                maneuvers_executed += 1
                logger.info(f"Scheduled burn '{burn['burn_id']}' "
                            f"executed for {burn['sat_id']}")
            except ValueError as e:
                logger.error(f"Scheduled burn failed: {e}")

        # ── PHASE 3: CONJUNCTION DETECTION & AVOIDANCE ───────────────────
        sats_data   = [json.loads(r.get(k))
                       for k in redis_scan("SATELLITE:*") if r.get(k)]
        debris_data = [json.loads(r.get(k))
                       for k in redis_scan("DEBRIS:*")    if r.get(k)]

        active_sats = [s for s in sats_data
                       if s.get("status") != "GRAVEYARD"]

        if active_sats and (debris_data or len(active_sats) > 1):

            # Sat–debris dangers
            all_dangers = check_for_conjunctions(active_sats, debris_data) \
                          if debris_data else []

            # Sat–sat dangers  (PS §2 — detect ALL collisions)
            if len(active_sats) > 1:
                for d in check_for_conjunctions(active_sats, active_sats):
                    if d["sat_id"] != d["deb_id"]:
                        all_dangers.append(d)

            for d in all_dangers:
                sat_id  = d["sat_id"]
                deb_id  = d["deb_id"]
                sat_key = f"SATELLITE:{sat_id}"

                raw_sat = r.get(sat_key)
                if not raw_sat:
                    continue
                sat_obj = json.loads(raw_sat)
                if sat_obj.get("status") == "GRAVEYARD":
                    continue

                s_st = np.array([float(sat_obj[k])
                                  for k in ("x","y","z","vx","vy","vz")])

                # Locate threat object (debris or another satellite)
                threat_raw = (r.get(f"DEBRIS:{deb_id}")
                              or r.get(f"SATELLITE:{deb_id}"))
                if not threat_raw:
                    continue
                d_st = np.array([float(json.loads(threat_raw)[k])
                                  for k in ("x","y","z","vx","vy","vz")])

                # Hard collision check  (PS §3.3)
                if float(np.linalg.norm(s_st[:3] - d_st[:3])) < CONJ_THRESHOLD:
                    collisions_detected += 1
                    r.hincrby(ALERT_KEY, "collisions", 1)

                min_dist, _ = find_tca(s_st, d_st)
                _, severity = calculate_risk(min_dist)
                logger.debug(f"Conj {sat_id}&{deb_id} "
                             f"dist={min_dist:.4f}km sev={severity}")

                if severity not in ("CRITICAL", "WARNING"):
                    continue

                # LOS gate  (PS §5.4)
                if not has_los(s_st[:3], ELAPSED_SIM_TIME):
                    logger.warning(
                        f"BLIND CONJUNCTION {sat_id}&{deb_id} "
                        f"— in blackout, cannot uplink avoidance")
                    continue

                # Monte Carlo gate
                prob, _ = monte_carlo_collision_probability(
                    s_st[:3], d_st[:3])
                if prob <= 0.001:
                    continue

                # Cooldown gate  (PS §5.1)
                last_b = float(sat_obj.get("last_burn_sim_time",
                                           -(COOLDOWN_S + 1.0)))
                if (ELAPSED_SIM_TIME - last_b) < COOLDOWN_S:
                    logger.warning(f"{sat_id}: cooldown — skip avoidance")
                    continue

                best = find_best_maneuver(s_st, d_st)
                if not best:
                    continue

                dv_arr = np.array(best["dv"], dtype=float)
                dv_mag = float(np.linalg.norm(dv_arr))
                if dv_mag > MAX_DV:
                    dv_arr = dv_arr / dv_mag * MAX_DV
                    dv_mag = MAX_DV

                future_s  = rk4_step(s_st, COMMAND_LATENCY)
                final_s   = apply_maneuver(future_s, dv_arr.tolist())
                _, f_used = update_mass(DRY_MASS + sat_obj.get("fuel",0.0),
                                        dv_mag)
                new_fuel  = max(0.0, sat_obj.get("fuel", 0.0) - f_used)

                sat_obj.update({
                    "vx": float(final_s[3]),
                    "vy": float(final_s[4]),
                    "vz": float(final_s[5]),
                    "fuel":               new_fuel,
                    "needs_return":       True,
                    "last_maneuver":      SIM_WALL_TIMESTAMP.isoformat(),
                    "last_burn_sim_time": ELAPSED_SIM_TIME,
                })
                if new_fuel <= 0.0:
                    sat_obj["status"] = "GRAVEYARD"
                    logger.warning(f"{sat_id}: fuel exhausted → GRAVEYARD")

                r.set(sat_key, json.dumps(sat_obj))
                TOTAL_MANEUVERS          += 1
                TOTAL_COLLISIONS_AVOIDED += 1
                TOTAL_FUEL_USED          += f_used
                maneuvers_executed       += 1
                r.hincrby(ALERT_KEY, "avoidances_executed", 1)

                r.lpush(CDM_HISTORY_KEY, json.dumps({
                    "alert_id":  f"CDM-{int(time.time()*1000)}",
                    "timestamp": SIM_WALL_TIMESTAMP.isoformat(),
                    "sat_id":    sat_id,
                    "deb_id":    deb_id,
                    "distance":  float(min_dist),
                    "severity":  severity,
                    "prob":      float(prob),
                    "action":    "MANEUVER_EXECUTED",
                }))
                r.ltrim(CDM_HISTORY_KEY, 0, 99)

        # ── PHASE 4: RETURN-TO-NOMINAL  PS §5.2 ──────────────────────────
        for key in redis_scan("SATELLITE:*"):
            raw = r.get(key)
            if not raw:
                continue
            sat_obj = json.loads(raw)
            if (not sat_obj.get("needs_return")
                    or sat_obj.get("status") == "GRAVEYARD"
                    or sat_obj.get("fuel", 0.0) <= 0.0):
                continue

            last_b = float(sat_obj.get("last_burn_sim_time",
                                       -(COOLDOWN_S + 1.0)))
            if (ELAPSED_SIM_TIME - last_b) < COOLDOWN_S:
                continue

            sat_pos = np.array([float(sat_obj[k]) for k in ("x","y","z")])
            if not has_los(sat_pos, ELAPSED_SIM_TIME):
                continue

            nominal = sat_obj.get("nominal")
            if not nominal:
                continue

            s_st    = np.array([float(sat_obj[k])
                                 for k in ("x","y","z","vx","vy","vz")])
            nom_pos = np.array([nominal["x"], nominal["y"], nominal["z"]])

            if not is_outside_box(s_st[:3], nom_pos):
                sat_obj["needs_return"] = False
                r.set(key, json.dumps(sat_obj))
                continue

            dv_ret = recovery_delta_v(s_st, nom_pos)
            dv_arr = np.array(dv_ret, dtype=float)
            dv_mag = float(np.linalg.norm(dv_arr))

            if dv_mag < 1e-9:
                sat_obj["needs_return"] = False
                r.set(key, json.dumps(sat_obj))
                continue

            if dv_mag > MAX_DV:
                dv_arr = dv_arr / dv_mag * MAX_DV
                dv_mag = MAX_DV
                dv_ret = dv_arr.tolist()

            burn_st = rk4_step(s_st, COMMAND_LATENCY)
            corr    = apply_maneuver(burn_st, dv_ret)
            _, f_u  = update_mass(DRY_MASS + sat_obj.get("fuel", 0.0), dv_mag)

            sat_obj.update({
                "vx": float(corr[3]), "vy": float(corr[4]),
                "vz": float(corr[5]),
                "fuel":               max(0.0, sat_obj.get("fuel",0.0) - f_u),
                "last_maneuver":      SIM_WALL_TIMESTAMP.isoformat(),
                "last_burn_sim_time": ELAPSED_SIM_TIME,
                "needs_return":       False,
            })
            TOTAL_MANEUVERS    += 1
            TOTAL_FUEL_USED    += f_u
            maneuvers_executed += 1
            r.set(key, json.dumps(sat_obj))
            logger.info(f"Recovery burn: {sat_obj['id']}")

        # ── RESPONSE  PS §4.3 ─────────────────────────────────────────────
        return {
            "status":              "STEP_COMPLETE",
            "new_timestamp":       SIM_WALL_TIMESTAMP.isoformat(),
            "collisions_detected": collisions_detected,
            "maneuvers_executed":  maneuvers_executed,
        }

    except Exception as e:
        import traceback; traceback.print_exc()
        return {"status": "ERROR", "message": str(e)}


# ── Simulation control ────────────────────────────────────────────────────────
async def _simulation_loop(dt: float):
    global SIMULATION_RUNNING
    while SIMULATION_RUNNING:
        await simulate_step(SimStepRequest(step_seconds=dt))
        await asyncio.sleep(1)

@app.post("/api/simulate/start")
async def start_simulation(dt: float = 5.0):
    global SIMULATION_RUNNING
    if SIMULATION_RUNNING:
        return {"status": "already_running"}
    SIMULATION_RUNNING = True
    asyncio.create_task(_simulation_loop(dt))
    logger.info(f"Simulation started — dt={dt}s")
    return {"status": "simulation_running", "dt": dt}

@app.post("/api/simulate/stop")
async def stop_simulation():
    global SIMULATION_RUNNING
    SIMULATION_RUNNING = False
    return {"status": "simulation_stopped"}


# ── Manual maneuver  (legacy immediate endpoint) ──────────────────────────────
@app.post("/api/maneuver")
async def manual_maneuver(req: ManualManeuverRequest):
    global TOTAL_MANEUVERS, TOTAL_FUEL_USED   # ← fix: was missing, caused UnboundLocalError → HTTP 500

    raw = r.get(f"SATELLITE:{req.sat_id}")
    if not raw:
        return {"error": "Satellite not found"}

    sat     = json.loads(raw)
    sat_pos = np.array([float(sat["x"]), float(sat["y"]), float(sat["z"])])

    if not has_los(sat_pos, ELAPSED_SIM_TIME):
        return {"error": "Satellite in blackout — no LOS to any ground station"}

    try:
        sat, f_u = execute_burn(sat, req.dv_rtn, ELAPSED_SIM_TIME)
    except ValueError as e:
        return {"error": str(e)}
    except Exception as e:
        logger.error(f"execute_burn unexpected error for {req.sat_id}: {e}", exc_info=True)
        return {"error": f"Internal burn error: {str(e)}"}

    r.set(f"SATELLITE:{req.sat_id}", json.dumps(sat))
    TOTAL_MANEUVERS += 1
    TOTAL_FUEL_USED  += f_u
    return {"status": "maneuver_applied",
            "fuel_remaining_kg": round(sat["fuel"], 3)}


# ── Visualization snapshot  PS §6.3 ──────────────────────────────────────────
@app.get("/api/visualization/snapshot")
async def visualization_snapshot():
    satellites, debris_cloud = [], []

    for k in redis_scan("SATELLITE:*"):
        raw = r.get(k)
        if not raw:
            continue
        obj       = json.loads(raw)
        lat, lon, alt = eci_to_latlon(float(obj["x"]),
                                      float(obj["y"]),
                                      float(obj["z"]))
        satellites.append({
            "id":      obj["id"],
            "lat":     round(lat, 4),
            "lon":     round(lon, 4),
            "alt_km":  round(alt, 2),
            "fuel_kg": round(obj.get("fuel", 0.0), 3),
            "status":  obj.get("status", "ACTIVE"),
        })

    for k in redis_scan("DEBRIS:*"):
        raw = r.get(k)
        if not raw:
            continue
        obj       = json.loads(raw)
        lat, lon, alt = eci_to_latlon(float(obj["x"]),
                                      float(obj["y"]),
                                      float(obj["z"]))
        # Compact tuple format  PS §6.3
        debris_cloud.append([obj["id"],
                              round(lat, 3),
                              round(lon, 3),
                              round(alt, 1)])

    return {
        "timestamp":    SIM_WALL_TIMESTAMP.isoformat(),
        "satellites":   satellites,
        "debris_cloud": debris_cloud,
    }


# ── 24-h CDM forecast  PS §2 ──────────────────────────────────────────────────
@app.get("/api/conjunction/forecast")
async def conjunction_forecast():
    sats   = [json.loads(r.get(k)) for k in redis_scan("SATELLITE:*") if r.get(k)]
    debris = [json.loads(r.get(k)) for k in redis_scan("DEBRIS:*")    if r.get(k)]
    events = scan_24h_conjunctions(sats, debris)
    return {"forecast": events, "total_events": len(events),
            "lookahead_hours": 24}


# ── Remaining endpoints ───────────────────────────────────────────────────────
@app.get("/api/objects")
async def get_objects():
    keys = redis_scan("SATELLITE:*") + redis_scan("DEBRIS:*")
    return [json.loads(r.get(k)) for k in keys if r.get(k)]

@app.get("/api/alerts/history")
async def get_alert_history():
    return [json.loads(a) for a in r.lrange(CDM_HISTORY_KEY, 0, -1)]

@app.get("/api/scheduler/queue")
async def get_burn_queue():
    return [json.loads(x) for x in r.lrange(BURN_QUEUE_KEY, 0, -1)]

@app.get("/api/satellite/{sat_id}/next_pass")
async def get_next_pass(sat_id: str):
    raw = r.get(f"SATELLITE:{sat_id}")
    if not raw:
        return {"error": "Not found"}
    sat     = json.loads(raw)
    sat_pos = np.array([float(sat["x"]), float(sat["y"]), float(sat["z"])])
    sat_vel = np.array([float(sat["vx"]),float(sat["vy"]),float(sat["vz"])])
    preds   = []
    for st in _STATIONS:
        gs_pos = lat_lon_to_eci(st["lat"], st["lon"],
                                st["alt_m"], ELAPSED_SIM_TIME)
        preds.append({
            "station":                st["name"],
            "estimated_wait_seconds": round(
                estimate_next_pass(sat_pos, gs_pos, sat_vel), 2),
        })
    return {"sat_id": sat_id, "upcoming_passes": preds}

@app.get("/api/system/metrics")
async def system_metrics():
    total_s    = max(ELAPSED_SIM_TIME, 1.0)
    sat_uptime = {}
    for k in redis_scan("SATELLITE:*"):
        raw = r.get(k)
        if not raw:
            continue
        obj = json.loads(raw)
        outside  = obj.get("seconds_outside_box", 0.0)
        sat_uptime[obj["id"]] = round(
            max(0.0, 100.0 * (1.0 - outside / total_s)), 2)
    return {
        "uptime_wall_s":      round(
            (datetime.now(timezone.utc) - SIM_START_WALL).total_seconds(), 1),
        "elapsed_sim_time_s": round(ELAPSED_SIM_TIME, 1),
        "maneuvers_executed": TOTAL_MANEUVERS,
        "collisions_avoided": TOTAL_COLLISIONS_AVOIDED,
        "fuel_used_total_kg": round(TOTAL_FUEL_USED, 4),
        "satellite_uptime_pct": sat_uptime,
    }

@app.post("/api/reset")
async def reset_simulation():
    global ELAPSED_SIM_TIME, SIM_WALL_TIMESTAMP, SIMULATION_RUNNING
    global TOTAL_MANEUVERS, TOTAL_COLLISIONS_AVOIDED, TOTAL_FUEL_USED
    SIMULATION_RUNNING       = False
    ELAPSED_SIM_TIME         = 0.0
    SIM_WALL_TIMESTAMP       = datetime.now(timezone.utc)
    TOTAL_MANEUVERS          = 0
    TOTAL_COLLISIONS_AVOIDED = 0
    TOTAL_FUEL_USED          = 0.0
    for k in redis_scan("*"):
        r.delete(k)
    return {"status": "simulation_reset"}


# ══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)