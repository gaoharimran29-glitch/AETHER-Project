"""
physics/propagator.py
─────────────────────
J2-perturbed gravitational propagator (PS §3.2).

Equations of motion
───────────────────
  d²r/dt² = -µ/|r|³ · r  +  a_J2

  a_J2 = (3/2)·J2·µ·RE²/|r|⁵ · [
      x(5z²/|r|²-1),
      y(5z²/|r|²-1),
      z(5z²/|r|²-3)   ← note the -3 on the z term (PS §3.2)
  ]

Constants (PS §3.2)
───────────────────
  µ  = 398600.4418  km³/s²
  RE = 6378.137     km
  J2 = 1.08263e-3
"""

import numpy as np

MU: float  = 398600.4418   # km³/s²
RE: float  = 6378.137      # km
J2: float  = 1.08263e-3
_EPS: float = 1e-9          # guard against r → 0


def get_j2_acceleration(state: np.ndarray) -> np.ndarray:
    """
    Compute J2-perturbed acceleration for one or many states.

    Parameters
    ----------
    state : ndarray  shape (6,) or (N, 6)
        [x, y, z, vx, vy, vz]  (km, km/s)

    Returns
    -------
    ndarray  shape (3,) or (N, 3)  — acceleration in km/s²
    """
    is_1d = (state.ndim == 1)
    if is_1d:
        state = state.reshape(1, -1)

    r = state[:, :3]          # (N, 3)
    x = r[:, 0:1]             # keep dims for broadcasting
    y = r[:, 1:2]
    z = r[:, 2:3]

    r_sq  = np.einsum("ij,ij->i", r, r).reshape(-1, 1)  # |r|²
    r_mag = np.sqrt(np.maximum(r_sq, _EPS))              # |r|
    r3    = r_mag ** 3
    r5    = r_mag ** 5

    # Point-mass gravity
    a_grav = -MU * r / r3

    # J2 perturbation (PS §3.2)
    z2_r2  = z ** 2 / r_sq                               # z²/|r|²
    factor = (1.5 * J2 * MU * RE ** 2) / r5

    a_j2 = factor * np.hstack([
        x * (5.0 * z2_r2 - 1.0),
        y * (5.0 * z2_r2 - 1.0),
        z * (5.0 * z2_r2 - 3.0),   # -3, NOT -1  (PS §3.2)
    ])

    a_total = a_grav + a_j2
    return a_total[0] if is_1d else a_total


def state_derivative(state: np.ndarray, t: float = 0.0) -> np.ndarray:
    """
    First-order ODE form for the RK4 integrator.

    Parameters
    ----------
    state : ndarray (6,)   [x, y, z, vx, vy, vz]
    t     : float          unused (autonomous system; kept for signature compat)

    Returns
    -------
    ndarray (6,)  [vx, vy, vz, ax, ay, az]
    """
    return np.concatenate((state[3:6], get_j2_acceleration(state)))