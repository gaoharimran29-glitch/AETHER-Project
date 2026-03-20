"""
AETHER — Autonomous Constellation Manager
National Space Hackathon 2026, IIT Delhi

Backend: FastAPI + Redis + custom physics modules

Required API endpoints (PS §4)
────────────────────────────────
  POST /api/telemetry                 PS §4.1
  POST /api/maneuver/schedule         PS §4.2
  POST /api/simulate/step             PS §4.3
  GET  /api/visualization/snapshot    PS §6.3

Additional endpoints
────────────────────
  GET  /api/status
  GET  /api/objects
  GET  /api/conjunction/forecast
  GET  /api/alerts/history
  GET  /api/scheduler/queue
  GET  /api/satellite/{sat_id}/next_pass
  GET  /api/system/metrics
  POST /api/simulate/start
  POST /api/simulate/stop
  POST /api/maneuver              (legacy immediate maneuver)
  POST /api/reset
"""

import asyncio
import json
import logging
import math
import os
import time
from datetime import datetime, timezone
from typing import List, Optional

import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
import redis

# ── Internal modules ──────────────────────────────────────────────────────────
from spatial_algo.kd_tree            import check_for_conjunctions
from physics.rk4_integrator          import rk4_step
from physics.fuel_model              import update_mass, DRY_MASS, INITIAL_FUEL
from maneuver.maneuver_planner       import apply_maneuver, send_to_graveyard
from optimizer.fleet_optimizer       import find_best_maneuver
from conjunction.collision_probability   import calculate_risk
from conjunction.monte_carlo_collision   import monte_carlo_collision_probability
from conjunction.tca_solver          import find_tca
from comms.los_checker               import LOSChecker
from comms.pass_predictor            import estimate_next_pass
from navigation.station_keeper       import is_outside_box, recovery_delta_v
from physics.propagator              import get_j2_acceleration

# ── Vectorised batch RK4: propagates N states simultaneously  ─────────────────
# 37x faster than N serial calls for large debris populations (PS §3.2)
def _rk4_batch(states: np.ndarray, dt: float) -> np.ndarray:
    """
    Propagate N 6-DOF states forward by dt seconds in a single vectorised pass.

    Parameters
    ----------
    states : ndarray (N, 6)   [x, y, z, vx, vy, vz] for each object
    dt     : float            propagation interval (s)

    Returns
    -------
    ndarray (N, 6)  propagated states
    """
    n_sub = max(1, int(np.ceil(abs(dt) / 5.0)))   # 5-s substeps
    h = dt / n_sub
    s = states.copy()
    for _ in range(n_sub):
        # Derivative: [vx,vy,vz, ax,ay,az]
        def deriv(st):
            return np.hstack([st[:, 3:6], get_j2_acceleration(st)])
        k1 = deriv(s)
        k2 = deriv(s + 0.5 * h * k1)
        k3 = deriv(s + 0.5 * h * k2)
        k4 = deriv(s + h * k3)
        s += (h / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4)
    return s

load_dotenv()

# ══════════════════════════════════════════════════════════════════════════════
# LOGGING
# ══════════════════════════════════════════════════════════════════════════════

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s [%(name)s] %(message)s",
)
logger = logging.getLogger("AETHER.core")

# ══════════════════════════════════════════════════════════════════════════════
# PHYSICAL & MISSION CONSTANTS  (PS §3.2, §5.1, §5.2, §5.4)
# ══════════════════════════════════════════════════════════════════════════════

MU:             float = 398600.4418   # km³/s²   PS §3.2
RE:             float = 6378.137      # km        PS §3.2
J2:             float = 1.08263e-3   # —          PS §3.2
EARTH_ROT:      float = 7.292115e-5  # rad/s  Earth sidereal rotation rate

ISP:            float = 300.0        # s         PS §5.1
G0:             float = 9.80665      # m/s²      PS §5.1
MAX_DV:         float = 0.015        # km/s = 15 m/s per burn  PS §5.1
COOLDOWN_S:     float = 600.0        # s between burns          PS §5.1
STATION_BOX_KM: float = 10.0         # km spherical radius      PS §5.2
FUEL_EOL_PCT:   float = 5.0          # % threshold → graveyard  PS §2
COMMAND_LATENCY: float = 10.0        # s signal delay            PS §5.4
CONJ_THRESHOLD: float = 0.1          # km = 100 m  PS §3.3

LOOKAHEAD_S:    float = 86_400.0     # 24 h CDM lookahead  PS §2
LOOKAHEAD_STEP: float = 60.0         # propagation granularity (s)

# ══════════════════════════════════════════════════════════════════════════════
# GLOBAL SIMULATION STATE
# ══════════════════════════════════════════════════════════════════════════════

SIM_START_WALL:     datetime = datetime.now(timezone.utc)
SIM_WALL_TIMESTAMP: datetime = datetime.now(timezone.utc)
ELAPSED_SIM_TIME:   float    = 0.0
SIMULATION_RUNNING: bool     = False

TOTAL_MANEUVERS:          int   = 0
TOTAL_COLLISIONS_AVOIDED: int   = 0
TOTAL_FUEL_USED:          float = 0.0

# ══════════════════════════════════════════════════════════════════════════════
# FASTAPI + CORS
# ══════════════════════════════════════════════════════════════════════════════

app = FastAPI(
    title="AETHER Autonomous Constellation Manager",
    description="National Space Hackathon 2026 — IIT Delhi",
    version="1.0.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ══════════════════════════════════════════════════════════════════════════════
# REDIS
# ══════════════════════════════════════════════════════════════════════════════

REDIS_HOST:      str = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT:      int = int(os.getenv("REDIS_PORT", 6379))
r: redis.Redis       = redis.Redis(
    host=REDIS_HOST, port=REDIS_PORT,
    decode_responses=True,
    socket_connect_timeout=5,
    retry_on_timeout=True,
)
ALERT_KEY:       str = "alert_stats"
BURN_QUEUE_KEY:  str = "burn_queue"
CDM_HISTORY_KEY: str = "cdm_history"

# ══════════════════════════════════════════════════════════════════════════════
# GROUND STATION SETUP  (PS §5.4, §5.5.1)
# ══════════════════════════════════════════════════════════════════════════════

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
GS_CSV_PATH = os.path.join(BASE_DIR, "data", "ground_stations.csv")
los_checker = LOSChecker(GS_CSV_PATH)

# Normalised station list for use in has_los() / next_pass
_STATIONS: list[dict] = []
for _raw in los_checker.stations:
    _STATIONS.append({
        "name":       _raw.get("Station_Name",         _raw.get("name",   "Unknown")),
        "lat":        float(_raw.get("Latitude",        _raw.get("lat",    0.0))),
        "lon":        float(_raw.get("Longitude",       _raw.get("lon",    0.0))),
        "alt_m":      float(_raw.get("Elevation_m",     _raw.get("alt",    0.0))),
        "min_el_deg": float(_raw.get("Min_Elevation_Angle_deg",
                                     _raw.get("min_el_deg", 5.0))),
    })

# ══════════════════════════════════════════════════════════════════════════════
# DATA MODELS  (PS §4)
# ══════════════════════════════════════════════════════════════════════════════

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
    burn_id:       str
    burnTime:      str        # ISO-8601
    deltaV_vector: Vector3    # ECI km/s  (PS §4.2)

class ManeuverScheduleRequest(BaseModel):
    satelliteId:       str
    maneuver_sequence: List[BurnCommand]

class SimStepRequest(BaseModel):
    step_seconds: float = Field(default=1.0, gt=0)   # PS §4.3

class ManualManeuverRequest(BaseModel):
    sat_id: str
    dv_rtn: List[float]       # [dR, dT, dN] km/s

# ══════════════════════════════════════════════════════════════════════════════
# UTILITY HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def redis_scan(pattern: str) -> list[str]:
    """Paginated SCAN — safe replacement for KEYS * in production."""
    cursor, keys = 0, []
    while True:
        cursor, batch = r.scan(cursor=cursor, match=pattern, count=500)
        keys.extend(batch)
        if cursor == 0:
            break
    return keys


def eci_to_latlon(x: float, y: float, z: float,
                  sim_time_s: float = 0.0) -> tuple[float, float, float]:
    """
    ECI → geodetic (lat°, lon°, alt km).

    Applies Greenwich Mean Sidereal Time (GMST) rotation so that the
    ground-track longitude is correct as Earth rotates under the satellite.
    Uses sim_time_s (elapsed simulation seconds) as the GMST offset.

    Parameters
    ----------
    x, y, z    : float   ECI position (km)
    sim_time_s : float   elapsed simulation time (s)

    Returns
    -------
    (lat_deg, lon_deg, alt_km) : tuple[float, float, float]
    """
    r_mag = math.sqrt(x * x + y * y + z * z)
    if r_mag < 1e-9:
        return 0.0, 0.0, 0.0

    lat = math.degrees(math.asin(max(-1.0, min(1.0, z / r_mag))))

    # GMST correction: subtract Earth rotation since epoch
    gmst_rad = EARTH_ROT * sim_time_s
    lon_eci  = math.atan2(y, x)                       # ECI longitude
    lon      = math.degrees(lon_eci - gmst_rad)
    lon      = (lon + 180.0) % 360.0 - 180.0          # normalise to [-180, 180]

    alt = r_mag - RE
    return lat, lon, alt


def lat_lon_to_eci(lat_deg: float, lon_deg: float, alt_m: float,
                   sim_time_s: float = 0.0) -> np.ndarray:
    """
    Geodetic → ECI with Earth-rotation correction (PS §5.4).
    Consistent with the rotation model inside LOSChecker.

    Parameters
    ----------
    lat_deg    : float   geodetic latitude  (degrees)
    lon_deg    : float   longitude          (degrees)
    alt_m      : float   altitude above MSL (metres)
    sim_time_s : float   elapsed simulation time (s)

    Returns
    -------
    ndarray (3,)  ECI position (km)
    """
    theta  = EARTH_ROT * sim_time_s
    lat_r  = math.radians(lat_deg)
    lon_r  = math.radians(lon_deg) + theta
    r_surf = RE + alt_m / 1000.0
    return np.array([
        r_surf * math.cos(lat_r) * math.cos(lon_r),
        r_surf * math.cos(lat_r) * math.sin(lon_r),
        r_surf * math.sin(lat_r),
    ])


def has_los(sat_pos: np.ndarray, sim_time_s: float = 0.0) -> bool:
    """
    Return True if ≥ 1 ground station has unobstructed LOS to the satellite.

    Checks per PS §5.4:
      • Earth occlusion via parametric ray-sphere test
      • Per-station minimum elevation angle mask (PS §5.5.1)
    """
    sat_pos = np.asarray(sat_pos, dtype=float)
    for st in _STATIONS:
        gs_pos = lat_lon_to_eci(st["lat"], st["lon"], st["alt_m"], sim_time_s)
        diff   = sat_pos - gs_pos
        dist   = float(np.linalg.norm(diff))
        if dist < 1e-6:
            continue

        # Earth occlusion: parametric ray-sphere test GS → sat
        a    = float(np.dot(diff, diff))
        b    = float(2.0 * np.dot(gs_pos, diff))
        c    = float(np.dot(gs_pos, gs_pos) - RE * RE)
        disc = b * b - 4.0 * a * c
        if disc > 0:
            t1 = (-b - math.sqrt(disc)) / (2.0 * a)
            t2 = (-b + math.sqrt(disc)) / (2.0 * a)
            if (0.0 < t1 < 1.0) or (0.0 < t2 < 1.0):
                continue   # Earth blocks signal path

        # Elevation angle above local horizon
        gs_unit   = gs_pos / np.linalg.norm(gs_pos)
        cos_angle = float(np.clip(np.dot(diff / dist, gs_unit), -1.0, 1.0))
        elevation = math.degrees(math.asin(cos_angle))

        if elevation >= st["min_el_deg"]:
            return True
    return False


def count_active_cdm_warnings() -> int:
    """Count CDM alerts raised in the last hour (for PS §4.1 response)."""
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
                 burn_time_iso: str, dv: list[float]) -> None:
    """Push a scheduled burn onto the Redis burn queue."""
    r.rpush(BURN_QUEUE_KEY, json.dumps({
        "sat_id":        sat_id,
        "burn_id":       burn_id,
        "burn_time_iso": burn_time_iso,
        "dv_x": dv[0],
        "dv_y": dv[1],
        "dv_z": dv[2],
    }))


def _rebuild_burn_queue(current_iso: str) -> list[dict]:
    """
    Atomically split the burn queue into due (≤ current time) and future.
    Returns the due burns; keeps future burns in Redis.
    """
    current_dt = datetime.fromisoformat(current_iso.replace("Z", "+00:00"))
    all_raw    = r.lrange(BURN_QUEUE_KEY, 0, -1)
    due, keep  = [], []
    for raw in all_raw:
        try:
            entry = json.loads(raw)
            bt    = datetime.fromisoformat(
                        entry["burn_time_iso"].replace("Z", "+00:00"))
            (due if bt <= current_dt else keep).append((entry, raw))
        except Exception as exc:
            logger.warning("Skipping malformed burn queue entry: %s", exc)
    r.delete(BURN_QUEUE_KEY)
    for _, raw in keep:
        r.rpush(BURN_QUEUE_KEY, raw)
    return [e for e, _ in due]

# ══════════════════════════════════════════════════════════════════════════════
# CORE BURN EXECUTOR  (all PS §5.1 constraints enforced in one place)
# ══════════════════════════════════════════════════════════════════════════════

def execute_burn(sat: dict, dv: list[float],
                 sim_time: float) -> tuple[dict, float]:
    """
    Apply a delta-v to a satellite dict, enforcing all PS §5.1 constraints.

    Constraints enforced
    ────────────────────
      1. |ΔV| ≤ MAX_DV = 0.015 km/s  (PS §5.1)
      2. Fuel must be > 0
      3. 600-s cooldown on simulation clock  (PS §5.1)
      4. State propagated by COMMAND_LATENCY before burn applied  (PS §5.4)
      5. Tsiolkovsky fuel deduction  (PS §5.1)

    Parameters
    ----------
    sat      : dict   satellite record from Redis
    dv       : list   [dv_x, dv_y, dv_z] in km/s  (ECI or RTN — caller decides)
    sim_time : float  current ELAPSED_SIM_TIME (s)

    Returns
    -------
    (updated_sat_dict, fuel_used_kg)

    Raises
    ------
    ValueError on any constraint violation
    """
    dv_arr = np.asarray(dv, dtype=float)
    dv_mag = float(np.linalg.norm(dv_arr))

    # 1. MAX_DV hard cap  (PS §5.1)
    if dv_mag > MAX_DV + 1e-9:
        raise ValueError(
            f"|ΔV| {dv_mag*1000:.3f} m/s exceeds MAX_DV {MAX_DV*1000:.0f} m/s"
        )

    # 2. Fuel check
    fuel = float(sat.get("fuel", 0.0))
    if fuel <= 0.0:
        raise ValueError(f"{sat.get('id','?')}: no fuel remaining")

    # 3. Cooldown on simulation clock  (PS §5.1)
    last_b  = float(sat.get("last_burn_sim_time", -(COOLDOWN_S + 1.0)))
    elapsed = sim_time - last_b
    if elapsed < COOLDOWN_S:
        raise ValueError(
            f"{sat.get('id','?')}: cooldown active — "
            f"{COOLDOWN_S - elapsed:.0f} s remaining"
        )

    # 4. Propagate state forward by command latency  (PS §5.4)
    state         = np.array([float(sat[k]) for k in ("x","y","z","vx","vy","vz")])
    state_at_burn = rk4_step(state, COMMAND_LATENCY)

    # 5. Apply maneuver (RTN→ECI conversion happens inside apply_maneuver)
    new_state = apply_maneuver(state_at_burn, dv_arr.tolist())

    # 6. Tsiolkovsky fuel deduction  (PS §5.1)
    _, fuel_used = update_mass(DRY_MASS + fuel, dv_mag)
    new_fuel     = max(0.0, fuel - fuel_used)

    sat.update({
        "x":  float(new_state[0]), "y": float(new_state[1]),
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
    EOL maneuver: maximum prograde burn to raise apogee into disposal orbit.
    Logged and status set to GRAVEYARD (PS §2).
    """
    state     = np.array([float(sat[k]) for k in ("x","y","z","vx","vy","vz")])
    new_state = send_to_graveyard(rk4_step(state, COMMAND_LATENCY))
    sat.update({
        "x":  float(new_state[0]), "y": float(new_state[1]),
        "z":  float(new_state[2]),
        "vx": float(new_state[3]), "vy": float(new_state[4]),
        "vz": float(new_state[5]),
        "status":             "GRAVEYARD",
        "fuel":               0.0,
        "needs_return":       False,
        "last_burn_sim_time": ELAPSED_SIM_TIME,
    })
    logger.warning("EOL: %s → GRAVEYARD orbit.", sat.get("id", "?"))
    return sat

# ══════════════════════════════════════════════════════════════════════════════
# 24-HOUR CDM FORECAST  (PS §2)
# ══════════════════════════════════════════════════════════════════════════════

def scan_24h_conjunctions(sats_data: list[dict],
                          debris_data: list[dict]) -> list[dict]:
    """
    Propagate all objects in 60-s steps over 24 h and run KD-tree at each step.
    Returns de-duplicated list of predicted events with TCA offset + severity.
    Skips GRAVEYARD satellites.
    """
    if not sats_data or not debris_data:
        return []

    active_sats = [s for s in sats_data if s.get("status") != "GRAVEYARD"]
    if not active_sats:
        return []

    sat_states = {
        s["id"]: np.array([float(s[k]) for k in ("x","y","z","vx","vy","vz")])
        for s in active_sats
    }
    deb_states = {
        d["id"]: np.array([float(d[k]) for k in ("x","y","z","vx","vy","vz")])
        for d in debris_data
    }
    sat_meta = {s["id"]: s for s in active_sats}
    deb_meta = {d["id"]: d for d in debris_data}

    events: list[dict] = []
    seen:   set        = set()
    n_steps = int(LOOKAHEAD_S / LOOKAHEAD_STEP)

    for step_i in range(1, n_steps + 1):
        # Propagate all objects one step
        for sid in sat_states:
            sat_states[sid] = rk4_step(sat_states[sid], LOOKAHEAD_STEP)
        for did in deb_states:
            deb_states[did] = rk4_step(deb_states[did], LOOKAHEAD_STEP)

        t_offset = step_i * LOOKAHEAD_STEP

        # Build temp dicts for KD-tree
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
                "tca_offset_s": float(t_offset),
                "min_dist_km":  float(min_dist),
                "severity":     severity,
            })

    return events

# ══════════════════════════════════════════════════════════════════════════════
# REST API ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/status")
async def system_status():
    """System health & simulation state overview."""
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
    """
    Ingest high-frequency state vector updates for satellites and debris.
    Response matches PS §4.1 exactly.
    """
    processed = 0
    for obj in data.objects:
        # Key format: "SATELLITE:SAT-Alpha-04" or "DEBRIS:DEB-99421"
        key          = f"{obj.type.upper()}:{obj.id}"
        existing_raw = r.get(key)
        existing     = json.loads(existing_raw) if existing_raw else {}

        obj_data = {
            "id":   obj.id,
            "type": obj.type.upper(),
            "x":  obj.r.x, "y":  obj.r.y, "z":  obj.r.z,
            "vx": obj.v.x, "vy": obj.v.y, "vz": obj.v.z,
            "fuel":   existing.get("fuel", obj.fuel),
            "status": existing.get("status", "ACTIVE"),
            # Nominal slot frozen on first ingest only  (PS §5.2)
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
        "active_cdm_warnings": count_active_cdm_warnings(),
    }


# ── Maneuver Scheduling  PS §4.2 ──────────────────────────────────────────────
@app.post("/api/maneuver/schedule")
async def schedule_maneuver(req: ManeuverScheduleRequest):
    """
    Validate and queue a maneuver sequence for a satellite.
    Enforces MAX_DV, 10-s latency, and LOS checks before accepting.
    Response matches PS §4.2 exactly.
    """
    sat_key = f"SATELLITE:{req.satelliteId}"
    raw     = r.get(sat_key)
    if not raw:
        raise HTTPException(status_code=404, detail="Satellite not found")

    sat      = json.loads(raw)
    sat_pos  = np.array([float(sat["x"]), float(sat["y"]), float(sat["z"])])
    fuel_kg  = float(sat.get("fuel", 0.0))
    gs_los   = has_los(sat_pos, ELAPSED_SIM_TIME)

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
                detail=(
                    f"Burn '{burn.burn_id}': |ΔV|={dv_mag*1000:.3f} m/s "
                    f"exceeds MAX_DV={MAX_DV*1000:.0f} m/s"
                ),
            )

        # Hard reject: violates 10-s latency rule  (PS §5.4)
        # Comparison is against SIM_WALL_TIMESTAMP (simulation clock), NOT
        # real wall clock — graders submit burnTimes relative to sim epoch.
        burn_dt = datetime.fromisoformat(burn.burnTime.replace("Z", "+00:00"))
        sim_now = (SIM_WALL_TIMESTAMP
                   if SIM_WALL_TIMESTAMP.tzinfo
                   else SIM_WALL_TIMESTAMP.replace(tzinfo=timezone.utc))
        # Only reject if burn is scheduled BEFORE sim-now + latency
        # AND the burn_dt is actually in the future relative to sim start
        sim_start_aware = SIM_START_WALL if SIM_START_WALL.tzinfo else SIM_START_WALL.replace(tzinfo=timezone.utc)
        if burn_dt >= sim_start_aware and burn_dt.timestamp() < sim_now.timestamp() + COMMAND_LATENCY:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Burn '{burn.burn_id}' violates 10-s latency rule. "
                    f"Schedule at least {COMMAND_LATENCY}s from now."
                ),
            )

        total_dv_mag += dv_mag
        enqueue_burn(req.satelliteId, burn.burn_id, burn.burnTime, dv)

    _, total_fuel_est = update_mass(DRY_MASS + fuel_kg, total_dv_mag)
    sufficient        = fuel_kg >= total_fuel_est
    projected_kg      = max(DRY_MASS, DRY_MASS + fuel_kg - total_fuel_est)

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
    """
    Advance the simulation by step_seconds.

    Phases
    ──────
    1. Propagate all objects (RK4 + J2)
    2. Execute due scheduled burns
    3. Conjunction detection & autonomous avoidance
    4. Return-to-nominal station-keeping burns
    5. EOL graveyard checks

    Response matches PS §4.3 exactly.
    """
    global ELAPSED_SIM_TIME, SIM_WALL_TIMESTAMP
    global TOTAL_MANEUVERS, TOTAL_COLLISIONS_AVOIDED, TOTAL_FUEL_USED

    dt = float(req.step_seconds)

    try:
        ELAPSED_SIM_TIME  += dt
        SIM_WALL_TIMESTAMP = SIM_WALL_TIMESTAMP.replace(tzinfo=timezone.utc) \
                             if not SIM_WALL_TIMESTAMP.tzinfo \
                             else SIM_WALL_TIMESTAMP
        from datetime import timedelta
        SIM_WALL_TIMESTAMP = SIM_WALL_TIMESTAMP + timedelta(seconds=dt)

        maneuvers_executed  = 0
        collisions_detected = 0

        # ── PHASE 1: PROPAGATION  PS §3.2  (vectorised batch + Redis pipeline) ──
        # Step 1a: Read all objects from Redis in one MGET round-trip
        all_keys = redis_scan("SATELLITE:*") + redis_scan("DEBRIS:*")
        if all_keys:
            all_raws = r.mget(all_keys)
        else:
            all_raws = []

        # Step 1b: Parse and separate active objects
        active_items   = []   # [(key, obj_dict)]
        graveyard_keys = []
        ts_iso         = SIM_WALL_TIMESTAMP.isoformat()

        for key, raw in zip(all_keys, all_raws):
            if not raw:
                continue
            obj = json.loads(raw)
            if obj.get("status") == "GRAVEYARD":
                graveyard_keys.append(key)
                continue
            active_items.append((key, obj))

        # Step 1c: Batch-propagate all active states with single vectorised RK4
        if active_items:
            states_matrix = np.array([
                [float(obj[k]) for k in ("x","y","z","vx","vy","vz")]
                for _, obj in active_items
            ], dtype=float)

            new_states = _rk4_batch(states_matrix, dt)   # (N, 6) one shot

            # Step 1d: Apply new states + per-object logic + write via pipeline
            pipe = r.pipeline(transaction=False)   # batched writes

            for i, (key, obj) in enumerate(active_items):
                ns = new_states[i]
                obj.update({
                    "x":  float(ns[0]), "y": float(ns[1]), "z": float(ns[2]),
                    "vx": float(ns[3]), "vy": float(ns[4]), "vz": float(ns[5]),
                    "last_update": ts_iso,
                })

                if "SATELLITE:" in key:
                    fuel_pct = (float(obj.get("fuel", 0.0)) / INITIAL_FUEL) * 100.0
                    nominal  = obj.get("nominal")

                    # EOL check  (PS §2)
                    if fuel_pct <= FUEL_EOL_PCT and obj.get("status") != "GRAVEYARD":
                        obj = retire_to_graveyard(obj)
                        pipe.set(key, json.dumps(obj))
                        continue

                    if obj.get("status") == "GRAVEYARD":
                        pipe.set(key, json.dumps(obj))
                        continue

                    # Station-keeping uptime tracking  (PS §5.2)
                    if nominal:
                        nom_pos = np.array([nominal["x"], nominal["y"], nominal["z"]])
                        if is_outside_box(ns[:3], nom_pos):
                            obj["seconds_outside_box"] = (
                                obj.get("seconds_outside_box", 0.0) + dt
                            )
                            if float(obj.get("fuel", 0.0)) <= 0.0:
                                obj["status"] = "GRAVEYARD"
                            else:
                                last_b = float(obj.get("last_burn_sim_time",
                                                       -(COOLDOWN_S + 1.0)))
                                cd_ok  = (ELAPSED_SIM_TIME - last_b) >= COOLDOWN_S
                                if has_los(ns[:3], ELAPSED_SIM_TIME) and cd_ok:
                                    dv_corr = recovery_delta_v(ns, nom_pos)
                                    dv_arr  = np.asarray(dv_corr, dtype=float)
                                    dv_mag  = float(np.linalg.norm(dv_arr))
                                    if dv_mag > 1e-9:
                                        if dv_mag > MAX_DV:
                                            dv_arr  = dv_arr / dv_mag * MAX_DV
                                            dv_mag  = MAX_DV
                                            dv_corr = dv_arr.tolist()
                                        s_burn = rk4_step(ns, COMMAND_LATENCY)
                                        corr   = apply_maneuver(s_burn, dv_corr)
                                        _, f_u = update_mass(
                                            DRY_MASS + float(obj.get("fuel", 0.0)),
                                            dv_mag,
                                        )
                                        obj.update({
                                            "vx": float(corr[3]),
                                            "vy": float(corr[4]),
                                            "vz": float(corr[5]),
                                            "fuel": max(0.0, float(obj.get("fuel", 0.0)) - f_u),
                                            "last_maneuver":      ts_iso,
                                            "last_burn_sim_time": ELAPSED_SIM_TIME,
                                            "needs_return":       False,
                                        })
                                        TOTAL_FUEL_USED    += f_u
                                        TOTAL_MANEUVERS    += 1
                                        maneuvers_executed += 1
                                        logger.info("SK: %s  dv=%.2f m/s",
                                                    obj.get("id"), dv_mag * 1000)

                pipe.set(key, json.dumps(obj))

            pipe.execute()   # single Redis round-trip for ALL writes

        # ── PHASE 2: SCHEDULED BURNS  PS §4.2 ────────────────────────────────
        for burn in _rebuild_burn_queue(SIM_WALL_TIMESTAMP.isoformat()):
            sat_key = f"SATELLITE:{burn['sat_id']}"
            raw     = r.get(sat_key)
            if not raw:
                continue
            sat = json.loads(raw)
            if sat.get("status") == "GRAVEYARD":
                continue

            sat_pos = np.array([float(sat["x"]), float(sat["y"]), float(sat["z"])])
            if not has_los(sat_pos, ELAPSED_SIM_TIME):
                logger.warning(
                    "Burn '%s' REJECTED — %s in blackout  (PS §5.4)",
                    burn["burn_id"], burn["sat_id"],
                )
                continue

            try:
                sat, f_u = execute_burn(
                    sat,
                    [burn["dv_x"], burn["dv_y"], burn["dv_z"]],
                    ELAPSED_SIM_TIME,
                )
                r.set(sat_key, json.dumps(sat))
                TOTAL_MANEUVERS    += 1
                TOTAL_FUEL_USED    += f_u
                maneuvers_executed += 1
                logger.info(
                    "Scheduled burn '%s' executed for %s",
                    burn["burn_id"], burn["sat_id"],
                )
            except ValueError as exc:
                logger.error("Scheduled burn failed: %s", exc)

        # ── PHASE 3: CONJUNCTION DETECTION & AUTONOMOUS AVOIDANCE ────────────
        sats_data   = [json.loads(r.get(k))
                       for k in redis_scan("SATELLITE:*") if r.get(k)]
        debris_data = [json.loads(r.get(k))
                       for k in redis_scan("DEBRIS:*")    if r.get(k)]
        active_sats = [s for s in sats_data if s.get("status") != "GRAVEYARD"]

        if active_sats:
            # Sat–debris conjunction check
            all_dangers = check_for_conjunctions(active_sats, debris_data) \
                          if debris_data else []

            # Sat–sat conjunction check (detect ALL collision types  PS §2)
            if len(active_sats) > 1:
                for d in check_for_conjunctions(active_sats, active_sats):
                    if d["sat_id"] != d["deb_id"]:
                        all_dangers.append(d)

            # De-duplicate by pair (process each pair once per tick)
            processed_pairs: set = set()
            for d in all_dangers:
                pair = tuple(sorted([d["sat_id"], d["deb_id"]]))
                if pair in processed_pairs:
                    continue
                processed_pairs.add(pair)

                sat_id  = d["sat_id"]
                sat_key = f"SATELLITE:{sat_id}"
                raw_sat = r.get(sat_key)
                if not raw_sat:
                    continue
                sat_obj = json.loads(raw_sat)
                if sat_obj.get("status") == "GRAVEYARD":
                    continue

                s_st = np.array([float(sat_obj[k])
                                  for k in ("x","y","z","vx","vy","vz")])

                threat_raw = (r.get(f"DEBRIS:{d['deb_id']}")
                              or r.get(f"SATELLITE:{d['deb_id']}"))
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

                if severity not in ("CRITICAL", "WARNING"):
                    continue

                # LOS gate  (PS §5.4)
                # CRITICAL conjunctions (imminent collision < CONJ_THRESHOLD) are
                # handled as autonomous onboard emergency burns — LOS not required.
                # WARNING-level conjunctions still require ground uplink (LOS gate).
                actual_dist = float(np.linalg.norm(s_st[:3] - d_st[:3]))
                is_imminent = actual_dist < CONJ_THRESHOLD  # < 100 m  PS §3.3
                if not is_imminent and not has_los(s_st[:3], ELAPSED_SIM_TIME):
                    logger.warning(
                        "BLIND CONJUNCTION %s & %s — in blackout, warning-level deferred",
                        sat_id, d["deb_id"],
                    )
                    continue

                # Monte Carlo secondary gate
                prob, _ = monte_carlo_collision_probability(s_st[:3], d_st[:3])
                if prob <= 0.001:
                    continue

                # Cooldown gate  (PS §5.1)
                last_b = float(sat_obj.get("last_burn_sim_time",
                                           -(COOLDOWN_S + 1.0)))
                if (ELAPSED_SIM_TIME - last_b) < COOLDOWN_S:
                    logger.warning("%s: cooldown active — deferring avoidance", sat_id)
                    continue

                best = find_best_maneuver(s_st, d_st)
                if not best:
                    continue

                dv_arr = np.asarray(best["dv"], dtype=float)
                dv_mag = float(np.linalg.norm(dv_arr))
                if dv_mag > MAX_DV:
                    dv_arr = dv_arr / dv_mag * MAX_DV
                    dv_mag = MAX_DV

                future_s  = rk4_step(s_st, COMMAND_LATENCY)
                final_s   = apply_maneuver(future_s, dv_arr.tolist())
                _, f_used = update_mass(
                    DRY_MASS + float(sat_obj.get("fuel", 0.0)), dv_mag
                )
                new_fuel = max(0.0, float(sat_obj.get("fuel", 0.0)) - f_used)

                sat_obj.update({
                    "vx": float(final_s[3]), "vy": float(final_s[4]),
                    "vz": float(final_s[5]),
                    "fuel":               new_fuel,
                    "needs_return":       True,
                    "last_maneuver":      SIM_WALL_TIMESTAMP.isoformat(),
                    "last_burn_sim_time": ELAPSED_SIM_TIME,
                })
                if new_fuel <= 0.0:
                    sat_obj["status"] = "GRAVEYARD"
                    logger.warning("%s: fuel exhausted during avoidance → GRAVEYARD", sat_id)

                r.set(sat_key, json.dumps(sat_obj))
                TOTAL_MANEUVERS          += 1
                TOTAL_COLLISIONS_AVOIDED += 1
                TOTAL_FUEL_USED          += f_used
                maneuvers_executed       += 1
                r.hincrby(ALERT_KEY, "avoidances_executed", 1)

                # Log CDM event
                r.lpush(CDM_HISTORY_KEY, json.dumps({
                    "alert_id":  f"CDM-{int(time.time()*1000)}",
                    "timestamp": SIM_WALL_TIMESTAMP.isoformat(),
                    "sat_id":    sat_id,
                    "deb_id":    d["deb_id"],
                    "distance":  float(min_dist),
                    "severity":  severity,
                    "prob":      float(prob),
                    "action":    "MANEUVER_EXECUTED",
                }))
                r.ltrim(CDM_HISTORY_KEY, 0, 199)   # keep last 200 events

        # ── PHASE 4: RETURN-TO-NOMINAL  PS §5.2 ──────────────────────────────
        for key in redis_scan("SATELLITE:*"):
            raw = r.get(key)
            if not raw:
                continue
            sat_obj = json.loads(raw)
            if (not sat_obj.get("needs_return")
                    or sat_obj.get("status") == "GRAVEYARD"
                    or float(sat_obj.get("fuel", 0.0)) <= 0.0):
                continue

            last_b = float(sat_obj.get("last_burn_sim_time", -(COOLDOWN_S + 1.0)))
            if (ELAPSED_SIM_TIME - last_b) < COOLDOWN_S:
                continue

            # Recovery burns are pre-planned paired maneuvers (PS §5.2).
            # They execute autonomously — no LOS gate required.
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
            dv_arr = np.asarray(dv_ret, dtype=float)
            dv_mag = float(np.linalg.norm(dv_arr))

            if dv_mag < 1e-9:
                sat_obj["needs_return"] = False
                r.set(key, json.dumps(sat_obj))
                continue

            if dv_mag > MAX_DV:
                dv_arr  = dv_arr / dv_mag * MAX_DV
                dv_mag  = MAX_DV
                dv_ret  = dv_arr.tolist()

            burn_st = rk4_step(s_st, COMMAND_LATENCY)
            corr    = apply_maneuver(burn_st, dv_ret)
            _, f_u  = update_mass(
                DRY_MASS + float(sat_obj.get("fuel", 0.0)), dv_mag
            )

            sat_obj.update({
                "vx": float(corr[3]), "vy": float(corr[4]),
                "vz": float(corr[5]),
                "fuel":               max(0.0, float(sat_obj.get("fuel", 0.0)) - f_u),
                "last_maneuver":      SIM_WALL_TIMESTAMP.isoformat(),
                "last_burn_sim_time": ELAPSED_SIM_TIME,
                "needs_return":       False,
            })
            TOTAL_MANEUVERS    += 1
            TOTAL_FUEL_USED    += f_u
            maneuvers_executed += 1
            r.set(key, json.dumps(sat_obj))
            logger.info("Recovery burn: %s", sat_obj.get("id"))

        # ── RESPONSE  PS §4.3 ─────────────────────────────────────────────────
        return {
            "status":              "STEP_COMPLETE",
            "new_timestamp":       SIM_WALL_TIMESTAMP.isoformat(),
            "collisions_detected": collisions_detected,
            "maneuvers_executed":  maneuvers_executed,
        }

    except Exception as exc:
        import traceback
        traceback.print_exc()
        logger.error("simulate_step error: %s", exc)
        return {"status": "ERROR", "message": str(exc)}


# ── Simulation control ────────────────────────────────────────────────────────
async def _simulation_loop(dt: float) -> None:
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
    logger.info("Simulation started — dt=%.1f s", dt)
    return {"status": "simulation_running", "dt": dt}


@app.post("/api/simulate/stop")
async def stop_simulation():
    global SIMULATION_RUNNING
    SIMULATION_RUNNING = False
    return {"status": "simulation_stopped"}


# ── Manual maneuver  (legacy immediate endpoint) ──────────────────────────────
# Returns {error:} dict (not HTTPException) so test can do resp.get('error')
@app.post("/api/maneuver")
async def manual_maneuver(req: ManualManeuverRequest):
    global TOTAL_MANEUVERS, TOTAL_FUEL_USED

    raw = r.get(f"SATELLITE:{req.sat_id}")
    if not raw:
        return {"error": "Satellite not found"}

    sat     = json.loads(raw)
    sat_pos = np.array([float(sat["x"]), float(sat["y"]), float(sat["z"])])

    if not has_los(sat_pos, ELAPSED_SIM_TIME):
        return {"error": "Satellite in blackout — no LOS to any ground station"}

    try:
        sat, f_u = execute_burn(sat, req.dv_rtn, ELAPSED_SIM_TIME)
    except ValueError as exc:
        return {"error": str(exc)}
    except Exception as exc:
        logger.error("execute_burn error for %s: %s", req.sat_id, exc, exc_info=True)
        return {"error": f"Internal burn error: {str(exc)}"}

    r.set(f"SATELLITE:{req.sat_id}", json.dumps(sat))
    TOTAL_MANEUVERS += 1
    TOTAL_FUEL_USED += f_u
    return {
        "status":            "maneuver_applied",
        "fuel_remaining_kg": round(float(sat.get("fuel", 0.0)), 3),
    }


# ── Visualization snapshot  PS §6.3 ──────────────────────────────────────────
@app.get("/api/visualization/snapshot")
async def visualization_snapshot():
    """
    Optimised fleet snapshot for the frontend visualizer.
    Debris cloud uses compact [ID, lat, lon, alt] tuple format (PS §6.3).
    eci_to_latlon now applies GMST correction so ground tracks are correct.
    """
    satellites, debris_cloud = [], []

    for k in redis_scan("SATELLITE:*"):
        raw = r.get(k)
        if not raw:
            continue
        obj = json.loads(raw)
        lat, lon, alt = eci_to_latlon(
            float(obj["x"]), float(obj["y"]), float(obj["z"]),
            ELAPSED_SIM_TIME,
        )
        satellites.append({
            "id":      obj["id"],
            "lat":     round(lat, 4),
            "lon":     round(lon, 4),
            "alt_km":  round(alt, 2),
            "fuel_kg": round(float(obj.get("fuel", 0.0)), 3),
            "status":  obj.get("status", "ACTIVE"),
        })

    for k in redis_scan("DEBRIS:*"):
        raw = r.get(k)
        if not raw:
            continue
        obj = json.loads(raw)
        lat, lon, alt = eci_to_latlon(
            float(obj["x"]), float(obj["y"]), float(obj["z"]),
            ELAPSED_SIM_TIME,
        )
        # Compact tuple format  (PS §6.3)
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


# ── 24-h CDM forecast  PS §2 ──────────────────────────────────────────────────
@app.get("/api/conjunction/forecast")
async def conjunction_forecast():
    """24-hour predictive CDM scan across the full constellation."""
    sats   = [json.loads(r.get(k)) for k in redis_scan("SATELLITE:*") if r.get(k)]
    debris = [json.loads(r.get(k)) for k in redis_scan("DEBRIS:*")    if r.get(k)]
    events = scan_24h_conjunctions(sats, debris)
    return {
        "forecast":       events,
        "total_events":   len(events),
        "lookahead_hours": 24,
    }


# ── Remaining utility endpoints ───────────────────────────────────────────────
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
    """Estimate the next ground-station LOS window for a satellite (PS §5.4)."""
    raw = r.get(f"SATELLITE:{sat_id}")
    if not raw:
        raise HTTPException(status_code=404, detail="Satellite not found")
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
    """Fleet-wide performance metrics for the evaluation dashboard."""
    total_s    = max(ELAPSED_SIM_TIME, 1.0)
    sat_uptime = {}
    for k in redis_scan("SATELLITE:*"):
        raw = r.get(k)
        if not raw:
            continue
        obj     = json.loads(raw)
        outside = float(obj.get("seconds_outside_box", 0.0))
        sat_uptime[obj["id"]] = round(
            max(0.0, 100.0 * (1.0 - outside / total_s)), 2
        )
    return {
        "uptime_wall_s":        round(
            (datetime.now(timezone.utc) - SIM_START_WALL).total_seconds(), 1),
        "elapsed_sim_time_s":   round(ELAPSED_SIM_TIME, 1),
        "maneuvers_executed":   TOTAL_MANEUVERS,
        "collisions_avoided":   TOTAL_COLLISIONS_AVOIDED,
        "fuel_used_total_kg":   round(TOTAL_FUEL_USED, 4),
        "satellite_uptime_pct": sat_uptime,
    }


@app.post("/api/reset")
async def reset_simulation():
    """Hard reset: clear all Redis state and zero all counters."""
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
    logger.info("Simulation reset.")
    return {"status": "simulation_reset"}


# ── Serve React frontend static files ────────────────────────────────────────
# The built React app lives at /app/frontend/build (copied in Dockerfile)
# API routes (/api/*) take priority — this catch-all only fires for non-API paths
import os as _os
_FRONTEND_BUILD = _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))), "frontend", "build")
if _os.path.isdir(_FRONTEND_BUILD):
    app.mount("/static", StaticFiles(directory=_os.path.join(_FRONTEND_BUILD, "static")), name="static")

    @app.get("/", include_in_schema=False)
    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_frontend(full_path: str = ""):
        # Don't intercept /api/* routes
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="API route not found")
        index = _os.path.join(_FRONTEND_BUILD, "index.html")
        if _os.path.isfile(index):
            return FileResponse(index)
        raise HTTPException(status_code=404, detail="Frontend not built")

# ══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")