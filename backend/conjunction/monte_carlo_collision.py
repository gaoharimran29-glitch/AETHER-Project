import numpy as np

def monte_carlo_collision_probability(
    sat_pos,
    deb_pos,
    sigma=0.05,
    samples=5000,
    collision_radius=0.01
):
    """
    Vectorized Monte Carlo for high-speed collision risk assessment.
    """
    
    sat_samples = sat_pos + np.random.normal(0, sigma, (samples, 3))
    deb_samples = deb_pos + np.random.normal(0, sigma, (samples, 3))

    # Calculate distances for all samples at once
    # Result is a 1D array of distances
    distances = np.linalg.norm(sat_samples - deb_samples, axis=1)

    # Count hits
    collisions = np.sum(distances < collision_radius)

    pc = collisions / samples

    # Severity logic (PS compliant)
    if pc > 0.05: # Threshold adjusted for better safety
        severity = "CRITICAL"
    elif pc > 0.001:
        severity = "WARNING"
    else:
        severity = "SAFE"

    return float(pc), severity