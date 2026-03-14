LATENCY = 10.0  # seconds

def enforce_latency(current_time, requested_burn_time):
    """
    Ensures the burn is scheduled at least 10 seconds in the future
    to account for uplink delay.
    """
    min_allowed_time = current_time + LATENCY
    
    if requested_burn_time < min_allowed_time:
        return min_allowed_time
    
    return requested_burn_time