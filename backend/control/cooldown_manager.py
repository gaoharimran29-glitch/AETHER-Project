COOLDOWN_TIME = 600  # seconds


def can_burn(last_burn_time, current_time):
    """
    Check if thruster cooldown completed
    """

    if last_burn_time is None:
        return True

    if (current_time - last_burn_time) >= COOLDOWN_TIME:
        return True

    return False