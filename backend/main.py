from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List
import redis
import json
import numpy as np
import os
import asyncio
import logging
from datetime import datetime
from scheduler import event_queue
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
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
MAX_DV = float(os.getenv("MAX_DV", 0.015))

r = redis.Redis(
    host=REDIS_HOST,
    port=6379,
    decode_responses=True
)

ALERT_COUNTER_KEY = "alert_stats"

# ==============================
# GROUND STATION LOS CHECKER
# ==============================

los_checker = LOSChecker("data/ground_stations.csv")

SIMULATION_RUNNING = False
SIMULATION_START_TIME = time.time()
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
    try:
        key = f"SATELLITE:{req.sat_id}"
        raw = r.get(key)
        if not raw: return {"error": "Satellite not found"}
        
        sat = json.loads(raw)
        state = np.array([sat["x"], sat["y"], sat["z"], sat["vx"], sat["vy"], sat["vz"]])

        state_at_burn_time = rk4_step(state, 10.0) 
        
        new_state = apply_maneuver(state_at_burn_time, req.dv_rtn)

        sat.update({
            "x": float(new_state[0]), "y": float(new_state[1]), "z": float(new_state[2]),
            "vx": float(new_state[3]), "vy": float(new_state[4]), "vz": float(new_state[5]),
            "last_maneuver": datetime.utcnow().isoformat()
        })
        r.set(key, json.dumps(sat))
        return {"status": "maneuver_applied_with_10s_latency"}
    except Exception as e:
        logger.error(f"Manual maneuver failed: {e}")
        return {"error": str(e)}
    
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

EVENT_QUEUE = []

@app.get("/api/scheduler/queue")
async def get_event_queue():
    return EVENT_QUEUE

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
# Global variable initialization (main.py ke top level pe rakho)
ELAPSED_SIM_TIME = 0.0

@app.post("/api/simulate/step")
async def simulate_step(dt: float = 1.0):
    global ELAPSED_SIM_TIME, TOTAL_MANEUVERS, TOTAL_COLLISIONS_AVOIDED, TOTAL_FUEL_USED
    
    try:
        keys = redis_scan("SATELLITE:*") + redis_scan("DEBRIS:*")
        ELAPSED_SIM_TIME += dt
        updated = 0

        # ==============================
        # 1. ORBIT PROPAGATION
        # ==============================
        for key in keys:
            try:
                raw = r.get(key)
                if not raw: continue
                obj = json.loads(raw)

                if obj.get("status") == "GRAVEYARD": continue

                state = np.array([
                    obj["x"], obj["y"], obj["z"],
                    obj["vx"], obj["vy"], obj["vz"]
                ], dtype=float)

                # Standard propagation for this time step
                new_state = rk4_step(state, dt)

                obj.update({
                    "x": float(new_state[0]), "y": float(new_state[1]), "z": float(new_state[2]),
                    "vx": float(new_state[3]), "vy": float(new_state[4]), "vz": float(new_state[5]),
                    "last_update": datetime.utcnow().isoformat()
                })

                # Station Keeping Logic
                nominal = obj.get("nominal")
                if nominal:
                    nominal_pos = np.array([nominal["x"], nominal["y"], nominal["z"]])
                    if is_outside_box(new_state[:3], nominal_pos):
                        if can_burn(obj):
                            dv_correction = recovery_delta_v(new_state[:3], nominal_pos)
                            dv_mag = np.linalg.norm(dv_correction)
                            
                            # Rule: Latency delay of 10s before applying station keeping burn
                            state_at_burn = rk4_step(new_state, 10.0)
                            corrected_state = apply_maneuver(state_at_burn, dv_correction)
                            
                            # Fuel update
                            m_current = DRY_MASS + obj["fuel"]
                            _, fuel_used = update_mass(m_current, dv_mag)
                            
                            obj.update({
                                "vx": float(corrected_state[3]),
                                "vy": float(corrected_state[4]),
                                "vz": float(corrected_state[5]),
                                "fuel": max(0, obj["fuel"] - fuel_used),
                                "last_maneuver": datetime.utcnow().isoformat()
                            })
                            logger.info(f"Station keeping burn for {obj['id']}")

                r.set(key, json.dumps(obj))
                updated += 1
            except Exception as e:
                logger.error(f"Error propagating {key}: {e}")

        # ==============================
        # 2. CONJUNCTION DETECTION
        # ==============================
        sats = [json.loads(r.get(k)) for k in redis_scan("SATELLITE:*")]
        debris = [json.loads(r.get(k)) for k in redis_scan("DEBRIS:*")]
        
        dangers = check_for_conjunctions(sats, debris)

        for d in dangers:
            sat_id, deb_id, dist = d["sat_id"], d["deb_id"], d["distance"]
            sat_key, deb_key = f"SATELLITE:{sat_id}", f"DEBRIS:{deb_id}"
            
            sat_raw, deb_raw = r.get(sat_key), r.get(deb_key)
            if not sat_raw or not deb_raw: continue

            sat_obj, deb_obj = json.loads(sat_raw), json.loads(deb_raw)
            sat_state = np.array([sat_obj["x"], sat_obj["y"], sat_obj["z"], sat_obj["vx"], sat_obj["vy"], sat_obj["vz"]])
            deb_state = np.array([deb_obj["x"], deb_obj["y"], deb_obj["z"], deb_obj["vx"], deb_obj["vy"], deb_obj["vz"]])

            # TCA & Risk Analysis
            min_dist, tca_time = find_tca(sat_state, deb_state)
            pc_fast, severity = calculate_risk(min_dist)
            
            pc_final = pc_fast
            if severity != "SAFE":
                pc_final, severity = monte_carlo_collision_probability(sat_state[:3], deb_state[:3])

            # Alert Stats & Logging
            cdm = {
                "timestamp": datetime.utcnow().isoformat(),
                "sat_id": sat_id, "deb_id": deb_id,
                "tca_distance": float(min_dist), "probability": float(pc_final), "severity": severity
            }
            r.lpush("cdm_history", json.dumps(cdm))
            r.hincrby(ALERT_COUNTER_KEY, severity, 1)

            # --- CRITICAL MANEUVER EXECUTION ---
            if severity == "CRITICAL":
                # Check Ground Station LOS (Rule 5.4)
                visible_stations = los_checker.check_los(sat_state[:3], elevation_mask=10, sim_time_sec=ELAPSED_SIM_TIME)
                
                if not visible_stations:
                    logger.warning(f"CRITICAL: {sat_id} NO LOS. Command deferred.")
                    continue

                best = find_best_maneuver(sat_state)
                if best and can_burn(sat_obj):
                    dv = best["dv"]
                    dv_mag = np.linalg.norm(dv)
                    if dv_mag > MAX_DV: continue

                    # Latency: Propagate 10s into future before applying burn
                    future_state = rk4_step(sat_state, 10.0)
                    new_state = apply_maneuver(future_state, dv)

                    m_current = DRY_MASS + sat_obj["fuel"]
                    _, fuel_used = update_mass(m_current, dv_mag)

                    sat_obj.update({
                        "vx": float(new_state[3]), "vy": float(new_state[4]), "vz": float(new_state[5]),
                        "fuel": max(0, sat_obj["fuel"] - fuel_used),
                        "needs_return": True,
                        "last_maneuver": datetime.utcnow().isoformat()
                    })
                    
                    TOTAL_MANEUVERS += 1
                    TOTAL_COLLISIONS_AVOIDED += 1
                    TOTAL_FUEL_USED += fuel_used
                    r.set(sat_key, json.dumps(sat_obj))
                    logger.info(f"SUCCESS: Avoidance Maneuver for {sat_id}")

        # ==============================
        # 3. RETURN TO NOMINAL & EVENTS
        # ==============================
        pending_events = event_queue.get_pending_events(ELAPSED_SIM_TIME)
        for ts, ev_type, data in pending_events:
            logger.info(f"Executing scheduled event: {ev_type}")

        for key in redis_scan("SATELLITE:*"):
            raw = r.get(key)
            if not raw: continue
            sat_obj = json.loads(raw)
            dv = try_return_to_nominal(sat_obj)
            if dv:
                state = np.array([sat_obj["x"], sat_obj["y"], sat_obj["z"], sat_obj["vx"], sat_obj["vy"], sat_obj["vz"]])
                # Latency delay for nominal return
                state_at_burn = rk4_step(state, 10.0)
                new_state = apply_maneuver(state_at_burn, dv)
                sat_obj.update({
                    "vx": float(new_state[3]), "vy": float(new_state[4]), "vz": float(new_state[5]),
                    "needs_return": False
                })
                r.set(key, json.dumps(sat_obj))

        return {"status": "STEP_COMPLETE", "updated_objects": updated, "sim_time": ELAPSED_SIM_TIME}

    except Exception as e:
        logger.critical(f"Simulation step failed: {e}")
        return {"status": "ERROR", "message": str(e)}

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