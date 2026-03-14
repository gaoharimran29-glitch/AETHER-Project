LATENCY = 10  # seconds


def enforce_latency(current_time, burn_time):
    """
    Burn cannot happen earlier than current_time + 10 sec
    """

    min_time = current_time + LATENCY

    if burn_time < min_time:
        burn_time = min_time

    return burn_time