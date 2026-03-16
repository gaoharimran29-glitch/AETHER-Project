import numpy as np


def monte_carlo_collision_probability(
    sat_pos,
    deb_pos,
    sigma=0.05,
    samples=5000,
    collision_radius=0.1,    # km = 100 m  (PS §3.3)
):
    """
    Vectorised Monte Carlo collision probability estimate.

    Parameters
    ----------
    sat_pos          : array-like (3,)  ECI position of satellite (km)
    deb_pos          : array-like (3,)  ECI position of debris (km)
    sigma            : float  1-sigma position uncertainty (km), default 50 m
    samples          : int    number of Monte Carlo samples
    collision_radius : float  hard-body radius threshold (km)  — PS §3.3: 0.1 km

    Returns
    -------
    (pc, severity) : (float, str)
    """
    sat_samples = np.asarray(sat_pos) + np.random.normal(0, sigma, (samples, 3))
    deb_samples = np.asarray(deb_pos) + np.random.normal(0, sigma, (samples, 3))

    distances  = np.linalg.norm(sat_samples - deb_samples, axis=1)
    collisions = int(np.sum(distances < collision_radius))
    pc         = collisions / samples

    # Severity thresholds
    if pc > 0.05:
        severity = "CRITICAL"
    elif pc > 0.001:
        severity = "WARNING"
    else:
        severity = "SAFE"

    return float(pc), severity
