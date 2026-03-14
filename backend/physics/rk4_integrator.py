import numpy as np
from .propagator import state_derivative


def rk4_step(state, dt):
    n_steps = int(np.ceil(dt / 5.0))
    h = dt / n_steps
    curr_state = np.asarray(state, dtype=float)

    for _ in range(n_steps):
        k1 = state_derivative(curr_state)
        k2 = state_derivative(curr_state + 0.5 * h * k1)
        k3 = state_derivative(curr_state + 0.5 * h * k2)
        k4 = state_derivative(curr_state + h * k3)
        curr_state += (h / 6.0) * (k1 + 2*k2 + 2*k3 + k4)

    return curr_state