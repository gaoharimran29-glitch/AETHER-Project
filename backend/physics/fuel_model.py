"""
physics/fuel_model.py
─────────────────────
Tsiolkovsky rocket equation implementation (PS §5.1).

  ∆m = m_current · (1 - exp(-|∆v| / (Isp · g0)))

Constants (PS §5.1)
───────────────────
  Isp      = 300.0 s
  g0       = 9.80665 m/s²
  DRY_MASS = 500.0 kg
"""

import numpy as np
import logging

logger = logging.getLogger("AETHER.fuel_model")

# ── Physical constants  (PS §5.1) ─────────────────────────────────────────────
G0: float       = 9.80665   # m/s²  standard gravity
ISP: float      = 300.0     # s     specific impulse
DRY_MASS: float = 500.0     # kg    spacecraft dry mass (no propellant)
INITIAL_FUEL: float = 50.0  # kg    initial propellant mass  (PS §5.1)
INITIAL_WET_MASS: float = DRY_MASS + INITIAL_FUEL  # 550 kg


def fuel_consumption(m_current: float, dv_km_s: float) -> float:
    """
    Propellant mass consumed for a given maneuver.

    Parameters
    ----------
    m_current : float   current total (wet) mass in kg
    dv_km_s   : float   |∆v| in km/s

    Returns
    -------
    float  — fuel consumed in kg  (always ≥ 0)
    """
    if dv_km_s <= 0.0 or m_current <= DRY_MASS:
        return 0.0

    dv_m_s   = abs(float(dv_km_s)) * 1_000.0        # km/s → m/s
    exponent = dv_m_s / (ISP * G0)

    # Guard against numerical overflow for very large ∆v
    if exponent > 700.0:
        return max(0.0, m_current - DRY_MASS)

    fuel_used = m_current * (1.0 - np.exp(-exponent))
    return float(fuel_used)


def update_mass(m_current: float, dv_km_s: float) -> tuple[float, float]:
    """
    Apply Tsiolkovsky equation and return updated mass + fuel consumed.

    The satellite can never drop below DRY_MASS — any shortfall is capped.

    Parameters
    ----------
    m_current : float   current total (wet) mass in kg
    dv_km_s   : float   |∆v| in km/s

    Returns
    -------
    (new_mass_kg, fuel_used_kg) : tuple[float, float]
    """
    fuel_used = fuel_consumption(m_current, dv_km_s)
    new_mass  = m_current - fuel_used

    # Hard floor: satellite cannot burn past dry mass
    if new_mass < DRY_MASS:
        fuel_used = max(0.0, m_current - DRY_MASS)
        new_mass  = DRY_MASS
        logger.warning(
            f"Fuel floor reached — capping burn. "
            f"m_current={m_current:.2f} kg, dv={dv_km_s*1000:.2f} m/s"
        )

    return float(new_mass), float(fuel_used)