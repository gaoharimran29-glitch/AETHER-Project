"""
maneuver/maneuver_planner.py
────────────────────────────
RTN-frame maneuver application (PS §5.3).

RTN frame definition (PS §5.3)
───────────────────────────────
  R  (Radial)       : r̂  = r / |r|          — outward from Earth centre
  N  (Normal)       : n̂  = (r × v) / |r × v| — orbital angular momentum direction
  T  (Transverse)   : t̂  = n̂ × r̂            — completes right-hand system ≈ prograde

Burn limit  (PS §5.1): |∆v| ≤ 0.015 km/s (15 m/s) per individual burn.
"""

import numpy as np
import logging

logger = logging.getLogger("AETHER.maneuver_planner")

MAX_BURN: float = 0.015   # km/s  =  15 m/s  (PS §5.1)


def apply_maneuver(state: np.ndarray | list,
                   dv_rtn: np.ndarray | list) -> np.ndarray:
    """
    Apply an RTN delta-v to a 6-DOF ECI state vector.

    Parameters
    ----------
    state   : array-like (6,)  [x, y, z, vx, vy, vz]  (km, km/s)
    dv_rtn  : array-like (3,)  [dR, dT, dN]  in km/s

    Returns
    -------
    ndarray (6,)  updated state with new velocity
    """
    state  = np.asarray(state,  dtype=float).copy()
    dv_rtn = np.asarray(dv_rtn, dtype=float)

    r_vec = state[:3]
    v_vec = state[3:6]

    r_norm = np.linalg.norm(r_vec)
    v_norm = np.linalg.norm(v_vec)

    if r_norm < 1e-9 or v_norm < 1e-9:
        logger.error("apply_maneuver: degenerate state — r or v is zero.")
        return state

    # ── RTN unit vectors (PS §5.3) ────────────────────────────────────────────
    u_r = r_vec / r_norm                             # Radial (outward)
    h   = np.cross(r_vec, v_vec)
    h_norm = np.linalg.norm(h)
    if h_norm < 1e-9:
        logger.error("apply_maneuver: zero angular momentum (degenerate orbit).")
        return state
    u_n = h / h_norm                                 # Normal (orbit-plane ⊥)
    u_t = np.cross(u_n, u_r)                        # Transverse ≈ prograde
    # Note: cross(N, R) gives T in a right-hand RTN frame ✓

    # ── Rotate RTN → ECI ─────────────────────────────────────────────────────
    dv_eci = dv_rtn[0] * u_r + dv_rtn[1] * u_t + dv_rtn[2] * u_n

    # ── Hard cap at MAX_BURN (PS §5.1) ────────────────────────────────────────
    mag = np.linalg.norm(dv_eci)
    if mag > MAX_BURN + 1e-9:
        logger.warning(
            f"apply_maneuver: |∆v|={mag*1000:.2f} m/s > {MAX_BURN*1000:.0f} m/s — capped."
        )
        dv_eci = (dv_eci / mag) * MAX_BURN

    state[3:6] += dv_eci
    return state


def send_to_graveyard(state: np.ndarray | list) -> np.ndarray:
    """
    Execute a full-magnitude prograde burn to raise apogee into a
    graveyard / disposal orbit (PS §2 EOL requirement).

    Parameters
    ----------
    state : array-like (6,)  current ECI state

    Returns
    -------
    ndarray (6,)  state after disposal burn
    """
    # Maximum prograde (along-track) burn — most fuel-efficient SMA raise
    return apply_maneuver(state, [0.0, MAX_BURN, 0.0])