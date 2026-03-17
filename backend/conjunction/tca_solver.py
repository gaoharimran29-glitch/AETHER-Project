import numpy as np
from physics.rk4_integrator import rk4_step

def find_tca(sat_state, deb_state, horizon_hours=0.5, step_size=60):
    sat = np.asarray(sat_state, dtype=float).copy()
    deb = np.asarray(deb_state, dtype=float).copy()

    min_dist = float("inf")
    tca_time = 0
    total_seconds = int(horizon_hours * 3600)
    
    current_time = 0
    # Phase 1: Coarse Search
    while current_time < total_seconds:
        rel = sat[:3] - deb[:3]
        dist = np.linalg.norm(rel)

        if dist < min_dist:
            min_dist = dist
            tca_time = current_time

        if dist < 0.05: # 50 meters
            break

        # Adaptive Step Optimization
        if dist > 50:
            adaptive_step = 60 # Big jumps
        else:
            adaptive_step = 5  # Refine near potential collision
            
        sat = rk4_step(sat, adaptive_step)
        deb = rk4_step(deb, adaptive_step)
        current_time += adaptive_step

    return float(min_dist), float(tca_time)