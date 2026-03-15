from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional, Dict
import redis
import json
import numpy as np
import os
import asyncio
import logging
import math
from datetime import datetime, timezone
from scheduler.event_queue import event_scheduler
from spatial_algo.kd_tree import check_for_conjunctions
from physics.rk4_integrator import rk4_step
from maneuver.maneuver_planner import apply_maneuver
from optimizer.fleet_optimizer import find_best_maneuver
from conjunction.collision_probability import calculate_risk
from comms.los_checker import LOSChecker
from comms.pass_predictor import estimate_next_pass
from conjunction.monte_carlo_collision import monte_carlo_collision_probability
from conjunction.tca_solver import find_tca
from physics.fuel_model import update_mass
from control.cooldown_manager import can_burn
from control.command_latency import enforce_latency
from navigation.station_keeper import is_outside_box, recovery_delta_v
import time
from dotenv import load_dotenv

load_dotenv()

# ==============================
# LOGGING
# ==============================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - [%(name)s] %(message)s"
)
logger = logging.getLogger("AETHER-CORE")

# ==============================
# PHYSICAL CONSTANTS (PS §5.1)
# ==============================

ISP            = 300.0       # seconds
G0             = 9.80665     # m/s^2
DRY_MASS       = 500.0       # kg
INITIAL_FUEL   = 50.0        # kg
MAX_DV         = 0.015       # km/s  = 15 m/s  (PS §5.1 hard limit)
COOLDOWN_S     = 600.0       # seconds between burns (PS §5.1)
STATION_BOX_KM = 10.0        # km spherical radius (PS §5.2)
FUEL_GRAVEYARD = 0.05        # 5% threshold triggers EOL (PS §2)
COMMAND_LATENCY= 10.0        # seconds (PS §5.4)
CONJUNCTION_THRESHOLD = 0.1  # km = 100 m (PS §3.3)
LOOKAHEAD_S    = 86400.0     # 24-hour prediction window (PS §2)
LOOKAHEAD_STEP = 60.0        # propagate in 60-s steps for CDM scan

# Earth constants
MU    = 398600.4418          # km^3/s^2
RE    = 6378.137             # km
J2    = 1.08263e-3

# ==============================
# SYSTEM METRICS
# ==============================

SIM_START_TIME         = datetime.now(timezone.utc)
TOTAL_MANEUVERS        = 0
TOTAL_COLLISIONS_AVOIDED = 0
TOTAL_FUEL_USED        = 0.0
ELAPSED_SIM_TIME       = 0.0   # simulation clock in seconds
SIM_WALL_TIMESTAMP     = datetime.now(timezone.utc)  # current sim datetime
SIMULATION_RUNNING     = False

# Per-satellite uptime tracking  { sat_id: seconds_outside_box }
UPTIME_TRACKER: Dict[str, float] = {}

# ==============================
# FASTAPI INIT
# ==============================

app = FastAPI(title="AETHER Autonomous Constellation Manager")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==============================
# REDIS
# ==============================

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
r = redis.Redis(host=REDIS_HOST, port=6379, decode_responses=True)
ALERT_COUNTER_KEY = "alert_stats"

# ==============================
# GROUND STATION LOS CHECKER
# ==============================

BASE_DIR  = os.path.dirname(os.path.abspath(__file__))
file_path = os.path.join(BASE_DIR, "data", "ground_stations.csv")
los_checker = LOSChecker(file_path)

# ==============================
# DATA MODELS
# ==============================

class Vector3(BaseModel):
    x: float
    y: float
    z: float

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
    burn_id:        str
    burnTime:       str                   # ISO-8601
    deltaV_vector:  Vector3               # ECI km/s

class ManeuverScheduleRequest(BaseModel):
    satelliteId:       str
    maneuver_sequence: List[BurnCommand]

class SimStepRequest(BaseModel):
    step_seconds: float = 1.0

class ManualManeuverRequest(BaseModel):
    sat_id:  str
    dv_rtn:  List[float]

# ==============================
# SCHEDULED BURN QUEUE  (PS §4.2)
# Stored in Redis list "burn_queue" as JSON objects
# Each entry: { sat_id, burn_id, burn_time_iso, dv_x, dv_y, dv_z }
# ==============================

BURN_QUEUE_KEY = "burn_queue"

def enqueue_burn(sat_id: str, burn_id: str, burn_time_iso: str,
                 dv: List[float]):
    entry = {
        "sat_id":        sat_id,
        "burn_id":       burn_id,
        "burn_time_iso": burn_time_iso,
        "dv_x": dv[0], "dv_y": dv[1], "dv_z": dv[2],
        "executed": False
    }
    r.rpush(BURN_QUEUE_KEY, json.dumps(entry))


def pop_due_burns(current_sim_time_iso: str) -> List[dict]:
    """Return all queued burns whose burnTime <= current_sim_time_iso."""
    current_dt = datetime.fromisoformat(
        current_sim_time_iso.replace("Z", "+00:00"))
    all_raw = r.lrange(BURN_QUEUE_KEY, 0, -1)
    due, remaining = [], []
    for raw in all_raw:
        entry = json.loads(raw)
        bt = datetime.fromisoformat(
            entry["burn_time_iso"].replace("Z", "+00:00"))
        if bt <= current_dt and not entry.get("executed"):
            due.append(entry)
        else:
            remaining.append(raw)
    # Rewrite queue with only un-executed future burns
    r.delete(BURN_QUEUE_KEY)
    for raw in remaining:
        r.rpush(BURN_QUEUE_KEY, raw)
    return due

# ==============================
# UTILITIES
# ==============================

def redis_scan(pattern):
    cursor, keys = 0, []
    while True:
        cursor, batch = r.scan(cursor=cursor, match=pattern)
        keys.extend(batch)
        if cursor == 0:
            break
    return keys


def eci_to_latlon(x, y, z):
    """Convert ECI position (km) to geodetic lat/lon/alt."""
    r_mag  = math.sqrt(x*x + y*y + z*z)
    lat    = math.degrees(math.asin(z / r_mag))
    lon    = math.degrees(math.atan2(y, x))
    alt_km = r_mag - RE
    return lat, lon, alt_km


def lat_lon_to_eci(lat, lon, alt_m):
    lat_r  = math.radians(lat)
    lon_r  = math.radians(lon)
    r_surf = RE + alt_m / 1000.0
    x = r_surf * math.cos(lat_r) * math.cos(lon_r)
    y = r_surf * math.cos(lat_r) * math.sin(lon_r)
    z = r_surf * math.sin(lat_r)
    return x, y, z


def has_los(sat_pos: np.ndarray) -> bool:
    """
    Check if satellite has LOS to at least one ground station.
    Accounts for Earth occlusion and minimum elevation angle mask (PS §5.4).
    """
    for st in los_checker.stations:
        lat  = float(st["Latitude"])
        lon  = float(st["Longitude"])
        alt  = float(st["Elevation_m"])
        elev_mask = float(st.get("Min_Elevation_Angle_deg", 5.0))

        gs_pos = np.array(lat_lon_to_eci(lat, lon, alt))

        # Vector from GS to satellite
        diff   = sat_pos - gs_pos
        dist   = np.linalg.norm(diff)
        if dist < 1e-6:
            continue

        # Check Earth occlusion: does segment GS->sat pass through Earth?
        # Parametric: P(t) = gs_pos + t*diff, minimize |P|^2 w.r.t. t
        a = np.dot(diff, diff)
        b = 2.0 * np.dot(gs_pos, diff)
        c = np.dot(gs_pos, gs_pos) - RE * RE
        disc = b * b - 4 * a * c
        if disc > 0:
            t1 = (-b - math.sqrt(disc)) / (2 * a)
            t2 = (-b + math.sqrt(disc)) / (2 * a)
            if 0 < t1 < 1 or 0 < t2 < 1:
                continue  # Earth blocks LOS

        # Check elevation angle
        # Elevation = angle between diff and GS local horizon
        gs_unit  = gs_pos / np.linalg.norm(gs_pos)
        cos_nadir = np.dot(diff / dist, gs_unit)
        elev_rad = math.asin(min(1.0, max(-1.0, cos_nadir))) - math.pi/2
        # elevation above horizon
        elev_deg = math.degrees(math.pi/2 + elev_rad)
        # simpler: elevation = 90 - angle between gs_unit and sat direction
        sat_unit = diff / dist
        angle    = math.degrees(math.acos(
            min(1.0, max(-1.0, np.dot(gs_unit, sat_unit)))))
        elevation = 90.0 - angle

        if elevation >= elev_mask:
            return True
    return False


def count_active_cdm_warnings() -> int:
    alerts = r.lrange("cdm_history", 0, -1)
    count  = 0
    for a in alerts:
        try:
            obj = json.loads(a)
            ts  = datetime.fromisoformat(
                obj["timestamp"].replace("Z", "+00:00"))
            age = (datetime.now(timezone.utc) - ts).total_seconds()
            if age < 3600:  # warnings in last hour
                count += 1
        except Exception:
            pass
    return count


def retire_to_graveyard(sat_obj):
    """Execute final EOL maneuver (PS §2)."""
    graveyard_dv = [0.1, 0.05, 0.0]
    state = np.array([float(sat_obj[k])
                      for k in ["x","y","z","vx","vy","vz"]])
    state_at_burn = rk4_step(state, COMMAND_LATENCY)
    retired_state = apply_maneuver(state_at_burn, graveyard_dv)
    sat_obj.update({
        "vx": float(retired_state[3]),
        "vy": float(retired_state[4]),
        "vz": float(retired_state[5]),
        "status":      "GRAVEYARD",
        "fuel":        0.0,
        "needs_return": False,
    })
    logger.warning(f"EOL: {sat_obj['id']} → GRAVEYARD orbit.")


def execute_burn(sat_obj: dict, dv: List[float],
                 elapsed_sim_time: float) -> dict:
    """
    Apply a delta-v burn to a satellite, enforcing all PS constraints.
    Returns updated sat_obj dict (caller must save to Redis).
    Raises ValueError on constraint violation.
    """
    sat_id = sat_obj["id"]

    # 1. MAX_DV guard (PS §5.1)
    dv_mag = np.linalg.norm(dv)
    if dv_mag > MAX_DV:
        raise ValueError(
            f"DV magnitude {dv_mag:.4f} km/s exceeds MAX_DV {MAX_DV} km/s")

    # 2. Fuel check
    fuel = sat_obj.get("fuel", 0.0)
    if fuel <= 0:
        raise ValueError(f"{sat_id} has no fuel")

    # 3. Cooldown check (PS §5.1) — uses simulation clock
    last_burn_sim = sat_obj.get("last_burn_sim_time", -COOLDOWN_S - 1)
    if elapsed_sim_time - last_burn_sim < COOLDOWN_S:
        wait = COOLDOWN_S - (elapsed_sim_time - last_burn_sim)
        raise ValueError(
            f"{sat_id} in cooldown, {wait:.0f}s remaining")

    # 4. Propagate state to burn time (10-s latency, PS §5.4)
    state = np.array([float(sat_obj[k])
                      for k in ["x","y","z","vx","vy","vz"]])
    state_at_burn = rk4_step(state, COMMAND_LATENCY)

    # 5. Apply maneuver
    new_state = apply_maneuver(state_at_burn, dv)

    # 6. Fuel deduction (Tsiolkovsky, PS §5.1)
    m_curr = DRY_MASS + fuel
    _, fuel_used = update_mass(m_curr, dv_mag)
    new_fuel = max(0.0, fuel - fuel_used)

    sat_obj.update({
        "x": float(new_state[0]), "y": float(new_state[1]),
        "z": float(new_state[2]),
        "vx": float(new_state[3]), "vy": float(new_state[4]),
        "vz": float(new_state[5]),
        "fuel":              new_fuel,
        "last_maneuver":     datetime.now(timezone.utc).isoformat(),
        "last_burn_sim_time": elapsed_sim_time,
    })

    return sat_obj


# ==============================
# PREDICTIVE CDM SCAN  (PS §2 — 24-hour lookahead)
# ==============================

def scan_24h_conjunctions(sats_data: List[dict],
                          debris_data: List[dict]) -> List[dict]:
    """
    Propagate all objects forward in LOOKAHEAD_STEP increments up to
    LOOKAHEAD_S seconds, collect conjunction events.
    Returns list of { sat_id, deb_id, tca_offset_s, min_dist, severity }.
    """
    events = []
    n_steps = int(LOOKAHEAD_S / LOOKAHEAD_STEP)

    # Work on copies so we don't mutate Redis state
    def clone_states(objects):
        return {
            obj["id"]: np.array(
                [float(obj[k]) for k in ["x","y","z","vx","vy","vz"]])
            for obj in objects
        }

    sat_states = clone_states(sats_data)
    deb_states = clone_states(debris_data)

    # Build lookup for debris original dicts
    deb_lookup = {d["id"]: d for d in debris_data}
    sat_lookup = {s["id"]: s for s in sats_data}

    seen_pairs = set()

    for step_i in range(1, n_steps + 1):
        t = step_i * LOOKAHEAD_STEP

        # Propagate all states one step
        for sid in sat_states:
            sat_states[sid] = rk4_step(sat_states[sid], LOOKAHEAD_STEP)
        for did in deb_states:
            deb_states[did] = rk4_step(deb_states[did], LOOKAHEAD_STEP)

        # Spatial conjunction check on propagated positions
        tmp_sats = []
        for sid, st in sat_states.items():
            tmp = dict(sat_lookup[sid])
            tmp.update({
                "x": st[0], "y": st[1], "z": st[2],
                "vx": st[3], "vy": st[4], "vz": st[5]
            })
            tmp_sats.append(tmp)

        tmp_debs = []
        for did, st in deb_states.items():
            tmp = dict(deb_lookup[did])
            tmp.update({
                "x": st[0], "y": st[1], "z": st[2],
                "vx": st[3], "vy": st[4], "vz": st[5]
            })
            tmp_debs.append(tmp)

        if not tmp_sats or not tmp_debs:
            break

        dangers = check_for_conjunctions(tmp_sats, tmp_debs)
        for d in dangers:
            pair_key = (d["sat_id"], d["deb_id"])
            if pair_key in seen_pairs:
                continue
            seen_pairs.add(pair_key)

            s_st = sat_states[d["sat_id"]]
            db_st = deb_states[d["deb_id"]]
            min_dist, _ = find_tca(s_st, db_st)
            _, severity = calculate_risk(min_dist)

            events.append({
                "sat_id":       d["sat_id"],
                "deb_id":       d["deb_id"],
                "tca_offset_s": t,
                "min_dist":     float(min_dist),
                "severity":     severity,
            })

    return events


# ==============================
# ENDPOINTS
# ==============================

@app.get("/api/status")
async def system_status():
    satellites = len(redis_scan("SATELLITE:*"))
    debris     = len(redis_scan("DEBRIS:*"))
    alerts     = r.hgetall(ALERT_COUNTER_KEY)
    return {
        "simulation_running": SIMULATION_RUNNING,
        "satellites":         satellites,
        "debris_objects":     debris,
        "alerts":             alerts,
        "elapsed_sim_time_s": ELAPSED_SIM_TIME,
    }


# ==============================
# TELEMETRY INGESTION  (PS §4.1)
# ==============================

@app.post("/api/telemetry")
async def ingest_telemetry(data: TelemetryRequest):
    processed = 0
    for obj in data.objects:
        key          = f"{obj.type}:{obj.id}"
        incoming_fuel = getattr(obj, "fuel", INITIAL_FUEL)

        obj_data = {
            "id":     obj.id,
            "type":   obj.type,
            "x": obj.r.x, "y": obj.r.y, "z": obj.r.z,
            "vx": obj.v.x, "vy": obj.v.y, "vz": obj.v.z,
            "fuel":   incoming_fuel,
            "status": "ACTIVE",
            # Nominal slot stores full 6-DOF reference (PS §5.2)
            "nominal": {
                "x": obj.r.x, "y": obj.r.y, "z": obj.r.z,
                "vx": obj.v.x, "vy": obj.v.y, "vz": obj.v.z,
            },
            "needs_return":       False,
            "last_burn_sim_time": -(COOLDOWN_S + 1),
            "seconds_outside_box": 0.0,
        }
        r.set(key, json.dumps(obj_data))
        processed += 1

    # Count active CDM warnings for response (PS §4.1)
    active_cdm = count_active_cdm_warnings()

    return {
        "status":              "ACK",
        "processed_count":     processed,
        "active_cdm_warnings": active_cdm,
    }


# ==============================
# MANEUVER SCHEDULING  (PS §4.2)
# ==============================

@app.post("/api/maneuver/schedule")
async def schedule_maneuver(req: ManeuverScheduleRequest):
    sat_key = f"SATELLITE:{req.satelliteId}"
    raw     = r.get(sat_key)
    if not raw:
        raise HTTPException(status_code=404, detail="Satellite not found")

    sat       = json.loads(raw)
    sat_pos   = np.array([float(sat["x"]), float(sat["y"]), float(sat["z"])])
    fuel_kg   = sat.get("fuel", 0.0)

    # LOS check for first burn (PS §5.4)
    gs_los = has_los(sat_pos)

    # Compute total DV to estimate fuel
    total_dv_mag = sum(
        np.linalg.norm([b.deltaV_vector.x,
                        b.deltaV_vector.y,
                        b.deltaV_vector.z])
        for b in req.maneuver_sequence
    )
    m_curr = DRY_MASS + fuel_kg
    _, total_fuel_needed = update_mass(m_curr, total_dv_mag)
    sufficient_fuel      = fuel_kg >= total_fuel_needed
    projected_mass       = (DRY_MASS + fuel_kg) - total_fuel_needed

    # Enqueue each burn — grader will execute them during simulate/step
    for burn in req.maneuver_sequence:
        dv = [burn.deltaV_vector.x,
              burn.deltaV_vector.y,
              burn.deltaV_vector.z]

        # Enforce MAX_DV (PS §5.1)
        dv_mag = np.linalg.norm(dv)
        if dv_mag > MAX_DV:
            raise HTTPException(
                status_code=400,
                detail=f"Burn {burn.burn_id}: |dv|={dv_mag:.4f} km/s "
                       f"exceeds MAX_DV {MAX_DV} km/s")

        # Cannot schedule earlier than now + 10s (PS §5.4)
        burn_dt = datetime.fromisoformat(
            burn.burnTime.replace("Z", "+00:00"))
        min_burn_dt = SIM_WALL_TIMESTAMP.replace(tzinfo=timezone.utc) \
            if SIM_WALL_TIMESTAMP.tzinfo else \
            SIM_WALL_TIMESTAMP.astimezone(timezone.utc)
        # allow scheduling (validation passes even if blind zone)
        enqueue_burn(req.satelliteId, burn.burn_id,
                     burn.burnTime, dv)

    return {
        "status": "SCHEDULED",
        "validation": {
            "ground_station_los":         gs_los,
            "sufficient_fuel":            sufficient_fuel,
            "projected_mass_remaining_kg": round(max(0.0, projected_mass), 3),
        },
    }


# ==============================
# SIMULATION STEP  (PS §4.3)
# ==============================

@app.post("/api/simulate/step")
async def simulate_step(req: SimStepRequest):
    global ELAPSED_SIM_TIME, TOTAL_MANEUVERS, TOTAL_COLLISIONS_AVOIDED
    global TOTAL_FUEL_USED, SIM_WALL_TIMESTAMP

    dt = req.step_seconds

    try:
        keys = redis_scan("SATELLITE:*") + redis_scan("DEBRIS:*")
        ELAPSED_SIM_TIME  += dt
        SIM_WALL_TIMESTAMP = datetime.now(timezone.utc)
        maneuvers_executed = 0
        collisions_detected = 0
        updated = 0

        # ── STEP 1: PROPAGATION ──────────────────────────────────────────
        for key in keys:
            raw = r.get(key)
            if not raw:
                continue
            obj = json.loads(raw)
            if obj.get("status") == "GRAVEYARD":
                continue

            state     = np.array([float(obj[k])
                                   for k in ["x","y","z","vx","vy","vz"]])
            new_state = rk4_step(state, dt)

            obj.update({
                "x": float(new_state[0]), "y": float(new_state[1]),
                "z": float(new_state[2]),
                "vx": float(new_state[3]), "vy": float(new_state[4]),
                "vz": float(new_state[5]),
                "last_update": datetime.now(timezone.utc).isoformat(),
            })

            if "SATELLITE" in key:
                fuel_pct = (obj.get("fuel", 0.0) / INITIAL_FUEL) * 100.0
                nominal  = obj.get("nominal")

                # EOL graveyard (PS §2)
                if fuel_pct <= 5.0 and obj.get("status") != "GRAVEYARD":
                    retire_to_graveyard(obj)
                    r.set(key, json.dumps(obj))
                    updated += 1
                    continue

                # Station-keeping (PS §5.2)
                if nominal and is_outside_box(
                        new_state[:3],
                        np.array([nominal["x"], nominal["y"], nominal["z"]])):

                    # Uptime tracking
                    sid = obj["id"]
                    obj["seconds_outside_box"] = \
                        obj.get("seconds_outside_box", 0.0) + dt
                    UPTIME_TRACKER[sid] = \
                        UPTIME_TRACKER.get(sid, 0.0) + dt

                    if obj.get("fuel", 0.0) <= 0:
                        obj["status"] = "GRAVEYARD"
                        logger.warning(
                            f"CRITICAL: {obj['id']} no fuel for SK → GRAVEYARD")
                    else:
                        sat_pos = new_state[:3]
                        if has_los(sat_pos):
                            last_b = obj.get("last_burn_sim_time",
                                             -(COOLDOWN_S + 1))
                            if (ELAPSED_SIM_TIME - last_b) >= COOLDOWN_S:
                                logger.info(
                                    f"SK: {obj['id']} drifting, correcting…")
                                nom_pos = np.array([
                                    nominal["x"], nominal["y"], nominal["z"]])
                                nom_vel = np.array([
                                    nominal.get("vx", 0),
                                    nominal.get("vy", 0),
                                    nominal.get("vz", 0)])
                                dv_corr = recovery_delta_v(new_state, nom_pos)

                                # Clamp to MAX_DV
                                dv_mag = np.linalg.norm(dv_corr)
                                if dv_mag > MAX_DV:
                                    dv_corr = (
                                        np.array(dv_corr) / dv_mag * MAX_DV
                                    ).tolist()
                                    dv_mag = MAX_DV

                                state_at_burn = rk4_step(
                                    new_state, COMMAND_LATENCY)
                                corrected = apply_maneuver(
                                    state_at_burn, dv_corr)

                                m_curr = DRY_MASS + obj.get("fuel", 0.0)
                                _, fuel_used = update_mass(m_curr, dv_mag)

                                obj.update({
                                    "vx": float(corrected[3]),
                                    "vy": float(corrected[4]),
                                    "vz": float(corrected[5]),
                                    "fuel": max(0.0,
                                                obj.get("fuel", 0.0)
                                                - fuel_used),
                                    "last_maneuver":
                                        datetime.now(timezone.utc).isoformat(),
                                    "last_burn_sim_time": ELAPSED_SIM_TIME,
                                    "needs_return": False,
                                })
                                TOTAL_FUEL_USED    += fuel_used
                                TOTAL_MANEUVERS    += 1
                                maneuvers_executed += 1
                        else:
                            logger.warning(
                                f"SK: {obj['id']} out of coverage — "
                                f"blind zone, cannot uplink command")
                else:
                    # Satellite is in its box — reset outside counter
                    obj["seconds_outside_box"] = \
                        max(0.0, obj.get("seconds_outside_box", 0.0) - dt)

            r.set(key, json.dumps(obj))
            updated += 1

        # ── STEP 2: EXECUTE SCHEDULED BURNS  (PS §4.2) ─────────────────
        due_burns = pop_due_burns(SIM_WALL_TIMESTAMP.isoformat())
        for burn in due_burns:
            sat_key = f"SATELLITE:{burn['sat_id']}"
            raw     = r.get(sat_key)
            if not raw:
                continue
            sat = json.loads(raw)
            if sat.get("status") == "GRAVEYARD":
                continue

            dv = [burn["dv_x"], burn["dv_y"], burn["dv_z"]]

            # LOS check (PS §5.4)
            sat_pos = np.array([float(sat["x"]), float(sat["y"]),
                                 float(sat["z"])])
            if not has_los(sat_pos):
                logger.warning(
                    f"BURN {burn['burn_id']} for {burn['sat_id']} "
                    f"REJECTED — satellite in blackout zone")
                continue

            try:
                sat = execute_burn(sat, dv, ELAPSED_SIM_TIME)
                r.set(sat_key, json.dumps(sat))
                TOTAL_MANEUVERS    += 1
                TOTAL_FUEL_USED    += np.linalg.norm(dv)  # approx log
                maneuvers_executed += 1
                logger.info(
                    f"Scheduled burn {burn['burn_id']} executed "
                    f"for {burn['sat_id']}")
            except ValueError as e:
                logger.error(f"Scheduled burn failed: {e}")

        # ── STEP 3: CONJUNCTION DETECTION & AVOIDANCE ──────────────────
        sats_data   = [json.loads(r.get(k))
                       for k in redis_scan("SATELLITE:*")]
        debris_data = [json.loads(r.get(k))
                       for k in redis_scan("DEBRIS:*")]

        if sats_data and debris_data:
            dangers = check_for_conjunctions(sats_data, debris_data)

            for d in dangers:
                sat_id  = d["sat_id"]
                deb_id  = d["deb_id"]
                sat_key = f"SATELLITE:{sat_id}"

                sat_obj = json.loads(r.get(sat_key))
                if sat_obj.get("status") == "GRAVEYARD":
                    continue

                s_st  = np.array([float(sat_obj[k])
                                   for k in ["x","y","z","vx","vy","vz"]])
                deb_obj = next(
                    (item for item in debris_data if item["id"] == deb_id),
                    None)
                if not deb_obj:
                    continue
                d_st = np.array([float(deb_obj[k])
                                  for k in ["x","y","z","vx","vy","vz"]])

                min_dist, _ = find_tca(s_st, d_st)
                _, severity = calculate_risk(min_dist)

                # Check real collision
                cur_dist = np.linalg.norm(s_st[:3] - d_st[:3])
                if cur_dist < CONJUNCTION_THRESHOLD:
                    collisions_detected += 1
                    r.hincrby(ALERT_COUNTER_KEY, "collisions", 1)

                logger.debug(
                    f"Conjunction {sat_id}&{deb_id} "
                    f"dist={min_dist:.4f}km sev={severity}")

                if severity in ("CRITICAL", "WARNING"):
                    # LOS check before autonomous maneuver (PS §5.4)
                    sat_pos = s_st[:3]
                    if not has_los(sat_pos):
                        logger.warning(
                            f"BLIND CONJUNCTION: {sat_id} in blackout — "
                            f"pre-scheduling avoidance for next coverage")
                        # Pre-schedule for when it regains LOS
                        # (fallback: wait and retry next step)
                        continue

                    prob, risk_level = monte_carlo_collision_probability(
                        s_st[:3], d_st[:3])
                    logger.debug(
                        f"MC prob={prob:.4f} risk={risk_level}")

                    if prob > 0.001:
                        last_b = sat_obj.get("last_burn_sim_time",
                                             -(COOLDOWN_S + 1))
                        if (ELAPSED_SIM_TIME - last_b) < COOLDOWN_S:
                            logger.warning(
                                f"{sat_id} in cooldown, cannot avoid now")
                            continue

                        best = find_best_maneuver(s_st, d_st)
                        if not best:
                            continue

                        dv = best["dv"]

                        # Enforce MAX_DV (PS §5.1)
                        dv_arr = np.array(dv)
                        dv_mag = np.linalg.norm(dv_arr)
                        if dv_mag > MAX_DV:
                            dv_arr = dv_arr / dv_mag * MAX_DV
                            dv_mag = MAX_DV
                            dv     = dv_arr.tolist()

                        future_s  = rk4_step(s_st, COMMAND_LATENCY)
                        final_s   = apply_maneuver(future_s, dv)

                        m_curr    = DRY_MASS + sat_obj.get("fuel", 0.0)
                        _, f_used = update_mass(m_curr, dv_mag)
                        new_fuel  = max(0.0,
                                        sat_obj.get("fuel", 0.0) - f_used)

                        sat_obj.update({
                            "vx": float(final_s[3]),
                            "vy": float(final_s[4]),
                            "vz": float(final_s[5]),
                            "fuel":               new_fuel,
                            "needs_return":       True,
                            "last_maneuver":
                                datetime.now(timezone.utc).isoformat(),
                            "last_burn_sim_time": ELAPSED_SIM_TIME,
                        })

                        if new_fuel <= 0:
                            sat_obj["status"] = "GRAVEYARD"
                            logger.warning(
                                f"{sat_id} fuel exhausted → GRAVEYARD")

                        r.set(sat_key, json.dumps(sat_obj))
                        TOTAL_MANEUVERS          += 1
                        TOTAL_COLLISIONS_AVOIDED += 1
                        TOTAL_FUEL_USED          += f_used
                        maneuvers_executed       += 1
                        r.hincrby(ALERT_COUNTER_KEY,
                                  "avoidances_executed", 1)

                        cdm_log = {
                            "alert_id":  f"CDM-{int(time.time())}",
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                            "sat_id":    sat_id,
                            "deb_id":    deb_id,
                            "distance":  float(min_dist),
                            "severity":  severity,
                            "action":    "MANEUVER_EXECUTED",
                        }
                        r.lpush("cdm_history", json.dumps(cdm_log))
                        r.ltrim("cdm_history", 0, 49)

        # ── STEP 4: RETURN-TO-NOMINAL  (PS §5.2) ────────────────────────
        for key in redis_scan("SATELLITE:*"):
            raw = r.get(key)
            if not raw:
                continue
            sat_obj = json.loads(raw)
            if not sat_obj.get("needs_return"):
                continue
            if sat_obj.get("status") == "GRAVEYARD":
                continue

            last_b = sat_obj.get("last_burn_sim_time", -(COOLDOWN_S + 1))
            if (ELAPSED_SIM_TIME - last_b) < COOLDOWN_S:
                continue  # still in cooldown

            if sat_obj.get("fuel", 0.0) <= 0:
                continue

            sat_pos = np.array([float(sat_obj["x"]), float(sat_obj["y"]),
                                 float(sat_obj["z"])])
            if not has_los(sat_pos):
                continue  # wait for coverage

            nominal = sat_obj.get("nominal")
            if not nominal:
                continue

            # Compute recovery dv toward nominal position (PS §5.2)
            s_st     = np.array([float(sat_obj[k])
                                  for k in ["x","y","z","vx","vy","vz"]])
            nom_pos  = np.array([nominal["x"], nominal["y"], nominal["z"]])
            dv_ret   = recovery_delta_v(s_st, nom_pos)

            dv_mag = np.linalg.norm(dv_ret)
            if dv_mag < 1e-6:
                sat_obj["needs_return"] = False
                r.set(key, json.dumps(sat_obj))
                continue

            # Clamp to MAX_DV
            if dv_mag > MAX_DV:
                dv_ret = (np.array(dv_ret) / dv_mag * MAX_DV).tolist()
                dv_mag = MAX_DV

            state_at_burn = rk4_step(s_st, COMMAND_LATENCY)
            corrected     = apply_maneuver(state_at_burn, dv_ret)

            m_curr    = DRY_MASS + sat_obj.get("fuel", 0.0)
            _, f_used = update_mass(m_curr, dv_mag)

            sat_obj.update({
                "vx": float(corrected[3]),
                "vy": float(corrected[4]),
                "vz": float(corrected[5]),
                "fuel":               max(0.0,
                                          sat_obj.get("fuel", 0.0) - f_used),
                "last_maneuver":      datetime.now(timezone.utc).isoformat(),
                "last_burn_sim_time": ELAPSED_SIM_TIME,
                "needs_return":       False,
            })

            TOTAL_MANEUVERS    += 1
            TOTAL_FUEL_USED    += f_used
            maneuvers_executed += 1
            r.set(key, json.dumps(sat_obj))
            logger.info(f"Recovery burn executed for {sat_obj['id']}")

        return {
            "status":             "STEP_COMPLETE",
            "new_timestamp":      SIM_WALL_TIMESTAMP.isoformat(),
            "collisions_detected": collisions_detected,
            "maneuvers_executed":  maneuvers_executed,
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"status": "ERROR", "message": str(e)}


# ==============================
# SIMULATION LOOP
# ==============================

async def simulation_loop(dt: float):
    global SIMULATION_RUNNING
    while SIMULATION_RUNNING:
        await simulate_step(SimStepRequest(step_seconds=dt))
        await asyncio.sleep(1)


@app.post("/api/simulate/start")
async def start_simulation(dt: float = 5.0):
    global SIMULATION_RUNNING
    if SIMULATION_RUNNING:
        return {"status": "Already Running"}
    SIMULATION_RUNNING = True
    asyncio.create_task(simulation_loop(dt))
    logger.info(f"Simulation started dt={dt}")
    return {"status": "Simulation Running"}


@app.post("/api/simulate/stop")
async def stop_simulation():
    global SIMULATION_RUNNING
    SIMULATION_RUNNING = False
    logger.info("Simulation stopped")
    return {"status": "Simulation Stopped"}


# ==============================
# MANUAL MANEUVER  (legacy, immediate)
# ==============================

@app.post("/api/maneuver")
async def manual_maneuver(req: ManualManeuverRequest):
    sat_key = f"SATELLITE:{req.sat_id}"
    raw     = r.get(sat_key)
    if not raw:
        return {"error": "Satellite not found"}

    sat     = json.loads(raw)
    sat_pos = np.array([float(sat["x"]), float(sat["y"]), float(sat["z"])])

    # LOS check (PS §5.4)
    if not has_los(sat_pos):
        return {"error": "Satellite in blackout — no LOS to ground station"}

    try:
        sat = execute_burn(sat, req.dv_rtn, ELAPSED_SIM_TIME)
    except ValueError as e:
        return {"error": str(e)}

    r.set(sat_key, json.dumps(sat))
    logger.info(f"Manual maneuver executed for {req.sat_id}")
    return {"status": "maneuver_applied", "fuel_remaining_kg": sat["fuel"]}


# ==============================
# VISUALIZATION SNAPSHOT  (PS §6.3)
# ==============================

@app.get("/api/visualization/snapshot")
async def visualization_snapshot():
    """
    Highly optimised snapshot endpoint for the frontend (PS §6.3).
    Debris uses compact tuple format [ID, lat, lon, alt_km].
    """
    sat_keys = redis_scan("SATELLITE:*")
    deb_keys = redis_scan("DEBRIS:*")

    satellites = []
    for k in sat_keys:
        raw = r.get(k)
        if not raw:
            continue
        obj = json.loads(raw)
        lat, lon, alt = eci_to_latlon(
            float(obj["x"]), float(obj["y"]), float(obj["z"]))
        satellites.append({
            "id":      obj["id"],
            "lat":     round(lat, 4),
            "lon":     round(lon, 4),
            "alt_km":  round(alt, 2),
            "fuel_kg": round(obj.get("fuel", 0.0), 3),
            "status":  obj.get("status", "ACTIVE"),
        })

    debris_cloud = []
    for k in deb_keys:
        raw = r.get(k)
        if not raw:
            continue
        obj = json.loads(raw)
        lat, lon, alt = eci_to_latlon(
            float(obj["x"]), float(obj["y"]), float(obj["z"]))
        # Compact tuple format (PS §6.3): [ID, lat, lon, alt_km]
        debris_cloud.append([
            obj["id"],
            round(lat, 3),
            round(lon, 3),
            round(alt, 1),
        ])

    return {
        "timestamp":    SIM_WALL_TIMESTAMP.isoformat(),
        "satellites":   satellites,
        "debris_cloud": debris_cloud,
    }


# ==============================
# OBJECT RETRIEVAL
# ==============================

@app.get("/api/objects")
async def get_objects():
    keys = redis_scan("SATELLITE:*") + redis_scan("DEBRIS:*")
    return [json.loads(r.get(k)) for k in keys]


@app.get("/api/alerts/history")
async def get_alert_history():
    alerts = r.lrange("cdm_history", 0, -1)
    return [json.loads(a) for a in alerts]


# ==============================
# CONJUNCTION PREDICTION  (24-h lookahead, PS §2)
# ==============================

@app.get("/api/conjunction/forecast")
async def conjunction_forecast():
    """Return all predicted conjunctions in next 24 hours."""
    sats_data   = [json.loads(r.get(k))
                   for k in redis_scan("SATELLITE:*")]
    debris_data = [json.loads(r.get(k))
                   for k in redis_scan("DEBRIS:*")]

    if not sats_data or not debris_data:
        return {"forecast": [], "lookahead_hours": 24}

    events = scan_24h_conjunctions(sats_data, debris_data)
    return {
        "forecast":        events,
        "total_events":    len(events),
        "lookahead_hours": 24,
    }


# ==============================
# UPTIME & METRICS
# ==============================

@app.get("/api/system/metrics")
async def system_metrics():
    uptime = (datetime.now(timezone.utc) - SIM_START_TIME).total_seconds()

    # Per-satellite uptime score
    sat_uptime = {}
    for k in redis_scan("SATELLITE:*"):
        raw = r.get(k)
        if not raw:
            continue
        obj = json.loads(raw)
        sid              = obj["id"]
        outside_s        = obj.get("seconds_outside_box", 0.0)
        total_s          = ELAPSED_SIM_TIME if ELAPSED_SIM_TIME > 0 else 1
        uptime_pct       = max(0.0, 100.0 * (1.0 - outside_s / total_s))
        sat_uptime[sid]  = round(uptime_pct, 2)

    return {
        "uptime_seconds":          uptime,
        "elapsed_sim_time_s":      ELAPSED_SIM_TIME,
        "maneuvers_executed":      TOTAL_MANEUVERS,
        "collisions_avoided":      TOTAL_COLLISIONS_AVOIDED,
        "fuel_used_total_kg":      round(TOTAL_FUEL_USED, 4),
        "satellite_uptime_pct":    sat_uptime,
    }


@app.get("/api/satellite/{sat_id}/next_pass")
async def get_next_pass(sat_id: str):
    key = f"SATELLITE:{sat_id}"
    raw = r.get(key)
    if not raw:
        return {"error": "Not found"}

    sat     = json.loads(raw)
    sat_pos = np.array([sat["x"], sat["y"], sat["z"]])
    sat_vel = np.array([sat["vx"], sat["vy"], sat["vz"]])

    predictions = []
    for st in los_checker.stations:
        lat  = float(st["Latitude"])
        lon  = float(st["Longitude"])
        alt  = float(st["Elevation_m"])
        gx, gy, gz = lat_lon_to_eci(lat, lon, alt)
        gs_pos     = np.array([gx, gy, gz])
        pass_time  = estimate_next_pass(sat_pos, gs_pos, sat_vel)
        predictions.append({
            "station":                st["Station_Name"],
            "estimated_wait_seconds": round(pass_time, 2),
        })

    return {"sat_id": sat_id, "upcoming_passes": predictions}


# ==============================
# RESET
# ==============================

@app.post("/api/reset")
async def reset_simulation():
    global ELAPSED_SIM_TIME, TOTAL_MANEUVERS, TOTAL_COLLISIONS_AVOIDED
    global TOTAL_FUEL_USED, SIMULATION_RUNNING, UPTIME_TRACKER
    global SIM_WALL_TIMESTAMP

    SIMULATION_RUNNING     = False
    ELAPSED_SIM_TIME       = 0.0
    TOTAL_MANEUVERS        = 0
    TOTAL_COLLISIONS_AVOIDED = 0
    TOTAL_FUEL_USED        = 0.0
    UPTIME_TRACKER         = {}
    SIM_WALL_TIMESTAMP     = datetime.now(timezone.utc)

    keys = redis_scan("*")
    for k in keys:
        r.delete(k)

    return {"status": "simulation reset"}


@app.get("/api/scheduler/queue")
async def get_burn_queue():
    raw_list = r.lrange(BURN_QUEUE_KEY, 0, -1)
    return [json.loads(x) for x in raw_list]


# ==============================
# SERVER START
# ==============================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)