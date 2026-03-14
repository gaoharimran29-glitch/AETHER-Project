import numpy as np

MU = 398600.4418
RE = 6378.137
J2 = 1.08263e-3

EPS = 1e-9


def get_j2_acceleration(state):

    is_1d = state.ndim == 1

    if is_1d:
        state = state.reshape(1, -1)

    r = state[:, 0:3]

    x = r[:, 0:1]
    y = r[:, 1:2]
    z = r[:, 2:3]

    r_mag = np.linalg.norm(r, axis=1).reshape(-1, 1)
    r_mag = np.maximum(r_mag, EPS)

    # Point mass gravity
    a_grav = -MU * r / r_mag**3

    # J2 perturbation
    factor = 1.5 * J2 * MU * RE**2 / r_mag**5

    z2_r2 = (z**2) / r_mag**2

    ax = x * (5*z2_r2 - 1)
    ay = y * (5*z2_r2 - 1)
    az = z * (5*z2_r2 - 3)

    a_j2 = factor * np.hstack((ax, ay, az))

    a_total = a_grav + a_j2

    if is_1d:
        return a_total[0]

    return a_total


def state_derivative(state, t=None):

    r_dot = state[3:6]
    v_dot = get_j2_acceleration(state)

    return np.concatenate((r_dot, v_dot))