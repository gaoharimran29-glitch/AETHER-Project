import numpy as np
from physics.rk4_integrator import rk4_step


def find_tca(sat_state, deb_state, horizon_hours=24, step_size=30):

    sat = np.asarray(sat_state, dtype=float).copy()
    deb = np.asarray(deb_state, dtype=float).copy()

    min_dist = float("inf")
    tca_time = 0

    prev_dist = float("inf")

    total_steps = int((horizon_hours * 3600) / step_size)

    for step in range(total_steps):

        sat = rk4_step(sat, step_size)
        deb = rk4_step(deb, step_size)

        rel = sat[:3] - deb[:3]
        dist = np.linalg.norm(rel)

        if dist < min_dist:
            min_dist = dist
            tca_time = step * step_size

        # early exit optimization
        if dist > prev_dist and step > 10:
            break

        prev_dist = dist

    return float(min_dist), float(tca_time)