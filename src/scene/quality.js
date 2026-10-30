const SCALES = [1, 0.85, 0.7, 0.55];
const STEPS = [180, 150, 120, 100];

export class QualityScaler {
  constructor() {
    this.renderScale = 1;
    this.maxSteps = 180;
    this.fps = 60;
    this.lowSeconds = 0;
    this.highSeconds = 0;
  }

  pin(scale) {
    const changed = this.renderScale !== scale;
    this.renderScale = scale;
    this.maxSteps = STEPS[SCALES.findIndex((entry) => scale >= entry)] ?? 100;
    this.lowSeconds = 0;
    this.highSeconds = 0;
    return changed;
  }

  update(dt, quality) {
    if (typeof quality === 'number') return this.pin(quality);
    if (dt <= 0) return false;
    this.fps += (1 / dt - this.fps) * (1 - Math.exp(-dt / 0.5));
    this.lowSeconds = this.fps < 50 ? this.lowSeconds + dt : 0;
    this.highSeconds = this.fps > 90 ? this.highSeconds + dt : 0;
    if (this.lowSeconds > 1) {
      const next = SCALES.find((scale) => scale < this.renderScale);
      return next === undefined ? false : this.pin(next);
    }
    if (this.highSeconds > 3) {
      const next = SCALES.findLast((scale) => scale > this.renderScale);
      return next === undefined ? false : this.pin(next);
    }
    return false;
  }
}
