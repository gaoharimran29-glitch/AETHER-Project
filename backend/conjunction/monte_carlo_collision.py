import numpy as np

def monte_carlo_collision_probability(
    sat_pos,
    deb_pos,
    sigma=0.05,
    samples=5000,
    collision_radius=0.01
):
    """
    Monte Carlo collision probability simulation.

    sigma → position uncertainty (km)
    samples → number of random trials
    collision_radius → collision threshold (km)
    """

    collisions = 0

    for _ in range(samples):

        sat_sample = sat_pos + np.random.normal(0, sigma, 3)
        deb_sample = deb_pos + np.random.normal(0, sigma, 3)

        dist = np.linalg.norm(sat_sample - deb_sample)

        if dist < collision_radius:
            collisions += 1

    pc = collisions / samples

    severity = "SAFE"

    if pc > 0.1:
        severity = "CRITICAL"
    elif pc > 0.01:
        severity = "WARNING"

    return float(pc), severity
