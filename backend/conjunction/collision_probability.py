"""
AETHER — Collision Probability (Analytical)
Fast analytical Pc estimate based on a 2-D Gaussian miss-distance model.
Used as a quick-filter before invoking the heavier Monte Carlo estimator.

Model
-----
    Pc ≈ exp(−d² / (2σ²))

where d is the miss distance and σ = SIGMA_KM (50 m position uncertainty).

Severity thresholds  (PS §3.3)
-------------------------------
    CRITICAL : d < 0.1 km  OR  Pc > 0.1
    WARNING  : d < 0.5 km  OR  Pc > 0.01
    SAFE     : otherwise
"""

import math

SIGMA_KM           = 0.05    # 50 m position uncertainty (1-sigma, km)
COLLISION_DIST_KM  = 0.1     # PS §3.3 — hard collision threshold

_SIGMA2_X2 = 2.0 * SIGMA_KM ** 2   # precomputed


def calculate_risk(distance_km: float):
    """
    Compute analytical collision probability and severity label.

    Parameters
    ----------
    distance_km : float   miss distance (km), must be >= 0.

    Returns
    -------
    (pc, severity) : (float, str)
        pc       — collision probability in [0, 1]
        severity — "CRITICAL" | "WARNING" | "SAFE"
    """
    d   = max(0.0, float(distance_km))
    pc  = math.exp(-(d ** 2) / _SIGMA2_X2)

    if d < COLLISION_DIST_KM or pc > 0.1:
        severity = "CRITICAL"
    elif d < 0.5 or pc > 0.01:
        severity = "WARNING"
    else:
        severity = "SAFE"

    return float(pc), severity