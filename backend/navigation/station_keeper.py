"""
navigation/station_keeper.py
────────────────────────────
Station-keeping logic (PS §5.2).

Station-Keeping Box
───────────────────
  A satellite is "nominal" when it is within TOLERANCE_KM = 10 km of
  its designated Nominal Orbital Slot (PS §5.2).

Recovery ΔV
───────────────────────────────────────────────────────────────────────
  The recovery burn is calculated in the RTN frame:
    • Radial  (R): proportional to cross-track position error component
    • Transverse (T): proportional to along-track position error component
    • Normal  (N): proportional to out-of-plane position error component

  The magnitude is scaled to the error distance, capped at MAX_RECOVERY_DV
  to comply with the 15 m/s per-burn limit (PS §5.1).

  A small minimum-distance guard avoids issuing burns when the satellite
  is already near-nominal.
"""

import numpy as np
import logging

logger = logging.getLogger("AETHER.station_keeper")

# PS §5.2 — station-keeping box radius
TOLERANCE_KM: float = 10.0

# Maximum correction burn magnitude (km/s).
# Set well below PS §5.1 MAX_DV (0.015) so the maneuver planner can cap it.
MAX_RECOVERY_DV: float = 0.010   # 10 m/s

# Don't issue a correction if error < this (satellite is essentially nominal)
MIN_ERROR_KM: float = 0.5


def is_outside_box(current_pos, nominal_pos) -> bool:
    """
    Return True if the satellite has drifted beyond the 10 km box (PS §5.2).

    Parameters
    ----------
    current_pos : array-like (3,)   current ECI position (km)
    nominal_pos : array-like (3,)   nominal slot ECI position (km)
    """
    dist = float(np.linalg.norm(
        np.asarray(current_pos, dtype=float) - np.asarray(nominal_pos, dtype=float)
    ))
    return dist > TOLERANCE_KM


def recovery_delta_v(current_state, nominal_pos) -> list[float]:
    """
    Compute a recovery ΔV in the RTN frame to return the satellite to its
    nominal slot (PS §5.2).

    The burn vector is proportional to the position error projected onto
    each RTN axis, scaled by a gain factor and capped at MAX_RECOVERY_DV.

    Parameters
    ----------
    current_state : array-like (6,)   [x, y, z, vx, vy, vz]  (km, km/s)
    nominal_pos   : array-like (3,)   nominal ECI position (km)

    Returns
    -------
    list[float]   [dR, dT, dN]  in km/s  (RTN frame)
    """
    state     = np.asarray(current_state, dtype=float)
    nom_pos   = np.asarray(nominal_pos,   dtype=float)

    r_vec = state[:3]
    v_vec = state[3:6]

    r_norm = float(np.linalg.norm(r_vec))
    v_norm = float(np.linalg.norm(v_vec))

    if r_norm < 1e-9 or v_norm < 1e-9:
        return [0.0, 0.0, 0.0]

    # Position error vector (ECI)
    error_eci  = nom_pos - r_vec
    error_dist = float(np.linalg.norm(error_eci))

    if error_dist < MIN_ERROR_KM:
        return [0.0, 0.0, 0.0]

    # ── Build RTN frame (same convention as maneuver_planner.py) ─────────────
    u_r = r_vec / r_norm
    h   = np.cross(r_vec, v_vec)
    h_n = float(np.linalg.norm(h))
    if h_n < 1e-9:
        return [0.0, 0.0, 0.0]
    u_n = h / h_n
    u_t = np.cross(u_n, u_r)   # Transverse ≈ prograde

    # Project error onto RTN axes
    dR = float(np.dot(error_eci, u_r))
    dT = float(np.dot(error_eci, u_t))
    dN = float(np.dot(error_eci, u_n))

    # Proportional gain: 1e-3 km/s per km error → 1 m/s per km (conservative)
    GAIN = 1e-3
    dv_rtn = np.array([dR * GAIN, dT * GAIN, dN * GAIN])

    # Cap magnitude at MAX_RECOVERY_DV
    mag = float(np.linalg.norm(dv_rtn))
    if mag > MAX_RECOVERY_DV:
        dv_rtn = (dv_rtn / mag) * MAX_RECOVERY_DV

    logger.debug(
        "Recovery ΔV: error=%.2f km  dv=[%.5f, %.5f, %.5f] km/s",
        error_dist, *dv_rtn.tolist(),
    )
    return dv_rtn.tolist()