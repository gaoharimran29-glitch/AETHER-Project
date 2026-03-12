from fastapi import FastAPI, BackgroundTasks
from pydantic import BaseModel
from typing import List, Dict
import redis
import json
import numpy as np
from spatial.kd_tree import check_for_conjunctions
from physics.rk4_integrator import rk4_step

app = FastAPI()

# Redis Connection
r = redis.Redis(host='localhost', port=6379, decode_responses=True)

# Data Models
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

@app.post("/api/telemetry")
async def ingest_telemetry(data: TelemetryRequest):
    for obj in data.objects:
        obj_data = {
            "id": obj.id,
            "type": obj.type,
            "x": obj.r.x, "y": obj.r.y, "z": obj.r.z,
            "vx": obj.v.x, "vy": obj.v.y, "vz": obj.v.z,
            "fuel": 50.0 if obj.type == "SATELLITE" else 0.0,
            "last_update": data.timestamp
        }
        r.set(f"{obj.type}:{obj.id}", json.dumps(obj_data))

    return {"status": "ACK", "processed_count": len(data.objects)}

@app.post("/api/simulate/step")
async def simulate_step(dt: float = 1.0):
    # 1. Take all keys
    all_keys = r.keys("SATELLITE:*") + r.keys("DEBRIS:*")
    
    # 2. Update position of evry object (RK4)
    for key in all_keys:
        raw_data = r.get(key)
        if not raw_data: continue
        
        obj_data = json.loads(raw_data)
        
        # Make Current state array
        current_state = np.array([
            float(obj_data['x']), float(obj_data['y']), float(obj_data['z']),
            float(obj_data['vx']), float(obj_data['vy']), float(obj_data['vz'])
        ])
        
        # CAll RK4 step
        new_state = rk4_step(current_state, dt)
        
        # Update dict
        obj_data.update({
            "x": new_state[0], "y": new_state[1], "z": new_state[2],
            "vx": new_state[3], "vy": new_state[4], "vz": new_state[5]
        })
        
        # Save back to Redis
        r.set(key, json.dumps(obj_data))

    # 3. Check conjuction after position update
    sat_data = [json.loads(r.get(k)) for k in r.keys("SATELLITE:*")]
    deb_data = [json.loads(r.get(k)) for k in r.keys("DEBRIS:*")]
    
    danger_zones = check_for_conjunctions(sat_data, deb_data)
    
    # Debug results to terminal
    for danger in danger_zones:
        d_val = danger['distance']
        s_id = danger['sat_id']
        b_id = danger['deb_id']
        
        if d_val < 0.1: # 100 meters
            print(f"!!! CRITICAL COLLISION: {s_id} <-> {b_id} AT {d_val:.4f} km")
        elif d_val < 5.0: # 5 km
            print(f"WARNING: Close approach for {s_id} at {d_val:.4f} km")

    return {
        "status": "OK", 
        "updated_objects": len(all_keys), 
        "conjunctions_found": len(danger_zones),
        "alerts": danger_zones
    }

from maneuver.maneuver_planner import apply_maneuver

class ManeuverRequest(BaseModel):
    sat_id: str
    dv_rtn: List[float] # Example: [0.001, 0.005, 0.0] (km/s)

@app.post("/api/maneuver/apply")
async def schedule_maneuver(req: ManeuverRequest):
    key = f"SATELLITE:{req.sat_id}"
    raw_data = r.get(key)
    
    if not raw_data:
        return {"error": "Satellite not found"}
        
    obj_data = json.loads(raw_data)
    
    # Fuel check
    if obj_data['fuel'] <= 0:
        return {"error": "Out of fuel!"}

    # Current state
    state = np.array([obj_data['x'], obj_data['y'], obj_data['z'], 
                      obj_data['vx'], obj_data['vy'], obj_data['vz']])
    
    # Maneuver lagao
    new_state = apply_maneuver(state, req.dv_rtn)
    
    # Update and deduct fuel (! unit fuel lost on every 1 m/s burn)
    dv_mag = np.linalg.norm(req.dv_rtn)
    obj_data.update({
        "vx": new_state[3], "vy": new_state[4], "vz": new_state[5],
        "fuel": obj_data['fuel'] - (dv_mag * 1000) # Simple fuel logic
    })
    
    r.set(key, json.dumps(obj_data))
    return {"status": "Maneuver Applied", "new_fuel": obj_data['fuel']}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)