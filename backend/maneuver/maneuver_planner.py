import numpy as np

MAX_BURN = 0.015 # 15 m/s limit

def apply_maneuver(state, dv_rtn):
    state = np.asarray(state, dtype=float)
    r_vec, v_vec = state[:3], state[3:6]
    r_norm = np.linalg.norm(r_vec)
    
    # RTN Frame Unit Vectors
    u_r = r_vec / r_norm  # Radial
    h_vec = np.cross(r_vec, v_vec)
    u_n = h_vec / np.linalg.norm(h_vec) # Normal
    u_t = np.cross(u_n, u_r) # Tangential (Prograde)
    
    # RTN to ECI
    dv_eci = dv_rtn[0]*u_r + dv_rtn[1]*u_t + dv_rtn[2]*u_n
    
    # Rule Check: Truncate to Max Allowed Burn
    mag = np.linalg.norm(dv_eci)
    if mag > MAX_BURN:
        dv_eci = (dv_eci / mag) * MAX_BURN
        
    return np.concatenate([r_vec, v_vec + dv_eci])

def send_to_graveyard(state):
    # Prograde burn to increase semi-major axis (Standard graveyard move)
    return apply_maneuver(state, [0.0, 0.015, 0.0])