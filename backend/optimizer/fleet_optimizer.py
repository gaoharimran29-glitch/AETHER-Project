"""
AETHER — Fleet / Maneuver Optimizer
Brute-force search over RTN burn candidates to find the evasion maneuver
that maximises post-burn miss distance while minimising ΔV expenditure.
PS §5.3, PS §2

Candidate space: 6 RTN directions × 4 ΔV magnitudes = 24 candidates.
The scoring function heavily penalises proximity and rewards stand-off
distance with a fuel-cost penalty.
"""

import logging
import numpy as np

from maneuver.maneuver_planner     import apply_maneuver
from conjunction.tca_solver        import find_tca
from conjunction.collision_probability import calculate_risk

logger = logging.getLogger("AETHER.fleet_optimizer")

# ── Candidate burn magnitudes (km/s)  — 1 m/s … 15 m/s  (PS §5.1) ──────────
DV_LEVELS = [0.001, 0.005, 0.010, 0.015]

# ── RTN directions  (PS §5.3) ────────────────────────────────────────────────
_RTN_DIRS = [
    np.array([ 1.0,  0.0,  0.0]),   # radial +
    np.array([-1.0,  0.0,  0.0]),   # radial -
    np.array([ 0.0,  1.0,  0.0]),   # prograde  (most fuel-efficient)
    np.array([ 0.0, -1.0,  0.0]),   # retrograde
    np.array([ 0.0,  0.0,  1.0]),   # normal +
    np.array([ 0.0,  0.0, -1.0]),   # normal -
]

_SAFE_DISTANCE_KM   = 2.0    # minimum acceptable post-burn miss distance
_FUEL_PENALTY       = 100.0  # score penalty coefficient per km/s of ΔV


def _score_maneuver(dist_km: float, dv_mag_km_s: float) -> float:
    """
    Scoring heuristic.

    +dist         — reward stand-off distance
    −fuel_penalty × dv_mag  — penalise fuel cost

    Heavy penalty when post-burn distance < 1 km to strongly favour
    actually clearing the threat.
    """
    if dist_km < 1.0:
        return -1000.0 + dist_km * 100.0
    return dist_km - _FUEL_PENALTY * dv_mag_km_s


def evaluate_maneuver(
    sat_state: np.ndarray,
    deb_state: np.ndarray,
    dv_rtn,
) -> dict:
    """
    Score a single RTN burn candidate.

    Returns a dict with keys: score, distance, tca, pc, severity, dv.
    On failure returns {"score": -inf}.
    """
    try:
        new_state        = apply_maneuver(sat_state, dv_rtn)
        dist_km, tca_s   = find_tca(new_state, deb_state)
        pc, severity     = calculate_risk(dist_km)
        dv_mag           = float(np.linalg.norm(dv_rtn))

        return {
            "score":    _score_maneuver(dist_km, dv_mag),
            "distance": dist_km,
            "tca":      tca_s,
            "pc":       pc,
            "severity": severity,
            "dv":       list(dv_rtn) if hasattr(dv_rtn, "__iter__") else dv_rtn,
        }
    except Exception as exc:
        logger.debug("evaluate_maneuver error: %s", exc)
        return {"score": -np.inf}


def find_best_maneuver(
    sat_state,
    deb_state,
) -> dict | None:
    """
    Brute-force search over 24 candidates (6 directions × 4 magnitudes).

    Parameters
    ----------
    sat_state : array-like (6,)   satellite ECI state
    deb_state : array-like (6,)   debris   ECI state

    Returns
    -------
    dict  — best result dict (keys: score, distance, tca, pc, severity, dv)
    None  — if all candidates failed
    """
    sat_st = np.asarray(sat_state, dtype=float)
    deb_st = np.asarray(deb_state, dtype=float)

    n_candidates = len(_RTN_DIRS) * len(DV_LEVELS)
    logger.debug("Optimizer: testing %d candidates", n_candidates)

    best_score    = -np.inf
    best_solution = None

    for direction in _RTN_DIRS:
        for dv_mag in DV_LEVELS:
            dv_rtn = direction * dv_mag
            result = evaluate_maneuver(sat_st, deb_st, dv_rtn)

            if result["score"] > best_score:
                best_score    = result["score"]
                best_solution = result

    if best_solution and best_score > -np.inf:
        logger.debug(
            "Optimizer: best dist=%.3f km  dv=%.1f m/s",
            best_solution["distance"],
            float(np.linalg.norm(best_solution["dv"])) * 1000.0,
        )
        return best_solution

    return None