import numpy as np

TOLERANCE_KM = 10.0  # From Hackathon Rules

def is_outside_box(current_pos, nominal_pos):
    """
    Checks if satellite is outside the allowed 10km radius.
    """
    dist = np.linalg.norm(np.array(current_pos) - np.array(nominal_pos))
    return dist > TOLERANCE_KM

def recovery_delta_v(current_state, nominal_state):
    """
    Calculates a small burn to push the satellite back to its slot.
    """
    pos = np.array(current_state[:3])
    nom_pos = np.array(nominal_state[:3])
    
    # Vector pointing from current position to nominal slot
    error_vec = nom_pos - pos
    distance = np.linalg.norm(error_vec)
    
    if distance < 0.5: # Already very close
        return [0.0, 0.0, 0.0]
    
    # Small corrective burn: don't overcorrect!
    # 1 m/s burn (0.001 km/s) is usually enough for station keeping
    burn_mag = 0.001 
    direction = error_vec / distance
    
    # Return as [dv_radial, dv_tangential, dv_normal]
    # Simplified: We use the direction vector to get ECI components
    dv_eci = direction * burn_mag
    
    # To maintain consistency with apply_maneuver, we'll convert to a small RTN burn
    # Most station keeping is Tangential (Prograde/Retrograde)
    return [0.0, burn_mag, 0.0] if np.dot(direction, current_state[3:6]) > 0 else [0.0, -burn_mag, 0.0]