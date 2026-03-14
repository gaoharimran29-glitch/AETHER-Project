from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List
import redis
import json
import numpy as np
import asyncio
import logging
from datetime import datetime

from spatial.kd_tree import check_for_conjunctions
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

# ==============================
# LOGGING
# ==============================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - [%(name)s] %(message)s"
)

logger = logging.getLogger("AETHER-CORE")

# ==============================
# SYSTEM METRICS
# ==============================

SIM_START_TIME = datetime.utcnow()
TOTAL_MANEUVERS = 0
TOTAL_COLLISIONS_AVOIDED = 0
TOTAL_FUEL_USED = 0.0

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

r = redis.Redis(
    host="localhost",
    port=6379,
    decode_responses=True
)
ALERT_COUNTER_KEY = "alert_stats"

# ==============================
# GROUND STATION LOS CHECKER
# ==============================

los_checker = LOSChecker("data/ground_stations.csv")

SIMULATION_RUNNING = False

# ==============================
# CONSTANTS
# ==============================

ISP = 300.0
G0 = 9.80665
DRY_MASS = 500.0
INITIAL_FUEL = 50.0
MAX_DV = 0.015  # km/s (15 m/s)

# ==============================
# DATA MODELS
# ==============================

class Vector3(BaseModel):
    x: float
    y: float
    z: float

class SpaceObject(BaseModel):
    id: str
    type: str
    r: Vector3
    v: Vector3

class TelemetryRequest(BaseModel):
    timestamp: str
    objects: List[SpaceObject]

class ManeuverRequest(BaseModel):
    sat_id: str
    dv_rtn: List[float]

# ==============================
# UTILITIES
# ==============================

def redis_scan(pattern):
    cursor = 0
    keys = []

    while True:
        cursor, batch = r.scan(cursor=cursor, match=pattern)
        keys.extend(batch)
        if cursor == 0:
            break

    return keys


def try_return_to_nominal(sat_obj):

    if not sat_obj.get("needs_return"):
        return None

    last = sat_obj.get("last_maneuver")

    if not last:
        return None

    elapsed = (datetime.utcnow() - datetime.fromisoformat(last)).total_seconds()

    if elapsed < 1200:  # wait 20 minutes
        return None

    nominal = sat_obj["nominal"]

    dv = [
        nominal["vx"] - sat_obj["vx"],
        nominal["vy"] - sat_obj["vy"],
        nominal["vz"] - sat_obj["vz"]
    ]

    return dv

@app.get("/api/status")
async def system_status():

    satellites = len(redis_scan("SATELLITE:*"))
    debris = len(redis_scan("DEBRIS:*"))

    alerts = r.hgetall(ALERT_COUNTER_KEY)

    return {
        "simulation_running": SIMULATION_RUNNING,
        "satellites": satellites,
        "debris_objects": debris,
        "alerts": alerts
    }

@app.post("/api/maneuver")
async def manual_maneuver(req: ManeuverRequest):

    key = f"SATELLITE:{req.sat_id}"

    raw = r.get(key)

    if not raw:
        return {"error": "Satellite not found"}

    sat = json.loads(raw)

    state = np.array([
        sat["x"], sat["y"], sat["z"],
        sat["vx"], sat["vy"], sat["vz"]
    ])

    new_state = apply_maneuver(state, req.dv_rtn)

    sat["vx"] = float(new_state[3])
    sat["vy"] = float(new_state[4])
    sat["vz"] = float(new_state[5])

    r.set(key, json.dumps(sat))

    return {"status": "maneuver_applied"}

@app.post("/api/reset")
async def reset_simulation():

    keys = redis_scan("*")

    for k in keys:
        r.delete(k)

    return {"status": "simulation reset"}

@app.get("/api/system/metrics")
async def system_metrics():

    uptime = (datetime.utcnow() - SIM_START_TIME).total_seconds()

    return {
        "uptime_seconds": uptime,
        "maneuvers_executed": TOTAL_MANEUVERS,
        "collisions_avoided": TOTAL_COLLISIONS_AVOIDED,
        "fuel_used_total": TOTAL_FUEL_USED
    }

# ==============================
# TELEMETRY INGESTION
# ==============================

@app.post("/api/telemetry")
async def ingest_telemetry(data: TelemetryRequest):

    processed = 0

    for obj in data.objects:

        key = f"{obj.type}:{obj.id}"

        existing = r.get(key)

        fuel_value = INITIAL_FUEL

        if existing:
            fuel_value = json.loads(existing)["fuel"]

        if not existing:
            obj_data = {
                "id": obj.id,
                "type": obj.type,
                "x": obj.r.x,
                "y": obj.r.y,
                "z": obj.r.z,
                "vx": obj.v.x,
                "vy": obj.v.y,
                "vz": obj.v.z,
                "fuel": fuel_value,
                "last_update": data.timestamp,

                # NEW FIELDS
                "nominal": {
                    "x": obj.r.x,
                    "y": obj.r.y,
                    "z": obj.r.z,
                    "vx": obj.v.x,
                    "vy": obj.v.y,
                    "vz": obj.v.z
                },
                "needs_return": False,
                "last_maneuver": None,
                "status": "ACTIVE"
            }
        else:
            obj_data = json.loads(existing)

        r.set(key, json.dumps(obj_data))
        processed += 1

    logger.info(f"Telemetry Ingested: {processed} objects")

    return {"status": "ACK", "processed_count": processed}

# ==============================
# SIMULATION STEP
# ==============================
@app.post("/api/simulate/step")
async def simulate_step(dt: float = 1.0):

    keys = redis_scan("SATELLITE:*") + redis_scan("DEBRIS:*")

    updated = 0

    # ==============================
    # ORBIT PROPAGATION
    # ==============================

    for key in keys:

        raw = r.get(key)
        if not raw:
            continue

        obj = json.loads(raw)

        if obj.get("status") == "GRAVEYARD":
            continue

        state = np.array([
            obj["x"], obj["y"], obj["z"],
            obj["vx"], obj["vy"], obj["vz"]
        ], dtype=float)

        new_state = rk4_step(state, dt)

        obj.update({
            "x": float(new_state[0]),
            "y": float(new_state[1]),
            "z": float(new_state[2]),
            "vx": float(new_state[3]),
            "vy": float(new_state[4]),
            "vz": float(new_state[5]),
            "last_update": datetime.utcnow().isoformat()
        })

        nominal = obj.get("nominal")

        if nominal:

            nominal_pos = np.array([
            nominal["x"],
            nominal["y"],
            nominal["z"]
            ])

            if is_outside_box(new_state[:3], nominal_pos):

                logger.warning(f"{obj['id']} drifted outside station box")

                dv_correction = recovery_delta_v(new_state[:3], nominal_pos)

                corrected_state = apply_maneuver(new_state, dv_correction)

                obj["vx"] = float(corrected_state[3])
                obj["vy"] = float(corrected_state[4])
                obj["vz"] = float(corrected_state[5])

        r.set(key, json.dumps(obj))
        updated += 1


    # ==============================
    # CONJUNCTION DETECTION
    # ==============================

    sats = [json.loads(r.get(k)) for k in redis_scan("SATELLITE:*")]
    debris = [json.loads(r.get(k)) for k in redis_scan("DEBRIS:*")]

    dangers = check_for_conjunctions(sats, debris)


    for d in dangers:

        dist = d["distance"]
        sat = d["sat_id"]
        deb = d["deb_id"]

        sat_key = f"SATELLITE:{sat}"
        deb_key = f"DEBRIS:{deb}"

        sat_raw = r.get(sat_key)
        deb_raw = r.get(deb_key)

        if not sat_raw or not deb_raw:
            continue

        sat_obj = json.loads(sat_raw)
        deb_obj = json.loads(deb_raw)
        sat_state = np.array([
            sat_obj["x"], sat_obj["y"], sat_obj["z"],
            sat_obj["vx"], sat_obj["vy"], sat_obj["vz"]
        ])

        deb_state = np.array([
            deb_obj["x"], deb_obj["y"], deb_obj["z"],
            deb_obj["vx"], deb_obj["vy"], deb_obj["vz"]
        ])
        fuel_percent = ( sat_obj["fuel"] / INITIAL_FUEL ) * 100

        if fuel_percent < 5:

            logger.warning(f"{sat} low fuel — sending to graveyard")

            dv = [0.0, 0.0, 0.015]

            new_state = apply_maneuver(sat_state, dv)

            sat_obj["vx"] = float(new_state[3])
            sat_obj["vy"] = float(new_state[4])
            sat_obj["vz"] = float(new_state[5])

            sat_obj["status"] = "GRAVEYARD"

            r.set(sat_key, json.dumps(sat_obj))

            continue

        deb_obj = json.loads(deb_raw)

        # ==============================
        # TCA PREDICTION
        # ==============================

        min_dist, tca_time = find_tca(
            sat_state,
            deb_state
        )

        logger.info(
            f"TCA predicted in {tca_time:.1f}s "
            f"min distance {min_dist:.4f} km"
        )

        sat_pos = sat_state[:3]
        deb_pos = deb_state[:3]


        # ==============================
        # FAST RISK MODEL
        # ==============================

        pc_fast, severity = calculate_risk(min_dist)

        # ==============================
        # MONTE CARLO (ONLY IF NEEDED)
        # ==============================

        pc_mc = pc_fast

        if severity != "SAFE":

            pc_mc, severity = monte_carlo_collision_probability(
                sat_pos,
                deb_pos
            )

            logger.info(f"Monte Carlo Pc={pc_mc:.6f}")


        # ==============================
        # STORE CDM
        # ==============================

        cdm = {
            "timestamp": datetime.utcnow().isoformat(),
            "sat_id": sat,
            "deb_id": deb,
            "current_distance": float(dist),
            "tca_distance": float(min_dist),
            "tca_time": float(tca_time),
            "probability": float(pc_mc if severity != "SAFE" else pc_fast),
            "severity": severity
        }


        r.lpush("cdm_history", json.dumps(cdm))
        r.hincrby(ALERT_COUNTER_KEY, severity, 1)
        r.ltrim("cdm_history", 0, 100)


        msg = f"CONJUNCTION [{severity}] {sat} <-> {deb} @ {dist:.4f} km"

        if severity == "CRITICAL":

            logger.error(msg)

            # ==============================
            # CHECK LOS
            # ==============================

            visible_stations = los_checker.check_los(sat_pos, elevation_mask=10)

            if len(visible_stations) == 0:

                logger.warning(f"{sat} has NO ground contact")

                try:

                    gs_pos = los_checker.stations[0]["pos"]

                    next_pass = estimate_next_pass(
                        sat_pos,
                        gs_pos
                    )

                    logger.info(f"Next ground pass in {next_pass:.1f}s")

                except Exception as e:

                    logger.warning(f"Pass prediction failed {e}")
                    next_pass = None


                if next_pass and next_pass < 900:

                    logger.info("Waiting for ground contact")

                else:

                    logger.warning("Emergency autonomous maneuver")

                    best = find_best_maneuver(sat_state)

                    if best and can_burn(sat_obj):

                        dv = best["dv"]

                        dv_mag = np.linalg.norm(dv)

                        if dv_mag > MAX_DV:
                            logger.warning(f"{sat} maneuver rejected: dv too large {dv_mag}")
                            continue

                        m_current = DRY_MASS + sat_obj["fuel"]

                        new_mass, fuel_used = update_mass(m_current, dv_mag)

                        sat_obj["fuel"] = max(0, sat_obj["fuel"] - fuel_used)

                        burn_time = enforce_latency(time.time(), time.time())

                        new_state = apply_maneuver(
                            sat_state,
                            dv
                        )

                        sat_obj["vx"] = float(new_state[3])
                        sat_obj["vy"] = float(new_state[4])
                        sat_obj["vz"] = float(new_state[5])

                        sat_obj["needs_return"] = True
                        sat_obj["last_maneuver"] = datetime.utcnow().isoformat()

                        r.set(sat_key, json.dumps(sat_obj))

                        logger.info(f"Maneuver executed for {sat} dv={dv_mag:.4f} fuel_left={sat_obj['fuel']:.3f}")

                    else:
                        logger.warning(f"{sat} burn skipped due to cooldown")

            else:

                logger.info(f"{sat} visible from {visible_stations}")

                best = find_best_maneuver(sat_state)

                if best and can_burn(sat_obj):

                    dv = best["dv"]

                    dv_mag = np.linalg.norm(dv)

                    if dv_mag > MAX_DV:
                        logger.warning(f"{sat} maneuver rejected: dv too large {dv_mag}")
                        continue

                    m_current = DRY_MASS + sat_obj["fuel"]

                    new_mass, fuel_used = update_mass(m_current, dv_mag)

                    sat_obj["fuel"] = max(0, sat_obj["fuel"] - fuel_used)

                    burn_time = enforce_latency(time.time(), time.time())

                    new_state = apply_maneuver(
                        sat_state,
                        dv
                    )

                    sat_obj["vx"] = float(new_state[3])
                    sat_obj["vy"] = float(new_state[4])
                    sat_obj["vz"] = float(new_state[5])

                    sat_obj["needs_return"] = True
                    sat_obj["last_maneuver"] = datetime.utcnow().isoformat()

                    r.set(sat_key, json.dumps(sat_obj))

                    logger.info(f"Maneuver executed for {sat}")

                    global TOTAL_MANEUVERS, TOTAL_COLLISIONS_AVOIDED, TOTAL_FUEL_USED

                    TOTAL_MANEUVERS += 1
                    TOTAL_COLLISIONS_AVOIDED += 1
                    TOTAL_FUEL_USED += fuel_used

                else:
                    logger.warning(f"{sat} burn skipped due to cooldown")

        elif severity == "WARNING":

            logger.warning(msg)

        else:

            logger.info(msg)

    # ==============================
    # RETURN TO NOMINAL ORBIT
    # ==============================

    for key in redis_scan("SATELLITE:*"):

        raw = r.get(key)
        if not raw:
            continue

        sat_obj = json.loads(raw)

        dv = try_return_to_nominal(sat_obj)

        if dv:

            state = np.array([
                sat_obj["x"], sat_obj["y"], sat_obj["z"],
                sat_obj["vx"], sat_obj["vy"], sat_obj["vz"]
            ])

            new_state = apply_maneuver(state, dv)

            sat_obj["vx"] = float(new_state[3])
            sat_obj["vy"] = float(new_state[4])
            sat_obj["vz"] = float(new_state[5])

            sat_obj["needs_return"] = False

            r.set(key, json.dumps(sat_obj))

            logger.info(f"{sat_obj['id']} returned to nominal orbit")

    return {
        "status": "STEP_COMPLETE",
        "updated_objects": updated,
        "conjunctions_found": len(dangers)
    }

# ==============================
# SIMULATION LOOP
# ==============================

async def simulation_loop(dt):

    global SIMULATION_RUNNING

    while SIMULATION_RUNNING:

        await simulate_step(dt)

        await asyncio.sleep(1)


@app.post("/api/simulate/start")
async def start_simulation(dt: float = 5.0):

    global SIMULATION_RUNNING

    if SIMULATION_RUNNING:
        return {"status": "Already Running"}

    SIMULATION_RUNNING = True

    asyncio.create_task(simulation_loop(dt))

    logger.info(f"Simulation Started dt={dt}")

    return {"status": "Simulation Running"}


@app.post("/api/simulate/stop")
async def stop_simulation():

    global SIMULATION_RUNNING

    SIMULATION_RUNNING = False

    logger.info("Simulation Stopped")

    return {"status": "Simulation Stopped"}

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
# SERVER START
# ==============================

if __name__ == "__main__":

    import uvicorn

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000
    )