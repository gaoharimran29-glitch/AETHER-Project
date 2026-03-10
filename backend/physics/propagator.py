import numpy as np

# Constants from Problem Statement
MU = 398600.4418  # km^3/s^2
RE = 6378.137     # km
J2 = 1.08263e-3   # Earth's equatorial bulge constant

def get_j2_acceleration(r_vec):
    """
    Calculates the acceleration due to Earth's gravity + J2 Perturbation.
    r_vec: [x, y, z] in km
    """
    r = np.linalg.norm(r_vec)
    z = r_vec[2]
    
    # Standard Gravity (Point Mass)
    a_grav = -MU * r_vec / r**3
    
    # J2 Perturbation Logic
    factor = (1.5 * J2 * MU * RE**2) / r**5
    
    # Equation 3.2 logic
    jx = r_vec[0] * (5 * (z**2 / r**2) - 1)
    jy = r_vec[1] * (5 * (z**2 / r**2) - 1)
    jz = r_vec[2] * (5 * (z**2 / r**2) - 3)
    
    a_j2 = factor * np.array([jx, jy, jz])
    
    return a_grav + a_j2

def state_derivative(state):
    """
    Calculates the derivative of the state [x, y, z, vx, vy, vz].
    Returns [vx, vy, vz, ax, ay, az].
    """
    r_vec = state[0:3]
    v_vec = state[3:6]
    
    a_vec = get_j2_acceleration(r_vec)
    
    return np.concatenate([v_vec, a_vec])