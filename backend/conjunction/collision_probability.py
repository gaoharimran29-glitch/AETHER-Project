import numpy as np

SIGMA_KM = 0.05  # 50 meters


def calculate_risk(distance_km):

    distance_km = float(distance_km)

    pc = np.exp(-(distance_km**2) / (2 * SIGMA_KM**2))

    if pc > 0.1:
        severity = "CRITICAL"
    elif pc > 0.01:
        severity = "WARNING"
    else:
        severity = "SAFE"

    return float(pc), severity