import logging
import numpy as np

from maneuver.maneuver_planner import apply_maneuver
from conjunction.tca_solver    import find_tca
from conjunction.collision_probability import calculate_risk

logger = logging.getLogger("AETHER.fleet_optimizer")

# Candidate burn magnitudes (km/s)  — includes full MAX_DV  (PS §5.1)
DV_LEVELS = [0.001, 0.005, 0.01, 0.015]

# RTN directions  (PS §5.3)
RTN_DIRECTIONS = [
    np.array([ 1,  0,  0]),   # radial +
    np.array([-1,  0,  0]),   # radial -
    np.array([ 0,  1,  0]),   # along-track + (prograde)
    np.array([ 0, -1,  0]),   # along-track - (retrograde)
    np.array([ 0,  0,  1]),   # normal +
    np.array([ 0,  0, -1]),   # normal -
]


def evaluate_maneuver(sat_state, deb_state, dv_rtn):
    """
    Score a candidate RTN burn.
    Higher score = better maneuver.
    Penalises proximity heavily; rewards distance while penalising fuel cost.
    """
    try:
        new_state    = apply_maneuver(sat_state, dv_rtn)
        dist, tca    = find_tca(new_state, deb_state)
        pc, severity = calculate_risk(dist)
        fuel_cost    = float(np.linalg.norm(dv_rtn))

        if dist < 1.0:
            score = -1000 + dist * 100     # heavy penalty for near-miss
        else:
            score = dist - 50 * fuel_cost  # reward separation, penalise fuel

        return {
            "score":    score,
            "distance": dist,
            "tca":      tca,
            "pc":       pc,
            "severity": severity,
            "dv":       dv_rtn,
        }
    except Exception as e:
        logger.debug(f"evaluate_maneuver error: {e}")
        return {"score": -np.inf}


def find_best_maneuver(sat_state, deb_state):
    """
    Brute-force search over 6 RTN directions × 4 DV levels (24 candidates).
    Returns the highest-scoring maneuver dict, or None if all fail.
    """
    best_solution = None
    best_score    = -np.inf
    n_candidates  = len(RTN_DIRECTIONS) * len(DV_LEVELS)

    logger.debug(f"Optimizer: testing {n_candidates} maneuver candidates")

    for direction in RTN_DIRECTIONS:
        for dv_mag in DV_LEVELS:
            dv_rtn = (direction * dv_mag).tolist()
            result = evaluate_maneuver(sat_state, deb_state, dv_rtn)
            if result["score"] > best_score:
                best_score    = result["score"]
                best_solution = result

    if best_solution:
        logger.debug(
            f"Optimizer: best dist={best_solution['distance']:.2f} km  "
            f"dv={np.linalg.norm(best_solution['dv'])*1000:.1f} m/s"
        )

    return best_solution
