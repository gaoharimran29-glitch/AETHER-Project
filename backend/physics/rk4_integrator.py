"""
physics/rk4_integrator.py
─────────────────────────
Classic 4th-order Runge-Kutta integrator for orbital propagation (PS §3.2).

Sub-steps every 5 s guarantee numerical stability across coarse tick sizes
(e.g. 3600-s fast-forward, PS §4.3) while keeping per-step cost low.
"""

import numpy as np
from physics.propagator import state_derivative

# Maximum internal sub-step in seconds.
# 5 s is conservative for LEO J2 dynamics (~90-min period).
_MAX_SUBSTEP: float = 5.0


def rk4_step(state: np.ndarray, dt: float) -> np.ndarray:
    """
    Propagate a 6-DOF state vector forward by dt seconds using RK4.

    The integration is split into ceil(dt / _MAX_SUBSTEP) sub-steps so
    accuracy is preserved even for large tick values.

    Parameters
    ----------
    state : ndarray (6,)  [x, y, z, vx, vy, vz]  (km, km/s)
    dt    : float         total propagation interval (s); must be ≥ 0

    Returns
    -------
    ndarray (6,)  propagated state
    """
    if dt <= 0.0:
        return np.asarray(state, dtype=float).copy()

    n_steps = max(1, int(np.ceil(abs(dt) / _MAX_SUBSTEP)))
    h       = dt / n_steps
    s       = np.asarray(state, dtype=float).copy()

    for _ in range(n_steps):
        k1 = state_derivative(s)
        k2 = state_derivative(s + 0.5 * h * k1)
        k3 = state_derivative(s + 0.5 * h * k2)
        k4 = state_derivative(s + h * k3)
        s  = s + (h / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4)

    return s