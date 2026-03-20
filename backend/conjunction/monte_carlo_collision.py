"""
AETHER — Monte Carlo Collision Probability
Vectorised Monte Carlo estimate of collision probability.  PS §3.3

Method
------
    Draw N samples from the combined position-error distribution
    (σ for both satellite and debris, added in quadrature → σ_rel).
    Count fraction of samples where relative distance < collision_radius.

Parameters tuned for the hackathon scale (50 sats × 10 000 debris):
    samples          = 5 000   — sufficient for 1-in-1000 probability resolution
    collision_radius = 0.1 km  — PS §3.3 hard threshold

Severity thresholds  (consistent with collision_probability.py)
    CRITICAL : Pc > 0.05
    WARNING  : Pc > 0.001
    SAFE     : otherwise
"""

import numpy as np

# Nominal 1-sigma position uncertainty per object (km)
_DEFAULT_SIGMA_KM       = 0.05    # 50 m
_DEFAULT_SAMPLES        = 5_000
_DEFAULT_COLL_RADIUS_KM = 0.1     # 100 m  (PS §3.3)


def monte_carlo_collision_probability(
    sat_pos,
    deb_pos,
    sigma: float = _DEFAULT_SIGMA_KM,
    samples: int = _DEFAULT_SAMPLES,
    collision_radius: float = _DEFAULT_COLL_RADIUS_KM,
    rng: np.random.Generator = None,
):
    """
    Estimate collision probability by Monte Carlo sampling.

    Parameters
    ----------
    sat_pos          : array-like (3,)   satellite ECI position (km)
    deb_pos          : array-like (3,)   debris   ECI position (km)
    sigma            : float             1-sigma position uncertainty per
                                         object (km).  Default 50 m.
    samples          : int               number of Monte Carlo trials
    collision_radius : float             hard-body radius threshold (km)
    rng              : np.random.Generator or None
                       Provide a seeded generator for reproducible tests.

    Returns
    -------
    (pc, severity) : (float, str)
        pc       — estimated collision probability
        severity — "CRITICAL" | "WARNING" | "SAFE"
    """
    if rng is None:
        rng = np.random.default_rng()

    sat_arr = np.asarray(sat_pos, dtype=float)
    deb_arr = np.asarray(deb_pos, dtype=float)

    # Perturb both objects independently
    sat_samples = sat_arr + rng.normal(0.0, sigma, (samples, 3))
    deb_samples = deb_arr + rng.normal(0.0, sigma, (samples, 3))

    # Vectorised distance calculation  (N samples at once)
    distances  = np.linalg.norm(sat_samples - deb_samples, axis=1)
    collisions = int(np.sum(distances < collision_radius))
    pc         = collisions / samples

    if pc > 0.05:
        severity = "CRITICAL"
    elif pc > 0.001:
        severity = "WARNING"
    else:
        severity = "SAFE"

    return float(pc), severity