export const GrainShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    amount: { value: 0.012 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time, amount;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float grain = fract(sin(dot(gl_FragCoord.xy + fract(time) * 127.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      color.rgb = max(vec3(0.0), color.rgb + grain * amount * (0.12 + min(color.rgb, vec3(1.0))));
      gl_FragColor = color;
    }
  `,
};
