from fastapi import FastAPI, BackgroundTasks
from pydantic import BaseModel
from typing import List, Dict
import redis
import json

app = FastAPI()

# Redis Connection
# Docker mein 'redis' host use hoga, local testing mein 'localhost'
r = redis.Redis(host='localhost', port=6379, decode_responses=True)

# Data Models (Jo PDF mein diya hai)
class Vector3(BaseModel):
    x: float
    y: float
    z: float

class SpaceObject(BaseModel):
    id: str
    type: str # 'SATELLITE' or 'DEBRIS'
    r: Vector3
    v: Vector3

class TelemetryRequest(BaseModel):
    timestamp: str
    objects: List[SpaceObject]

@app.post("/api/telemetry")
async def ingest_telemetry(data: TelemetryRequest, background_tasks: BackgroundTasks):
    # 1. Sabse pehle Redis mein data save karo
    for obj in data.objects:
        obj_data = {
            "id": obj.id,
            "type": obj.type,
            "x": obj.r.x, "y": obj.r.y, "z": obj.r.z,
            "vx": obj.v.x, "vy": obj.v.y, "vz": obj.v.z,
            "fuel": 50.0 if obj.type == "SATELLITE" else 0.0, # Initial fuel
            "last_update": data.timestamp
        }
        # Redis key format: 'SATELLITE:SAT-01' or 'DEBRIS:DEB-01'
        r.set(f"{obj.type}:{obj.id}", json.dumps(obj_data))

    # 2. Background task chalao taaki API turant response de sake (O(N) efficiency)
    # background_tasks.add_task(run_collision_check) 

    return {
        "status": "ACK",
        "processed_count": len(data.objects),
        "active_cdm_warnings": 0 # Abhi ke liye 0
    }

import json
import numpy as np
from physics.rk4_integrator import rk4_step

# API to advance simulation by dt seconds
@app.post("/api/simulate/step")
async def simulate_step(dt: float = 1.0):
    # 1. Redis se saari keys (Satellites aur Debris) uthao
    keys = r.keys("SATELLITE:*") + r.keys("DEBRIS:*")
    
    updated_count = 0
    for key in keys:
        # 2. Data fetch aur parse karo
        obj_data = json.loads(r.get(key))
        
        # Current state vector [x, y, z, vx, vy, vz]
        current_state = np.array([
            obj_data['x'], obj_data['y'], obj_data['z'],
            obj_data['vx'], obj_data['vy'], obj_data['vz']
        ])
        
        # 3. RK4 Physics Engine chalao
        new_state = rk4_step(current_state, dt)
        
        # 4. Data update karo
        obj_data.update({
            "x": new_state[0], "y": new_state[1], "z": new_state[2],
            "vx": new_state[3], "vy": new_state[4], "vz": new_state[5]
        })
        
        # 5. Wapas Redis mein save karo
        r.set(key, json.dumps(obj_data))
        updated_count += 1

    return {"status": "OK", "updated_objects": updated_count, "dt": dt}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)