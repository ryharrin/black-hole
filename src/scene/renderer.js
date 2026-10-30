import * as THREE from 'three';
import { vertexShader, fragmentShader } from '../shaders/blackhole.js';
import { iscoRadius } from '../physics/schwarzschild.js';

const MAX_BODIES = 16;
const KIND_CODES = { probe: 0, star: 1, planet: 2 };
const STYLE_CODES = { star: 0, gas: 0, rocky: 1, ice: 2 };
const ZERO_VELOCITY = [0, 0, 0];

export function createRenderer(host) {
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.CustomToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.setAttribute('aria-label', 'Black hole, gravitationally lensed accretion disk and procedural stars');
  host.append(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 500);
  const uniforms = {
    cameraPositionWorld: { value: camera.position },
    cameraRotation: { value: new THREE.Matrix3() },
    worldToDisk: { value: new THREE.Matrix3() },
    aspect: { value: 1 },
    tanHalfFov: { value: Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) },
    pixelAngle: { value: 0.0013 },
    simTime: { value: 0 },
    mass: { value: 1 }, spin: { value: 0 }, diskTemp: { value: 6500 },
    innerRadius: { value: 6 }, lensingStrength: { value: 1 }, starStretch: { value: 1 },
    einsteinStarDir: { value: new THREE.Vector3(0, -0.17365, -0.98481).normalize() },
    lensing: { value: true }, doppler: { value: true }, stars: { value: true }, disk: { value: true },
    maxSteps: { value: 180 }, bodyCount: { value: 0 },
    bodyA: { value: Array.from({ length: MAX_BODIES }, () => new THREE.Vector4()) },
    bodyB: { value: Array.from({ length: MAX_BODIES }, () => new THREE.Vector4()) },
    bodyC: { value: Array.from({ length: MAX_BODIES }, () => new THREE.Vector4(0, 1, 0, 1)) },
    bodyD: { value: Array.from({ length: MAX_BODIES }, () => new THREE.Vector4()) },
  };
  const scene = new THREE.Scene();
  const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, depthTest: false, depthWrite: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);
  const quadCamera = new THREE.Camera();
  const rotation = new THREE.Matrix4();
  function update(settings, simTime, bodies, starStretch, maxSteps) {
    camera.updateMatrixWorld();
    uniforms.cameraRotation.value.setFromMatrix4(camera.matrixWorld);
    uniforms.worldToDisk.value.setFromMatrix4(rotation.makeRotationX(-THREE.MathUtils.degToRad(settings.diskTilt)));
    uniforms.aspect.value = camera.aspect;
    uniforms.simTime.value = simTime;
    uniforms.innerRadius.value = iscoRadius(settings.mass, settings.spin) / settings.mass;
    uniforms.starStretch.value = starStretch;
    uniforms.maxSteps.value = maxSteps;
    uniforms.pixelAngle.value = 2 * uniforms.tanHalfFov.value / renderer.domElement.height;
    for (const key of ['mass', 'spin', 'diskTemp', 'lensingStrength', 'lensing', 'doppler', 'stars', 'disk']) uniforms[key].value = settings[key];
    const count = Math.min(bodies.length, MAX_BODIES);
    uniforms.bodyCount.value = count;
    for (let i = 0; i < count; i++) {
      const body = bodies[i];
      const apparent = body.apparent;
      const [x, y, z] = apparent.position;
      const kind = KIND_CODES[body.kind] ?? 0;
      const velocity = apparent.velocity ?? ZERO_VELOCITY;
      const invR = apparent.r > 0 ? 1 / apparent.r : 0;
      uniforms.bodyA.value[i].set(x, y, z, body.bodyRadius ?? (kind === 0 ? 0.32 : 0.4));
      uniforms.bodyB.value[i].set(velocity[0], velocity[1], velocity[2], apparent.redshift);
      uniforms.bodyC.value[i].set(x * invR, y * invR, z * invR, Math.max(1, apparent.stretch));
      uniforms.bodyD.value[i].set(kind, body.temperature ?? 0, (body.seed ?? body.id ?? 0) % 251,
        kind === 0 ? (body.id ?? 0) % 2 : (STYLE_CODES[body.style] ?? 0));
    }
  }
  return { renderer, scene, camera, quadCamera, uniforms, update };
}
