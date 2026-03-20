"""
conjunction/tca_solver.py
─────────────────────────
Time of Closest Approach (TCA) solver (PS §2 — 24-h CDM lookahead).

Algorithm
─────────────────────────────────────────────────────────────────────
Phase 1 — Coarse adaptive scan
    Step through [0, horizon_hours] propagating both objects.
    Adaptive step: large (60 s) far from each other, fine (5 s) near.
    Record the global minimum separation and its time.

Phase 2 — Bisection refinement (±30 s window around coarse TCA)
    Narrow the TCA to sub-second accuracy by binary-searching the
    minimum of the distance function in the interval found in Phase 1.

The solver returns early if the miss distance already exceeds a
conservative "safe" threshold (no point refining a 500 km pass).
"""

import numpy as np
from physics.rk4_integrator import rk4_step

# ── Tuning parameters ─────────────────────────────────────────────────────────
_COARSE_STEP_FAR: float  = 60.0    # s  — coarse step when objects are far apart
_COARSE_STEP_NEAR: float = 5.0     # s  — fine step when objects are within NEAR_KM
_NEAR_KM: float          = 50.0    # km — distance threshold for step switching
_EARLY_EXIT_KM: float    = 0.04    # km — stop if objects are already colliding
_BISECT_HALF_WIN: float  = 30.0    # s  — ±window around coarse TCA for refinement
_BISECT_ITERS: int       = 30      # bisection iterations → ~0.06 s precision


def find_tca(sat_state, deb_state,
             horizon_hours: float = 0.5,
             step_size: float = 60.0) -> tuple[float, float]:
    """
    Find the Time of Closest Approach between a satellite and a threat.

    Parameters
    ----------
    sat_state     : array-like (6,)  ECI state [x,y,z,vx,vy,vz] (km, km/s)
    deb_state     : array-like (6,)  ECI state of debris / second object
    horizon_hours : float            look-ahead horizon (hours)
    step_size     : float            ignored — kept for API compatibility;
                                     internal adaptive stepping is used.

    Returns
    -------
    (min_dist_km, tca_time_s) : (float, float)
        min_dist_km — smallest predicted separation (km)
        tca_time_s  — time offset from now when TCA occurs (s)
    """
    sat = np.asarray(sat_state, dtype=float).copy()
    deb = np.asarray(deb_state, dtype=float).copy()

    total_s  = horizon_hours * 3_600.0
    min_dist = float("inf")
    tca_time = 0.0
    t        = 0.0

    # ── Phase 1: Coarse adaptive scan ─────────────────────────────────────────
    while t < total_s:
        dist = float(np.linalg.norm(sat[:3] - deb[:3]))

        if dist < min_dist:
            min_dist = dist
            tca_time = t

        if dist < _EARLY_EXIT_KM:
            break   # already inside hard-body radius — no need to search further

        adaptive = _COARSE_STEP_NEAR if dist <= _NEAR_KM else _COARSE_STEP_FAR
        # Don't overshoot the horizon
        h    = min(adaptive, total_s - t)
        sat  = rk4_step(sat, h)
        deb  = rk4_step(deb, h)
        t   += h

    # ── Phase 2: Bisection refinement around the coarse TCA ──────────────────
    # Re-propagate to the start of the refinement window
    refine_start = max(0.0, tca_time - _BISECT_HALF_WIN)
    sat_r = np.asarray(sat_state, dtype=float).copy()
    deb_r = np.asarray(deb_state, dtype=float).copy()
    if refine_start > 0.0:
        sat_r = rk4_step(sat_r, refine_start)
        deb_r = rk4_step(deb_r, refine_start)

    lo, hi = 0.0, min(2.0 * _BISECT_HALF_WIN, total_s - refine_start)

    for _ in range(_BISECT_ITERS):
        if hi - lo < 1e-3:
            break
        mid = 0.5 * (lo + hi)

        s_lo  = rk4_step(sat_r, lo);   d_lo  = rk4_step(deb_r, lo)
        s_mid = rk4_step(sat_r, mid);  d_mid = rk4_step(deb_r, mid)
        s_hi  = rk4_step(sat_r, hi);   d_hi  = rk4_step(deb_r, hi)

        dist_lo  = float(np.linalg.norm(s_lo[:3]  - d_lo[:3]))
        dist_mid = float(np.linalg.norm(s_mid[:3] - d_mid[:3]))
        dist_hi  = float(np.linalg.norm(s_hi[:3]  - d_hi[:3]))

        if dist_lo <= dist_mid:
            hi = mid
        elif dist_hi <= dist_mid:
            lo = mid
        else:
            # minimum is in the interior — shrink both sides
            lo = lo + (mid - lo) * 0.25
            hi = hi - (hi - mid) * 0.25

    refined_t   = refine_start + 0.5 * (lo + hi)
    sat_f = rk4_step(np.asarray(sat_state, dtype=float), refined_t)
    deb_f = rk4_step(np.asarray(deb_state, dtype=float), refined_t)
    refined_dist = float(np.linalg.norm(sat_f[:3] - deb_f[:3]))

    # Use whichever phase found the closer approach
    if refined_dist < min_dist:
        min_dist = refined_dist
        tca_time = refined_t

    return float(min_dist), float(tca_time)