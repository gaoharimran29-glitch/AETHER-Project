import numpy as np

def apply_maneuver(state, dv_rtn):
    """
    state: [x, y, z, vx, vy, vz]
    dv_rtn: [dv_r, dv_t, dv_n] (Dhakka in km/s)
    """
    r_vec = state[0:3]
    v_vec = state[3:6]
    
    # 1. Finding RTN Unit Vectors
    u_r = r_vec / np.linalg.norm(r_vec)
    h_vec = np.cross(r_vec, v_vec)
    u_n = h_vec / np.linalg.norm(h_vec)
    u_t = np.cross(u_n, u_r)
    
    # 2. Convert RTN Delta-V In ECI
    dv_eci = dv_rtn[0]*u_r + dv_rtn[1]*u_t + dv_rtn[2]*u_n
    
    # 3. Update new velocity
    new_v = v_vec + dv_eci
    new_state = np.concatenate([r_vec, new_v])
    
    return new_state