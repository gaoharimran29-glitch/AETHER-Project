import numpy as np

TOLERANCE_KM = 10.0


def is_outside_box(position, nominal_position):
    """
    Check if satellite drifted outside station keeping box
    """

    dist = np.linalg.norm(position - nominal_position)

    return dist > TOLERANCE_KM


def recovery_delta_v(position, nominal_position):
    """
    Simple recovery burn toward nominal slot
    """

    direction = nominal_position - position

    direction = direction / np.linalg.norm(direction)

    dv = 0.002 * direction  # small corrective burn

    return dv