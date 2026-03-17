import numpy as np

TOLERANCE_KM = 10.0  # From Hackathon Rules

def is_outside_box(current_pos, nominal_pos):
    dist = np.linalg.norm(np.array(current_pos) - np.array(nominal_pos))
    return dist > TOLERANCE_KM

def recovery_delta_v(current_state, nominal_pos):
    """
    current_state: full state [x, y, z, vx, vy, vz]
    nominal_pos: target position [x, y, z]
    """
    # Ensure numpy arrays
    current_state = np.array(current_state)
    pos = current_state[:3]
    
    # Target direction vector
    error_vec = np.array(nominal_pos) - pos
    distance = np.linalg.norm(error_vec)
    
    if distance < 0.5: 
        return [0.0, 0.0, 0.0]
    
    burn_mag = 0.001 
    direction = error_vec / distance
    
    # Velocity check (Avoiding the shape error)
    if len(current_state) >= 6:
        velocity_vec = current_state[3:6]
        # Dot product with velocity to see if we need to push prograde or retrograde
        is_prograde = np.dot(direction, velocity_vec) > 0
        dv_tangential = burn_mag if is_prograde else -burn_mag
    else:
        # Fallback if velocity not found
        dv_tangential = burn_mag

    # Return as RTN burn [radial, tangential, normal]
    return [0.0, float(dv_tangential), 0.0]