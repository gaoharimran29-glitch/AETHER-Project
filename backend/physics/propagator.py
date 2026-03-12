import numpy as np

# Physical Constants
MU = 398600.4418
RE = 6378.137
J2 = 1.08263e-3

def get_j2_acceleration(state):
    """
    Input: [x, y, z, vx, vy, vz] (1D or 2D)
    Output: [ax, ay, az]
    """
    # Ensure state is 2D for consistent matrix math
    is_1d = len(state.shape) == 1
    if is_1d:
        working_state = state.reshape(1, -1)
    else:
        working_state = state
    
    r_vecs = working_state[:, 0:3]
    r_mags = np.linalg.norm(r_vecs, axis=1)[:, np.newaxis]
    z = r_vecs[:, 2][:, np.newaxis]
    
    # 1. Point Mass Gravity
    a_grav = -MU * r_vecs / r_mags**3
    
    # 2. J2 Perturbation (Equation 3.2 logic)
    factor = (1.5 * J2 * MU * RE**2) / r_mags**5
    
    z_sq_r_sq = (z**2 / r_mags**2)
    
    jx = r_vecs[:, 0][:, np.newaxis] * (5 * z_sq_r_sq - 1)
    jy = r_vecs[:, 1][:, np.newaxis] * (5 * z_sq_r_sq - 1)
    jz = r_vecs[:, 2][:, np.newaxis] * (5 * z_sq_r_sq - 3)
    
    a_j2 = factor * np.hstack([jx, jy, jz])
    
    total_a = a_grav + a_j2
    
    return total_a[0] if is_1d else total_a

def state_derivative(state, t=None):
    """
    Calculates ds/dt = [v, a]
    state: [x, y, z, vx, vy, vz]
    """
    # Important: Ensure it handles 1D arrays for RK4
    v_vec = state[3:6]
    a_vec = get_j2_acceleration(state)
    
    # Concatenate velocity and acceleration to get 6-element derivative
    return np.array([v_vec[0], v_vec[1], v_vec[2], a_vec[0], a_vec[1], a_vec[2]])