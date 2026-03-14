from datetime import datetime

COOLDOWN_TIME = 600.0  # 10 minutes

def can_burn(obj, current_time_numeric):
    # 1. Check Fuel First
    if obj.get("fuel", 0) <= 0:
        return False
    
    # 2. Check Cooldown Time
    last_burn_str = obj.get("last_maneuver")
    if not last_burn_str:
        return True

    try:
        last_burn_dt = datetime.fromisoformat(last_burn_str)
        last_burn_ts = last_burn_dt.timestamp()
        return (current_time_numeric - last_burn_ts) >= COOLDOWN_TIME
    except:
        return True