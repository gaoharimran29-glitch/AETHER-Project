"""
AETHER — Pass Predictor
Estimates the time until the next ground-station LOS window opens for a
satellite.  PS §5.4

Algorithm
---------
    1. Compute the satellite's orbital period T from |r|.
    2. Compute the angular separation between satellite and ground station.
    3. If the satellite is approaching (closing range), scale by orbit fraction.
    4. If receding, add remaining orbit to estimated next approach.
    5. Subtract a small buffer to ensure the prediction lands inside the window.

This is a simplified model suitable for near-circular LEO orbits, which is
the scope of the hackathon.
"""

import numpy as np

MU = 398600.4418   # km³/s²  (PS §3.2)


def estimate_next_pass(sat_pos, gs_pos, sat_vel) -> float:
    """
    Estimate seconds until the satellite is next visible from a ground station.

    Parameters
    ----------
    sat_pos : array-like (3,)   satellite ECI position (km)
    gs_pos  : array-like (3,)   ground station ECI position (km)
    sat_vel : array-like (3,)   satellite ECI velocity (km/s)

    Returns
    -------
    float   estimated wait time in seconds (>= 0)
    """
    sat_pos = np.asarray(sat_pos, dtype=float)
    gs_pos  = np.asarray(gs_pos,  dtype=float)
    sat_vel = np.asarray(sat_vel, dtype=float)

    r_mag = float(np.linalg.norm(sat_pos))
    if r_mag < 1e-9:
        return 0.0

    # Orbital period for near-circular orbit  T = 2π √(r³/µ)
    orbital_period = 2.0 * np.pi * np.sqrt(r_mag ** 3 / MU)

    gs_mag = float(np.linalg.norm(gs_pos))
    if gs_mag < 1e-9:
        return 0.0

    # Angular separation between satellite and GS (in 3-D ECI space)
    dot_val   = float(np.dot(sat_pos / r_mag, gs_pos / gs_mag))
    dot_val   = float(np.clip(dot_val, -1.0, 1.0))
    angle_sep = float(np.arccos(dot_val))   # radians

    # Approach indicator: negative radial velocity relative to GS → closing
    rel_pos = sat_pos - gs_pos
    is_approaching = float(np.dot(rel_pos, sat_vel)) < 0.0

    if is_approaching:
        # Estimate as fraction of orbit remaining to GS
        time_to_pass = (angle_sep / (2.0 * np.pi)) * orbital_period
    else:
        # Satellite is moving away; next pass after completing remaining arc
        remaining_angle = (2.0 * np.pi) - angle_sep
        time_to_pass    = (remaining_angle / (2.0 * np.pi)) * orbital_period

    # Small buffer: open window ~30 s before the pass midpoint
    _BUFFER_S = 30.0
    return max(0.0, time_to_pass - _BUFFER_S)