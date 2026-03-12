import numpy as np
from .propagator import state_derivative

def rk4_step(state, dt):
    """
    Moves the state forward by time dt using RK4.
    state: [x, y, z, vx, vy, vz]
    """
    # Convert input to numpy array just in case it's a list
    state = np.array(state)
    
    k1 = state_derivative(state)
    k2 = state_derivative(state + k1 * dt / 2.0)
    k3 = state_derivative(state + k2 * dt / 2.0)
    k4 = state_derivative(state + k3 * dt)
    
    new_state = state + (dt / 6.0) * (k1 + 2.0*k2 + 2.0*k3 + k4)
    
    return new_state