import numpy as np

from maneuver.maneuver_planner import apply_maneuver
from conjunction.tca_solver import find_tca
from conjunction.collision_probability import calculate_risk


# candidate burn magnitudes (km/s)
DV_LEVELS = [0.001, 0.003, 0.005, 0.01]

# RTN directions
RTN_DIRECTIONS = [
    np.array([1,0,0]),   # radial +
    np.array([-1,0,0]),  # radial -
    np.array([0,1,0]),   # along-track +
    np.array([0,-1,0]),  # along-track -
    np.array([0,0,1]),   # normal +
    np.array([0,0,-1])   # normal -
]


def evaluate_maneuver(sat_state, deb_state, dv_rtn):
    new_state = apply_maneuver(sat_state, dv_rtn)
    dist, tca = find_tca(new_state, deb_state)
    pc, severity = calculate_risk(dist)
    fuel_cost = np.linalg.norm(dv_rtn)

    # Scorig logic update:
    # 1. Agar distance threshold se kam hai, toh heavy penalty lagao
    # 2. Fuel efficiency tabhi dekho jab collision tal chuka ho
    if dist < 1.0: # 1km safety margin
        score = -1000 + dist 
    else:
        score = dist - (20 * fuel_cost) # Balanced score

    return {
        "score": score, "distance": dist, "tca": tca,
        "pc": pc, "severity": severity, "dv": dv_rtn
    }


def find_best_maneuver(sat_state, deb_state):

    best_solution = None
    best_score = -np.inf

    for direction in RTN_DIRECTIONS:

        for dv_mag in DV_LEVELS:

            dv_rtn = direction * dv_mag

            result = evaluate_maneuver(
                sat_state,
                deb_state,
                dv_rtn
            )

            if result["score"] > best_score:
                best_score = result["score"]
                best_solution = result

    return best_solution
