import numpy as np

# Standard deviation for debris/satellite position uncertainty
SIGMA_KM = 0.05  # 50 meters

def calculate_risk(distance_km):
    distance_km = float(distance_km)
    
    # 2D Gaussian approximation for collision probability
    # Pc = exp(-d^2 / (2 * sigma^2)) 
    pc = np.exp(-(distance_km**2) / (2 * (SIGMA_KM**2)))

    # Hackathon-Specific Severity Levels
    # Critical threshold typically starts at 1e-4 in real space ops, 
    # but for hackathons, we use tighter bounds.
    if distance_km < 0.1 or pc > 0.1:
        severity = "CRITICAL"
    elif distance_km < 0.5 or pc > 0.01:
        severity = "WARNING"
    else:
        severity = "SAFE"

    return float(pc), severity