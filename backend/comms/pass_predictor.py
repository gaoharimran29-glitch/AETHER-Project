import numpy as np

# Constants
MU = 398600.4418  # km^3/s^2
EARTH_ROT_RATE = 7.2921159e-5  # rad/s

def estimate_next_pass(sat_pos, gs_pos, sat_vel):
    """
    Estimates time until the next LOS window.
    sat_pos: ECI position of satellite [x, y, z]
    gs_pos: ECI position of Ground Station [x, y, z]
    sat_vel: ECI velocity of satellite [vx, vy, vz]
    """
    sat_pos = np.asarray(sat_pos)
    gs_pos = np.asarray(gs_pos)
    sat_vel = np.asarray(sat_vel)

    # 1. Calculate Orbital Period (T = 2*pi * sqrt(a^3/mu))
    r_mag = np.linalg.norm(sat_pos)
    # Assuming near-circular orbit for hackathon scale
    orbital_period = 2 * np.pi * np.sqrt(r_mag**3 / MU)

    # 2. Calculate Angular Distance
    u_sat = sat_pos / r_mag
    u_gs = gs_pos / np.linalg.norm(gs_pos)
    
    dot_product = np.clip(np.dot(u_sat, u_gs), -1.0, 1.0)
    angle_sep = np.arccos(dot_product)  # Radians mein distance

    # 3. Determine if Approaching or Receding
    # Relative velocity vector direction check
    rel_pos = sat_pos - gs_pos
    # If a radial velocity is negative that means satellite is coming closer
    is_approaching = np.dot(rel_pos, sat_vel) < 0

    if is_approaching:
        # Time = (Angular Distance / Total Angular Velocity)
        # Simplified: Fraction of orbit
        time_to_pass = (angle_sep / (2 * np.pi)) * orbital_period
    else:
        # If receeding , then wait for next orbit
        # Remaining orbit + distance to GS
        time_to_pass = ((2 * np.pi - angle_sep) / (2 * np.pi)) * orbital_period

    # 4. Buffering
    return max(0.0, time_to_pass - 10.0)