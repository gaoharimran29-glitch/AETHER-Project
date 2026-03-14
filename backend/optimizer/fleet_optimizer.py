import numpy as np

from maneuver.maneuver_planner import apply_maneuver
from conjunction.tca_solver import find_tca
from conjunction.collision_probability import calculate_risk

# candidate burn magnitudes (km/s)
DV_LEVELS = [0.001, 0.005, 0.01]

# RTN directions
RTN_DIRECTIONS = [
    np.array([1,0,0]),   # radial +
    np.array([-1,0,0]),  # radial -
    np.array([0,1,0]),   # along-track +
    np.array([0,-1,0]),  # along-track -
    np.array([0,0,1]),   # normal +
    np.array([0,0,-1])   # normal -
]

def evaluate_maneuver(sat_state, deb_state, dv_rtn):
    try:
        # Apply burn
        new_state = apply_maneuver(sat_state, dv_rtn)
        
        # TCA calculation
        dist, tca = find_tca(new_state, deb_state)
        
        # Risk assessment
        pc, severity = calculate_risk(dist)
        fuel_cost = np.linalg.norm(dv_rtn)

        # Scoring Logic
        if dist < 1.0: 
            score = -1000 + (dist * 100) # Penalty for closeness
        else:
            # Reward distance, penalize fuel
            score = dist - (50 * fuel_cost) 

        return {
            "score": score, "distance": dist, "tca": tca,
            "pc": pc, "severity": severity, "dv": dv_rtn
        }
    except Exception as e:
        print(f"Error in evaluate_maneuver: {e}")
        return {"score": -np.inf}

def find_best_maneuver(sat_state, deb_state):
    best_solution = None
    best_score = -np.inf

    print(f"FINDING BEST MANEUVER: Testing {len(RTN_DIRECTIONS) * len(DV_LEVELS)} combinations...")

    for direction in RTN_DIRECTIONS:
        for dv_mag in DV_LEVELS:
            dv_rtn = direction * dv_mag
            
            result = evaluate_maneuver(sat_state, deb_state, dv_rtn)

            if result["score"] > best_score:
                best_score = result["score"]
                best_solution = result
    
    if best_solution:
        print(f"DONE: Best Dist: {best_solution['distance']:.2f}km using DV: {best_solution['dv']}")
    
    return best_solution