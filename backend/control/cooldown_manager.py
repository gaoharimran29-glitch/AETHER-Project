COOLDOWN_TIME = 600.0   # seconds between burns  (PS §5.1)


def can_burn(obj: dict, current_sim_time: float) -> bool:
    """
    Returns True if the satellite is allowed to fire its thruster.

    Parameters
    ----------
    obj              : satellite dict from Redis
    current_sim_time : float — current ELAPSED_SIM_TIME (simulation clock)

    Checks
    ------
    1. Fuel > 0
    2. At least COOLDOWN_TIME seconds have elapsed since last burn
       (measured on the SIMULATION clock, not wall clock — critical for
        fast-forward tick tests  PS §5.1)
    """
    # 1. Fuel check
    if float(obj.get("fuel", 0.0)) <= 0.0:
        return False

    # 2. Cooldown check on simulation clock
    last_burn_sim = float(obj.get("last_burn_sim_time", -(COOLDOWN_TIME + 1.0)))
    return (current_sim_time - last_burn_sim) >= COOLDOWN_TIME
