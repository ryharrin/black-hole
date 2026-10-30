import { timeDilation } from '../physics/schwarzschild.js';

/**
 * On-screen observer clock. `coordTime` is the far-away (coordinate) time; `properTime` is the time
 * measured by the camera, which hovers at radius `r` as a static observer and so runs slow by
 * rate = dτ/dt = sqrt(1 - 2M/r). Both advance by simulated time (dtSim), not wall-clock time.
 */
export class ObserverClock {
  constructor() {
    this.reset();
  }

  reset() {
    this.properTime = 0;
    this.coordTime = 0;
    this.rate = 1;
  }

  update(dtSim, r, mass) {
    this.rate = timeDilation(r, mass);
    this.properTime += dtSim * this.rate;
    this.coordTime += dtSim;
    return this;
  }
}
