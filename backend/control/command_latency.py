LATENCY = 10.0   # seconds  (PS §5.4 — hardcoded signal delay)


def enforce_latency(current_sim_time: float,
                    requested_burn_time: float) -> float:
    """
    Ensures a burn is never scheduled earlier than current_sim_time + LATENCY.

    Parameters
    ----------
    current_sim_time     : float  ELAPSED_SIM_TIME at scheduling moment
    requested_burn_time  : float  desired burn time (same sim-time units)

    Returns
    -------
    float  — the earliest legal burn time (>= current + LATENCY)
    """
    min_allowed = current_sim_time + LATENCY
    return max(requested_burn_time, min_allowed)
