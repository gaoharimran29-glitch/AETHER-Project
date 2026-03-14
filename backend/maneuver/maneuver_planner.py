import numpy as np

MAX_BURN = 0.015  # km/s (15 m/s)


def apply_maneuver(state, dv_rtn):

    state = np.asarray(state, dtype=float)
    dv_rtn = np.asarray(dv_rtn, dtype=float)

    r_vec = state[:3]
    v_vec = state[3:6]

    r_norm = np.linalg.norm(r_vec)
    if r_norm < 1e-9:
        raise ValueError("Invalid position vector")

    # RTN frame
    u_r = r_vec / r_norm

    h_vec = np.cross(r_vec, v_vec)
    h_norm = np.linalg.norm(h_vec)

    if h_norm < 1e-9:
        raise ValueError("Invalid angular momentum vector")

    u_n = h_vec / h_norm
    u_t = np.cross(u_n, u_r)

    # Convert burn to ECI
    dv_eci = dv_rtn[0]*u_r + dv_rtn[1]*u_t + dv_rtn[2]*u_n

    burn_mag = np.linalg.norm(dv_eci)

    # enforce burn limit
    if burn_mag > MAX_BURN:
        dv_eci = dv_eci * (MAX_BURN / burn_mag)

    new_velocity = v_vec + dv_eci

    return np.concatenate([r_vec, new_velocity])

def send_to_graveyard(state):

    dv = [0.0, 0.0, 0.02]  # small radial raise

    return apply_maneuver(state, dv)