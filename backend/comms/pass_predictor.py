import numpy as np

EARTH_ROT_RATE = 7.2921159e-5  # rad/s


def estimate_next_pass(sat_pos, gs_pos):

    sat_norm = sat_pos / np.linalg.norm(sat_pos)
    gs_norm = gs_pos / np.linalg.norm(gs_pos)

    angle = np.arccos(np.clip(np.dot(sat_norm, gs_norm), -1, 1))

    orbital_period = 5400  # approx 90 minutes

    time_to_pass = (angle / (2*np.pi)) * orbital_period

    return time_to_pass
