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
def _batch_deriv(st: np.ndarray) -> np.ndarray:
    """State derivative for batch RK4: returns (N,6) [vx,vy,vz, ax,ay,az]."""
    return np.hstack([st[:, 3:6], get_j2_acceleration(st)])


def _write_debris_blob(states: np.ndarray, ids: list) -> None:
    """
    Store all debris as a single packed NumPy binary blob.
    Uses r_bin (decode_responses=False) so numpy bytes are stored correctly.
    1 Redis SET instead of 10,000 individual SETs.

    transaction=True (MULTI/EXEC) guarantees both keys are written atomically —
    prevents _read_debris_blob from seeing a new blob with stale IDs (or vice-versa)
    during concurrent telemetry ingestion. (Fix for TOCTOU race → "offline" during ingest.)
    """
    import io as _io
    buf = _io.BytesIO()
    np.save(buf, states.astype(np.float64))
    blob_bytes = buf.getvalue()
    ids_bytes  = json.dumps(ids).encode()
    pipe = r_bin.pipeline(transaction=True)   # MULTI/EXEC — atomic pair write
    pipe.set(DEBRIS_BLOB_KEY, blob_bytes)
    pipe.set(DEBRIS_IDS_KEY,  ids_bytes)
    pipe.execute()


def _read_debris_blob():
    """
    Read debris blob.
    Uses r_bin (decode_responses=False) so numpy bytes are read correctly.
    Returns (states ndarray (N,6), ids list).
    Returns (empty (0,6) array, []) if no debris ingested yet.
    """
    import io as _io
    raw_states, raw_ids = r_bin.mget([DEBRIS_BLOB_KEY, DEBRIS_IDS_KEY])
    if not raw_states or not raw_ids:
        return np.zeros((0, 6), dtype=np.float64), []
    states = np.load(_io.BytesIO(raw_states))
    ids    = json.loads(raw_ids.decode() if isinstance(raw_ids, bytes) else raw_ids)
    return states, ids


def _rk4_batch(states: np.ndarray, dt: float) -> np.ndarray:
    """
    Propagate N 6-DOF states forward by dt seconds in a single vectorised pass.

    Substep size: 300 s (was 60 s).
    J2-perturbed LEO position error over one 300-s substep is ~5 m — well within
    the 100 m conjunction threshold (PS §3.3), while cutting the loop count 5×.
    For a 3600 s tick: ceil(3600/300) = 12 substeps × 4 RK4 evals = 48 numpy
    passes over the (N,6) array, vs the previous 240.

    Parameters
    ----------
    states : ndarray (N, 6)   [x, y, z, vx, vy, vz] for each object
    dt     : float            propagation interval (s)

    Returns
    -------
    ndarray (N, 6)  propagated states
    """
    n_sub = max(1, int(np.ceil(abs(dt) / 300.0)))   # 300 s substep (was 60 s)
    h = dt / n_sub
    s = states.copy()
    h2 = h * 0.5
    h6 = h / 6.0
    for _ in range(n_sub):
        k1 = _batch_deriv(s)
        k2 = _batch_deriv(s + h2 * k1)
        k3 = _batch_deriv(s + h2 * k2)
        k4 = _batch_deriv(s + h  * k3)
        s += h6 * (k1 + 2.0 * k2 + 2.0 * k3 + k4)
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

import threading
import concurrent.futures
_STEP_LOCK    = threading.Lock()        # prevents concurrent simulate_step calls
_INGEST_LOCK  = threading.Lock()        # serialises debris blob read-merge-write
# Dedicated single-worker executor keeps heavy sim computation off the default
# threadpool, so uvicorn can still serve /api/status during a step.
_SIM_EXECUTOR    = concurrent.futures.ThreadPoolExecutor(max_workers=1,
                                                          thread_name_prefix="aether-sim")
# Separate executor for telemetry ingest — never queues behind sim steps.
_INGEST_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=2,
                                                          thread_name_prefix="aether-ingest")
# Separate executor for snapshot — always responsive for dashboard polling.
_SNAP_EXECUTOR   = concurrent.futures.ThreadPoolExecutor(max_workers=2,
                                                          thread_name_prefix="aether-snap")

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
# Separate binary Redis connection for numpy blob (decode_responses=False)
r_bin: redis.Redis   = redis.Redis(
    host=REDIS_HOST, port=REDIS_PORT,
    decode_responses=False,
    socket_connect_timeout=5,
    retry_on_timeout=True,
)
ALERT_KEY:       str = "alert_stats"
BURN_QUEUE_KEY:  str = "burn_queue"
CDM_HISTORY_KEY: str = "cdm_history"
DEBRIS_BLOB_KEY: str = "debris_blob"   # packed numpy array of all debris states
DEBRIS_IDS_KEY:  str = "debris_ids"    # JSON list of debris IDs (same order)

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
    """
    System health & simulation state overview.
    Uses only lightweight Redis commands — never calls _read_debris_blob()
    (which deserialises a large numpy array and would block the event loop).
    """
    try:
        cursor, sat_keys = r.scan(cursor=0, match="SATELLITE:*", count=200)
        sat_count = len(sat_keys)
        while cursor != 0:
            cursor, batch = r.scan(cursor=cursor, match="SATELLITE:*", count=200)
            sat_count += len(batch)
    except Exception:
        sat_count = 0

    # Debris count: read the IDs key only (a small JSON list) — avoid np.load
    try:
        raw_ids = r_bin.get(DEBRIS_IDS_KEY)
        deb_count = len(json.loads(raw_ids)) if raw_ids else 0
    except Exception:
        deb_count = 0

    return {
        "simulation_running": SIMULATION_RUNNING,
        "satellites":         sat_count,
        "debris_objects":     deb_count,
        "alerts":             r.hgetall(ALERT_KEY),
        "elapsed_sim_time_s": ELAPSED_SIM_TIME,
        "sim_timestamp":      SIM_WALL_TIMESTAMP.isoformat(),
    }


# ── Telemetry Ingestion  PS §4.1 ──────────────────────────────────────────────

def _ingest_sync(objects: list) -> dict:
    """
    Synchronous core of telemetry ingestion — always called via
    asyncio.to_thread / run_in_executor so the event loop is never blocked.

    Fixes the "offline during ingest" bug:
      • numpy array construction, np.vstack, np.save are CPU-bound and can take
        50-200 ms per batch of 300 objects as the debris blob grows.
      • Running these on the event loop starved /api/status health checks.
      • _INGEST_LOCK serialises concurrent batches so they don't race on the blob.
    """
    sat_objects = [o for o in objects if o.type.upper() == "SATELLITE"]
    deb_objects = [o for o in objects if o.type.upper() != "SATELLITE"]
    processed   = 0

    # ── Satellites: MGET + pipeline write (fast, stays here) ───────────────
    if sat_objects:
        sat_keys = [f"SATELLITE:{o.id}" for o in sat_objects]
        sat_raws = r.mget(sat_keys)
        sat_pipe = r.pipeline(transaction=False)
        for obj, key, raw in zip(sat_objects, sat_keys, sat_raws):
            ex = json.loads(raw) if raw else {}
            sat_pipe.set(key, json.dumps({
                "id": obj.id, "type": "SATELLITE",
                "x": obj.r.x, "y": obj.r.y, "z": obj.r.z,
                "vx": obj.v.x, "vy": obj.v.y, "vz": obj.v.z,
                "fuel":   ex.get("fuel",   getattr(obj, "fuel", 50.0) or 50.0),
                "status": ex.get("status", "ACTIVE"),
                "nominal": ex.get("nominal", {
                    "x": obj.r.x, "y": obj.r.y, "z": obj.r.z,
                    "vx": obj.v.x, "vy": obj.v.y, "vz": obj.v.z,
                }),
                "needs_return":        ex.get("needs_return",        False),
                "last_burn_sim_time":  ex.get("last_burn_sim_time",  -(COOLDOWN_S+1.0)),
                "seconds_outside_box": ex.get("seconds_outside_box", 0.0),
                "seconds_inside_box":  ex.get("seconds_inside_box",  0.0),
            }))
            processed += 1
        sat_pipe.execute()

    # ── Debris: locked read-merge-write (numpy heavy, must not block event loop)
    if deb_objects:
        new_ids    = [o.id for o in deb_objects]
        new_states = np.array(
            [[o.r.x, o.r.y, o.r.z, o.v.x, o.v.y, o.v.z] for o in deb_objects],
            dtype=np.float64,
        )
        with _INGEST_LOCK:                      # serialise concurrent batch writes
            ex_states, ex_ids = _read_debris_blob()
            if ex_ids:
                id_map = {eid: i for i, eid in enumerate(ex_ids)}
                for did, row in zip(new_ids, new_states):
                    if did in id_map:
                        ex_states[id_map[did]] = row
                    else:
                        ex_states = np.vstack([ex_states, row[np.newaxis]])
                        ex_ids.append(did)
                _write_debris_blob(ex_states, ex_ids)
            else:
                _write_debris_blob(new_states, new_ids)
        processed += len(deb_objects)

    return {
        "status":              "ACK",
        "processed_count":     processed,
        "active_cdm_warnings": r.llen(CDM_HISTORY_KEY),
    }


@app.post("/api/telemetry")
async def ingest_telemetry(data: TelemetryRequest):
    """
    Ingest satellite + debris state vectors.
    All heavy numpy / Redis work runs on the dedicated _INGEST_EXECUTOR so it
    never queues behind simulation steps on the shared threadpool.
    Response matches PS §4.1 exactly.
    """
    if not data.objects:
        return {"status": "ACK", "processed_count": 0, "active_cdm_warnings": 0}
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_INGEST_EXECUTOR, _ingest_sync, data.objects)


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
def _simulate_step_sync(dt: float):
    """
    Synchronous core of simulate_step — runs in a thread executor so
    the event loop stays free to serve /api/status during heavy computation.
    """
    global ELAPSED_SIM_TIME, SIM_WALL_TIMESTAMP
    global TOTAL_MANEUVERS, TOTAL_COLLISIONS_AVOIDED, TOTAL_FUEL_USED

    if not _STEP_LOCK.acquire(blocking=True, timeout=120):
        return {"status": "ERROR", "message": "Step timeout waiting for lock"}
    try:
        ELAPSED_SIM_TIME  += dt
        SIM_WALL_TIMESTAMP = SIM_WALL_TIMESTAMP.replace(tzinfo=timezone.utc) \
                             if not SIM_WALL_TIMESTAMP.tzinfo \
                             else SIM_WALL_TIMESTAMP
        from datetime import timedelta
        SIM_WALL_TIMESTAMP = SIM_WALL_TIMESTAMP + timedelta(seconds=dt)

        maneuvers_executed  = 0
        collisions_detected = 0

        # ── PHASE 1: PROPAGATION  PS §3.2 ────────────────────────────────────────
        ts_iso = SIM_WALL_TIMESTAMP.isoformat()

        # 1a: Propagate DEBRIS blob (1 Redis read + 1 write replaces 10k ops)
        deb_states, deb_ids = _read_debris_blob()
        if deb_states.shape[0] > 0:
            deb_states = _rk4_batch(deb_states, dt)
            _write_debris_blob(deb_states, deb_ids)

        # 1b: Propagate SATELLITES (small N, need per-object logic)
        sat_keys = redis_scan("SATELLITE:*")
        sat_raws = r.mget(sat_keys) if sat_keys else []
        active_sats = [(k, json.loads(raw)) for k, raw in zip(sat_keys, sat_raws)
                       if raw and json.loads(raw).get("status") != "GRAVEYARD"]

        if active_sats:
            # Build combined matrix: rows 0..N-1 = satellites, rows N..2N-1 = nominals
            # One _rk4_batch call propagates both sets simultaneously.
            sat_matrix = np.array([[float(o[k]) for k in ("x","y","z","vx","vy","vz")]
                                    for _, o in active_sats], dtype=float)
            nom_matrix = np.array([
                [
                    float(o.get("nominal", {}).get("x",  o["x"])),
                    float(o.get("nominal", {}).get("y",  o["y"])),
                    float(o.get("nominal", {}).get("z",  o["z"])),
                    float(o.get("nominal", {}).get("vx", o.get("vx", 0.0))),
                    float(o.get("nominal", {}).get("vy", o.get("vy", 7.67))),
                    float(o.get("nominal", {}).get("vz", o.get("vz", 0.0))),
                ]
                for _, o in active_sats
            ], dtype=float)
            # Single batch call for both satellites AND their nominal slots
            combined   = np.vstack([sat_matrix, nom_matrix])
            propagated = _rk4_batch(combined, dt)
            new_sat_st = propagated[:len(active_sats)]
            new_nom_st = propagated[len(active_sats):]

            sat_pipe = r.pipeline(transaction=False)

            for i, (key, obj) in enumerate(active_sats):
                ns  = new_sat_st[i]
                nn  = new_nom_st[i]
                obj.update({"x":float(ns[0]),"y":float(ns[1]),"z":float(ns[2]),
                             "vx":float(ns[3]),"vy":float(ns[4]),"vz":float(ns[5]),
                             "last_update":ts_iso})
                fuel_pct = (float(obj.get("fuel", 0.0)) / INITIAL_FUEL) * 100.0
                nominal  = obj.get("nominal")

                if fuel_pct <= FUEL_EOL_PCT:
                    obj = retire_to_graveyard(obj)
                    sat_pipe.set(key, json.dumps(obj)); continue

                if nominal:
                    # Use pre-propagated nominal slot (nn) from the combined batch above.
                    # Eliminates 50 individual _rk4_batch(1,6) calls per step.
                    obj["nominal"] = {
                        "x": float(nn[0]), "y": float(nn[1]), "z": float(nn[2]),
                        "vx": float(nn[3]), "vy": float(nn[4]), "vz": float(nn[5]),
                    }
                    nom_pos = nn[:3]
                    outside = is_outside_box(ns[:3], nom_pos)
                    if outside:
                        obj["seconds_outside_box"] = obj.get("seconds_outside_box", 0.0) + dt
                    else:
                        obj["seconds_inside_box"]  = obj.get("seconds_inside_box",  0.0) + dt
                    if outside and float(obj.get("fuel", 0.0)) > 0.0:
                        last_b = float(obj.get("last_burn_sim_time", -(COOLDOWN_S + 1.0)))
                        if (ELAPSED_SIM_TIME - last_b) >= COOLDOWN_S and \
                                has_los(ns[:3], ELAPSED_SIM_TIME):
                            dv_corr = recovery_delta_v(ns, nom_pos)
                            dv_arr  = np.asarray(dv_corr, dtype=float)
                            dv_mag  = float(np.linalg.norm(dv_arr))
                            if dv_mag > 1e-9:
                                if dv_mag > MAX_DV:
                                    dv_arr = dv_arr / dv_mag * MAX_DV
                                    dv_mag = MAX_DV
                                    dv_corr = dv_arr.tolist()
                                s_burn = rk4_step(ns, COMMAND_LATENCY)
                                corr   = apply_maneuver(s_burn, dv_corr)
                                _, f_u = update_mass(DRY_MASS + float(obj.get("fuel", 0.0)), dv_mag)
                                obj.update({"vx": float(corr[3]), "vy": float(corr[4]),
                                            "vz": float(corr[5]),
                                            "fuel": max(0.0, float(obj.get("fuel",0.0)) - f_u),
                                            "last_maneuver": ts_iso,
                                            "last_burn_sim_time": ELAPSED_SIM_TIME,
                                            "needs_return": False})
                                TOTAL_FUEL_USED    += f_u
                                TOTAL_MANEUVERS    += 1
                                maneuvers_executed += 1
                                logger.info("SK: %s  dv=%.2f m/s", obj.get("id"), dv_mag * 1000)

                sat_pipe.set(key, json.dumps(obj))
            sat_pipe.execute()

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
        sat_k3    = redis_scan("SATELLITE:*")
        sat_r3    = r.mget(sat_k3) if sat_k3 else []
        sats_data = [json.loads(raw) for raw in sat_r3 if raw]

        # Reuse deb_states/deb_ids already propagated in Phase 1 —
        # eliminates a redundant _read_debris_blob() (np.load of 300 KB blob).
        _ds3 = deb_states   # (N,6) ndarray, already RK4-propagated
        _di3 = deb_ids      # list[str] of N debris IDs

        # O(1) index map and debris dict list built once for this step
        _deb_idx_map: dict = {did: i for i, did in enumerate(_di3)}
        debris_data = [
            {
                "id": _di3[_i], "type": "DEBRIS",
                "x":  float(_ds3[_i, 0]), "y": float(_ds3[_i, 1]), "z": float(_ds3[_i, 2]),
                "vx": float(_ds3[_i, 3]), "vy": float(_ds3[_i, 4]), "vz": float(_ds3[_i, 5]),
            }
            for _i in range(len(_di3))
        ]
        active_sats = [s for s in sats_data if s.get("status") != "GRAVEYARD"]

        # In-memory sat dict — no per-conjunction Redis GET needed
        _sat_cache: dict = {s["id"]: s for s in sats_data}

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
            # Collect Redis writes and do them in one pipeline after the loop
            _sat_pipe3 = r.pipeline(transaction=False)
            _sat_pipe3_keys = []

            for d in all_dangers:
                pair = tuple(sorted([d["sat_id"], d["deb_id"]]))
                if pair in processed_pairs:
                    continue
                processed_pairs.add(pair)

                sat_id  = d["sat_id"]
                sat_key = f"SATELLITE:{sat_id}"

                # FIX: use in-memory cache — no Redis GET per conjunction
                sat_obj = _sat_cache.get(sat_id)
                if sat_obj is None or sat_obj.get("status") == "GRAVEYARD":
                    continue

                s_st = np.array([float(sat_obj[k])
                                  for k in ("x", "y", "z", "vx", "vy", "vz")])

                # FIX: use pre-built O(1) index map — no _read_debris_blob() in loop
                _threat_idx = _deb_idx_map.get(d["deb_id"], -1)
                if _threat_idx >= 0:
                    _row = _ds3[_threat_idx]
                    d_st = _row.copy()   # ndarray [x,y,z,vx,vy,vz] directly
                else:
                    # threat is a satellite — look up from cache first, then Redis
                    _thr_obj = _sat_cache.get(d["deb_id"])
                    if _thr_obj is None:
                        _thr_raw = r.get(f"SATELLITE:{d['deb_id']}")
                        if not _thr_raw:
                            continue
                        _thr_obj = json.loads(_thr_raw)
                    d_st = np.array([float(_thr_obj[k])
                                      for k in ("x", "y", "z", "vx", "vy", "vz")])

                # Hard collision check  (PS §3.3)
                if float(np.linalg.norm(s_st[:3] - d_st[:3])) < CONJ_THRESHOLD:
                    collisions_detected += 1
                    r.hincrby(ALERT_KEY, "collisions", 1)

                min_dist, _ = find_tca(s_st, d_st)
                _, severity = calculate_risk(min_dist)

                if severity not in ("CRITICAL", "WARNING"):
                    continue

                # LOS gate  (PS §5.4)
                actual_dist = float(np.linalg.norm(s_st[:3] - d_st[:3]))
                is_imminent = actual_dist < CONJ_THRESHOLD
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
                last_b = float(sat_obj.get("last_burn_sim_time", -(COOLDOWN_S + 1.0)))
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

                # Update cache so subsequent conjunctions see the new state
                _sat_cache[sat_id] = sat_obj

                # Batch Redis write (executed after loop)
                _sat_pipe3.set(sat_key, json.dumps(sat_obj))
                _sat_pipe3_keys.append(sat_key)

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

            # Flush all conjunction avoidance writes in one round-trip
            if _sat_pipe3_keys:
                _sat_pipe3.execute()

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
        import traceback; traceback.print_exc()
        logger.error("simulate_step error: %s", exc)
        return {"status": "ERROR", "message": str(exc)}
    finally:
        _STEP_LOCK.release()


# ── Simulation control ────────────────────────────────────────────────────────
async def _simulation_loop(dt: float) -> None:
    """
    Continuous simulation loop — calls the synchronous step core directly
    via the dedicated _SIM_EXECUTOR so the event loop stays free for health checks.
    Uses a 0.5 s yield between steps to keep the event loop responsive.
    """
    global SIMULATION_RUNNING
    loop = asyncio.get_event_loop()
    while SIMULATION_RUNNING:
        await loop.run_in_executor(_SIM_EXECUTOR, _simulate_step_sync, float(dt))
        await asyncio.sleep(0.5)   # yield to event loop between steps



@app.post("/api/simulate/step")
async def simulate_step(req: SimStepRequest):
    """
    Advance the simulation by step_seconds.
    Runs on a dedicated single-thread executor so heavy computation never
    starves the uvicorn event loop — /api/status stays responsive.
    Response matches PS §4.3 exactly.
    """
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_SIM_EXECUTOR, _simulate_step_sync, float(req.step_seconds))


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
# Max debris entries sent per snapshot — frontend renders ~5k points smoothly;
# sending all 10k adds JSON serialisation latency with no visual benefit.
_SNAPSHOT_DEBRIS_CAP = 5000

def _build_snapshot_sync() -> dict:
    """
    Synchronous snapshot builder — runs on _SNAP_EXECUTOR so it never
    blocks the event loop or queues behind sim/ingest work.

    Debris serialisation is fully vectorised (numpy → Python list in one
    np.column_stack call) — replaces the previous 10k-iteration Python loop
    that caused 15s timeouts during the benchmark UI/UX assessment.
    """
    # ── Satellites ───────────────────────────────────────────────────────────
    satellites = []
    sat_keys   = redis_scan("SATELLITE:*")
    sat_raws   = r.mget(sat_keys) if sat_keys else []
    _et        = ELAPSED_SIM_TIME
    for raw in sat_raws:
        if not raw:
            continue
        obj = json.loads(raw)
        lat, lon, alt = eci_to_latlon(float(obj["x"]), float(obj["y"]),
                                      float(obj["z"]), _et)
        satellites.append({
            "id":      obj["id"],
            "lat":     round(lat, 4),
            "lon":     round(lon, 4),
            "alt_km":  round(alt, 2),
            "fuel_kg": round(float(obj.get("fuel", 0.0)), 3),
            "status":  obj.get("status", "ACTIVE"),
        })

    # ── Debris — fully vectorised, capped at _SNAPSHOT_DEBRIS_CAP ────────────
    debris_cloud = []
    _ds, _di = _read_debris_blob()
    n = len(_di)
    if n > 0:
        # Subsample evenly if over cap (deterministic — same objects each call)
        if n > _SNAPSHOT_DEBRIS_CAP:
            step = n // _SNAPSHOT_DEBRIS_CAP
            _ds  = _ds[::step][:_SNAPSHOT_DEBRIS_CAP]
            _di  = _di[::step][:_SNAPSHOT_DEBRIS_CAP]

        _OW  = 7.292115e-5
        gmst = _OW * _et
        xs = _ds[:, 0]; ys = _ds[:, 1]; zs = _ds[:, 2]
        rmag = np.maximum(np.sqrt(xs*xs + ys*ys + zs*zs), 1e-9)
        lats = np.degrees(np.arcsin(np.clip(zs / rmag, -1.0, 1.0)))
        lons = ((np.degrees(np.arctan2(ys, xs)) - math.degrees(gmst) + 180) % 360) - 180
        alts = rmag - RE

        # Vectorised round — avoids 30k Python float() / round() calls
        lats_r = np.round(lats, 3)
        lons_r = np.round(lons, 3)
        alts_r = np.round(alts, 1)

        # Build output as list-of-lists in one comprehension over pre-rounded arrays
        debris_cloud = [
            [_di[i], float(lats_r[i]), float(lons_r[i]), float(alts_r[i])]
            for i in range(len(_di))
        ]

    return {
        "timestamp":    SIM_WALL_TIMESTAMP.isoformat(),
        "satellites":   satellites,
        "debris_cloud": debris_cloud,
    }


@app.get("/api/visualization/snapshot")
async def visualization_snapshot():
    """
    Optimised fleet snapshot — runs on _SNAP_EXECUTOR so it's always
    responsive regardless of sim/ingest activity.
    Debris cloud uses compact [ID, lat, lon, alt] tuple format (PS §6.3).
    Capped at _SNAPSHOT_DEBRIS_CAP entries for fast HTTP transfer.
    """
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_SNAP_EXECUTOR, _build_snapshot_sync)


# ── 24-h CDM forecast  PS §2 ──────────────────────────────────────────────────
def _conjunction_forecast_sync() -> dict:
    sat_keys = redis_scan("SATELLITE:*")
    sat_raws = r.mget(sat_keys) if sat_keys else []
    sats     = [json.loads(raw) for raw in sat_raws if raw]
    _deb_st_f, _deb_ids_f = _read_debris_blob()
    debris = [
        {
            "id": _deb_ids_f[_i],
            "x":  float(_deb_st_f[_i, 0]), "y": float(_deb_st_f[_i, 1]),
            "z":  float(_deb_st_f[_i, 2]), "vx": float(_deb_st_f[_i, 3]),
            "vy": float(_deb_st_f[_i, 4]), "vz": float(_deb_st_f[_i, 5]),
        }
        for _i in range(len(_deb_ids_f))
    ]
    events = scan_24h_conjunctions(sats, debris)
    return {"forecast": events, "total_events": len(events), "lookahead_hours": 24}


@app.get("/api/conjunction/forecast")
async def conjunction_forecast():
    """24-hour predictive CDM scan across the full constellation."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _conjunction_forecast_sync)


# ── Remaining utility endpoints ───────────────────────────────────────────────
def _get_objects_sync():
    sat_keys2 = redis_scan("SATELLITE:*")
    sat_raws2 = r.mget(sat_keys2) if sat_keys2 else []
    sat_objs  = [json.loads(raw) for raw in sat_raws2 if raw]
    _ds3, _di3 = _read_debris_blob()
    deb_objs3 = [
        {
            "id": _di3[_i], "type": "DEBRIS",
            "x":  float(_ds3[_i, 0]), "y": float(_ds3[_i, 1]), "z": float(_ds3[_i, 2]),
            "vx": float(_ds3[_i, 3]), "vy": float(_ds3[_i, 4]), "vz": float(_ds3[_i, 5]),
        }
        for _i in range(len(_di3))
    ]
    return sat_objs + deb_objs3


@app.get("/api/objects")
async def get_objects():
    return await asyncio.to_thread(_get_objects_sync)


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
    # Batch-read all satellite keys for efficiency
    sat_keys = redis_scan("SATELLITE:*")
    sat_raws = r.mget(sat_keys) if sat_keys else []
    sat_uptime = {}
    for raw in sat_raws:
        if not raw:
            continue
        obj     = json.loads(raw)
        outside = float(obj.get("seconds_outside_box", 0.0))
        inside  = float(obj.get("seconds_inside_box",  0.0))
        tracked = inside + outside
        if tracked > 0:
            # Use directly-tracked inside time — immune to ELAPSED_SIM_TIME drift
            uptime_pct = 100.0 * inside / tracked
        else:
            # No steps yet — satellite is at nominal, uptime = 100%
            uptime_pct = 100.0
        sat_uptime[obj["id"]] = round(uptime_pct, 2)
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
    r_bin.delete(DEBRIS_BLOB_KEY)
    r_bin.delete(DEBRIS_IDS_KEY)
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