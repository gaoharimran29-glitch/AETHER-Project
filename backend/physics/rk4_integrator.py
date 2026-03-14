import numpy as np
from .propagator import state_derivative


def rk4_step(state, dt):

    state = np.asarray(state, dtype=float)

    k1 = state_derivative(state)
    k2 = state_derivative(state + 0.5 * dt * k1)
    k3 = state_derivative(state + 0.5 * dt * k2)
    k4 = state_derivative(state + dt * k3)

    new_state = state + (dt / 6.0) * (
        k1 + 2*k2 + 2*k3 + k4
    )

    return new_state