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
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
file_path = os.path.join(BASE_DIR, "data", "ground_stations.csv")
los_checker = LOSChecker(file_path)

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
    fuel: float = 50.0 

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

R_EARTH = 6378.137

def lat_long_to_eci(lat, lon, alt):
    lat_rad = np.radians(lat)
    lon_rad = np.radians(lon)
    x = (R_EARTH + (alt / 1000.0)) * np.cos(lat_rad) * np.cos(lon_rad)
    y = (R_EARTH + (alt / 1000.0)) * np.cos(lat_rad) * np.sin(lon_rad)
    z = (R_EARTH + (alt / 1000.0)) * np.sin(lat_rad)
    return x, y, z

def retire_to_graveyard(sat_obj):
    graveyard_dv = [0.1, 0.05, 0.0] 
    
    state = np.array([float(sat_obj[k]) for k in ['x','y','z','vx','vy','vz']])
    state_at_burn = rk4_step(state, 10.0)
    retired_state = apply_maneuver(state_at_burn, graveyard_dv)
    
    sat_obj.update({
        "vx": float(retired_state[3]), 
        "vy": float(retired_state[4]), 
        "vz": float(retired_state[5]),
        "status": "GRAVEYARD",
        "fuel": 0.0, # Final burn exhausts remaining fuel
        "needs_return": False
    })
    print(f"!!! RETIREMENT: {sat_obj['id']} reached 5% threshold. Moving to GRAVEYARD orbit.")

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
        
        # YE LINE MISSING THI (State define karo)
        state = np.array([
            float(sat["x"]), float(sat["y"]), float(sat["z"]), 
            float(sat["vx"]), float(sat["vy"]), float(sat["vz"])
        ])

        # PS ki Demand: 10s Latency ka log print karo
        print(f"!!! MANUAL COMMAND RECEIVED for {req.sat_id}")
        print(f"ENFORCING HARDCODED 10-SECOND LATENCY. Executing at T+10s...")

        # Physics jump for 10 seconds delay
        state_at_burn_time = rk4_step(state, 10.0) 
        
        # Apply the maneuver
        new_state = apply_maneuver(state_at_burn_time, req.dv_rtn)

        # Update back to Redis
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
        
        # Pydantic model se fuel nikal (Isse use karo!)
        # Note: SpaceObject model mein fuel field add karni hogi (Niche dekho)
        incoming_fuel = getattr(obj, 'fuel', INITIAL_FUEL) 

        obj_data = {
            "id": obj.id,
            "type": obj.type,
            "x": obj.r.x, "y": obj.r.y, "z": obj.r.z,
            "vx": obj.v.x, "vy": obj.v.y, "vz": obj.v.z,
            "fuel": incoming_fuel, # Hamesha naya fuel lo!
            "status": "ACTIVE",
            "nominal": {"x": obj.r.x, "y": obj.r.y, "z": obj.r.z}
        }
        r.set(key, json.dumps(obj_data))
        processed += 1
    return {"status": "ACK", "processed_count": processed}

# ==============================
# SIMULATION STEP
# ==============================
ELAPSED_SIM_TIME = 0.0
@app.post("/api/simulate/step")
async def simulate_step(dt: float = 1.0):
    global ELAPSED_SIM_TIME, TOTAL_MANEUVERS, TOTAL_COLLISIONS_AVOIDED, TOTAL_FUEL_USED
    
    try:
        keys = redis_scan("SATELLITE:*") + redis_scan("DEBRIS:*")
        ELAPSED_SIM_TIME += dt
        updated = 0

        # --- STEP 1: PROPAGATION LOOP ---
        for key in keys:
            raw = r.get(key)
            if not raw: continue
            obj = json.loads(raw)
            if obj.get("status") == "GRAVEYARD": continue

            state = np.array([float(obj[k]) for k in ['x','y','z','vx','vy','vz']])
            new_state = rk4_step(state, dt)

            obj.update({
                "x": float(new_state[0]), "y": float(new_state[1]), "z": float(new_state[2]),
                "vx": float(new_state[3]), "vy": float(new_state[4]), "vz": float(new_state[5]),
                "last_update": datetime.utcnow().isoformat()
            })
            
            if "SATELLITE" in key:
                fuel_percent = (obj.get("fuel", 0) / INITIAL_FUEL) * 100
                nominal = obj.get("nominal")

                if fuel_percent <= 5.0 and obj.get("status") != "GRAVEYARD":
                    retire_to_graveyard(obj)
                    r.set(key, json.dumps(obj))
                    updated += 1
                    continue
                
                if obj.get("status") == "GRAVEYARD":
                    r.set(key, json.dumps(obj))
                    continue
                
                if nominal and is_outside_box(new_state[:3], np.array([nominal['x'], nominal['y'], nominal['z']])):
                    if obj.get("fuel", 0) <= 0:
                        obj["status"] = "GRAVEYARD"
                        print(f"!!! CRITICAL: {obj['id']} has NO FUEL for Station Keeping. Status: GRAVEYARD")
                    else:
                        if can_burn(obj, ELAPSED_SIM_TIME):
                            print(f"STATION_KEEPING: {obj['id']} drifting from slot. Correcting...")
                            print(f"!!! LATENCY ENFORCED: Station Keeping command for {obj['id']} delayed by 10.0s")
                            dv_corr = recovery_delta_v(new_state, np.array([nominal['x'], nominal['y'], nominal['z']]))
                            state_at_burn = rk4_step(new_state, 10.0) # Latency
                            corrected = apply_maneuver(state_at_burn, dv_corr)
                            
                            m_curr = DRY_MASS + obj.get("fuel", 0)
                            _, fuel_used = update_mass(m_curr, np.linalg.norm(dv_corr))
                            
                            obj.update({
                                "vx": float(corrected[3]), "vy": float(corrected[4]), "vz": float(corrected[5]),
                                "fuel": max(0, obj.get("fuel", 0) - fuel_used),
                                "last_maneuver": datetime.utcnow().isoformat()
                            })
                            print(f"SUCCESS: SK Maneuver executed for {obj['id']} (10s latency accounted)")

            r.set(key, json.dumps(obj))
            updated += 1

        # ==============================
        # 2. CONJUNCTION DETECTION & AVOIDANCE (CLEAN VERSION)
        # ==============================
        sats_data = [json.loads(r.get(k)) for k in redis_scan("SATELLITE:*")]
        debris_data = [json.loads(r.get(k)) for k in redis_scan("DEBRIS:*")]

        if sats_data and debris_data:
            # Spatial Check
            dangers = check_for_conjunctions(sats_data, debris_data)
            
            for d in dangers:
                sat_id, deb_id = d["sat_id"], d["deb_id"]
                sat_key = f"SATELLITE:{sat_id}"
                
                sat_obj = json.loads(r.get(sat_key))
                
                # 1. Satellite State Vector
                s_st = np.array([float(sat_obj[k]) for k in ['x','y','z','vx','vy','vz']])
                
                # 2. Debris State Vector (Debris data list se find karo)
                deb_obj = next((item for item in debris_data if item["id"] == deb_id), None)
                if not deb_obj: continue
                d_st = np.array([float(deb_obj[k]) for k in ['x','y','z','vx','vy','vz']])
                
                # 3. Risk Analysis
                min_dist, _ = find_tca(s_st, d_st)
                _, severity = calculate_risk(min_dist)
                
                print(f"DEBUG: Danger between {sat_id} & {deb_id} | Dist: {min_dist:.4f}km | Severity: {severity}")

                # 4. Maneuver Decision (CRITICAL or WARNING)
                if severity in ["CRITICAL", "WARNING"]:
                    
                    prob , risk_level = monte_carlo_collision_probability(s_st[:3], d_st[:3])
                    print(f"DEBUG: Monte Carlo Probability: {prob:.4f} | Risk: {risk_level}")
                    if prob > 0.001:  # 0.1% probability threshold
                        # 2. Enforce Command Latency
                        requested_time = ELAPSED_SIM_TIME 
                        actual_burn_time = enforce_latency(ELAPSED_SIM_TIME, requested_time)
                        exec_delay = actual_burn_time - ELAPSED_SIM_TIME
                        print(f"LATENCY: Command will take {exec_delay}s to execute.")
                        
                        best = find_best_maneuver(s_st, d_st)                    
                        if best and can_burn(sat_obj, time.time()):
                            dv = best["dv"]
                            
                            # Apply 10s Latency & RK4
                            future_s = rk4_step(s_st, float(exec_delay))
                            final_s = apply_maneuver(future_s, dv)
                            
                            # Fuel Calculation
                            dv_mag = np.linalg.norm(dv)
                            _, f_used = update_mass(DRY_MASS + sat_obj.get("fuel", 0), dv_mag)

                            # Update Object
                            sat_obj.update({
                                "vx": float(final_s[3]), 
                                "vy": float(final_s[4]), 
                                "vz": float(final_s[5]),
                                "fuel": max(0, sat_obj.get("fuel", 0) - f_used),
                                "needs_return": True,
                                "last_maneuver": datetime.utcnow().isoformat()
                            })

                            new_fuel = max(0, sat_obj.get("fuel", 0) - f_used)
                            sat_obj["fuel"] = new_fuel

                            if new_fuel <= 0:
                                sat_obj["status"] = "GRAVEYARD"
                                print(f"!!! CRITICAL: {sat_id} fuel exhausted. Satellite is now DEBRIS.")
                            
                            # Redis Save & Stats
                            r.set(sat_key, json.dumps(sat_obj))
                            TOTAL_MANEUVERS += 1
                            TOTAL_COLLISIONS_AVOIDED += 1
                            TOTAL_FUEL_USED += f_used
                            
                            print(f"SUCCESS: Avoidance Maneuver for {sat_id} executed!")

                            cdm_log = {
                                "alert_id": f"CDM-{int(time.time())}",
                                "timestamp": datetime.utcnow().isoformat(),
                                "sat_id": sat_id,
                                "deb_id": deb_id,
                                "distance": float(min_dist),
                                "severity": severity,
                                "action": "MANEUVER_EXECUTED"
                            }
                            r.lpush("cdm_history", json.dumps(cdm_log))
                            r.ltrim("cdm_history", 0, 49) 

    except Exception as e:
        import traceback
        traceback.print_exc() 
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

@app.get("/api/satellite/{sat_id}/next_pass")
async def get_next_pass(sat_id: str):
    key = f"SATELLITE:{sat_id}"
    raw = r.get(key)
    if not raw: return {"error": "Not found"}
    
    sat = json.loads(raw)
    sat_pos = np.array([sat['x'], sat['y'], sat['z']])
    sat_vel = np.array([sat['vx'], sat['vy'], sat['vz']])
    
    stations = los_checker.stations
    
    predictions = []
    for st in stations:
        lat = float(st['Latitude'])
        lon = float(st['Longitude'])
        alt = float(st['Elevation_m'])
        
        gx, gy, gz = lat_long_to_eci(lat, lon, alt)
        gs_pos = np.array([gx, gy, gz])
        
        pass_time = estimate_next_pass(sat_pos, gs_pos, sat_vel)
        
        predictions.append({
            "station": st['Station_Name'],
            "estimated_wait_seconds": round(pass_time, 2)
        })
    
    return {"sat_id": sat_id, "upcoming_passes": predictions}

# ==============================
# SERVER START
# ==============================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)