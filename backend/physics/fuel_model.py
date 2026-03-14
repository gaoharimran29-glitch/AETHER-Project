import numpy as np

G0 = 9.80665  # m/s^2
ISP = 300.0   # seconds
DRY_MASS = 500.0


def fuel_consumption(m_current, dv):
    """
    Calculate propellant mass used using Tsiolkovsky rocket equation.

    dv : km/s
    returns fuel used (kg)
    """

    dv_m = dv * 1000.0  # convert km/s → m/s

    delta_m = m_current * (1 - np.exp(-dv_m / (ISP * G0)))

    return float(delta_m)


def update_mass(m_current, dv):
    """
    Update spacecraft mass after burn
    """

    fuel_used = fuel_consumption(m_current, dv)

    new_mass = m_current - fuel_used

    return float(new_mass), float(fuel_used)