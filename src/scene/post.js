import { HalfFloatType, Vector2, WebGLRenderTarget } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GrainShader } from '../shaders/grain.js';

export function createPost(renderer, scene, camera) {
  const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false, stencilBuffer: false });
  const composer = new EffectComposer(renderer, target);
  const bloom = new UnrealBloomPass(new Vector2(1, 1), 0.35, 0, 1.0);
  // Restrict the wide mips: broad veiling glare would fill the black hole's shadow.
  bloom.compositeMaterial.uniforms.bloomFactors.value = [1, 0.08, 0, 0, 0];
  const grain = new ShaderPass(GrainShader);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(bloom);
  composer.addPass(grain);
  const output = new OutputPass();
  // Compress luminance, then fit the gamut with a uniform scale: never bleach hot blue light white.
  output.material.fragmentShader = /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float toneMappingExposure;
    varying vec2 vUv;
    #include <colorspace_pars_fragment>
    void main() {
      vec3 color = max(vec3(0.0), texture2D(tDiffuse, vUv).rgb * toneMappingExposure);
      float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color /= 1.0 + luminance;
      color /= max(1.0, max(color.r, max(color.g, color.b)));
      gl_FragColor = vec4(color, 1.0);
      #ifdef SRGB_TRANSFER
        gl_FragColor = sRGBTransferOETF(gl_FragColor);
      #endif
    }
  `;
  composer.addPass(output);
  function resize(width, height, renderScale) {
    const w = Math.max(1, Math.round(width * renderScale));
    const h = Math.max(1, Math.round(height * renderScale));
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    // Bloom is low-frequency: quarter-resolution first mip keeps bandwidth low.
    bloom.setSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
  }
  function render(time, settings) {
    bloom.enabled = settings.bloom;
    grain.enabled = settings.grain;
    grain.uniforms.time.value = time;
    composer.render();
  }
  return { composer, bloom, grain, resize, render };
}
