from datetime import datetime

COOLDOWN_TIME = 600.0  # 10 minutes

def can_burn(last_burn_str, current_time_numeric):
    """
    last_burn_str: ISO format string from Redis or None
    current_time_numeric: float (time.time())
    """
    if not last_burn_str:
        return True

    try:
        # Convert ISO string back to timestamp
        last_burn_dt = datetime.fromisoformat(last_burn_str)
        last_burn_ts = last_burn_dt.timestamp()
        
        return (current_time_numeric - last_burn_ts) >= COOLDOWN_TIME
    except Exception:
        # If parsing fails, stay safe and allow burn or log error
        return True