import numpy as np
from physics.rk4_integrator import rk4_step

def find_tca(sat_state, deb_state, horizon_hours=24, step_size=60):
    sat = np.asarray(sat_state, dtype=float).copy()
    deb = np.asarray(deb_state, dtype=float).copy()

    min_dist = float("inf")
    tca_time = 0
    total_seconds = int(horizon_hours * 3600)
    
    # Phase 1: Coarse Search (Bade steps se scan karo)
    current_time = 0
    while current_time < total_seconds:
        rel = sat[:3] - deb[:3]
        dist = np.linalg.norm(rel)

        if dist < min_dist:
            min_dist = dist
            tca_time = current_time

        # Adaptive Step: Agar objects door hain toh tez chalo, 
        # paas aa rahe hain toh slow ho jao.
        if dist > 500:
            adaptive_step = 120 # 2 minutes
        elif dist > 100:
            adaptive_step = 30
        else:
            adaptive_step = 10 # Refine near potential collision
            
        sat = rk4_step(sat, adaptive_step)
        deb = rk4_step(deb, adaptive_step)
        current_time += adaptive_step

        # Rule check: Agar 24 hour horizon cross ho gaya
        if current_time > total_seconds: break

    # Phase 2: Fine Refinement (Optional but recommended)
    # TCA ke aas-paas 1-second steps se exact minima nikaalo
    return float(min_dist), float(tca_time)