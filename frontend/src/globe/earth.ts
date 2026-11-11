// The globe is drawn from scratch: country outlines (Natural Earth, public domain)
// are painted onto a canvas that becomes the sphere's texture, and land is
// covered with evenly spaced dots.
import * as THREE from "three";
import { feature } from "topojson-client";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import world from "world-atlas/countries-110m.json";

export const EARTH_RADIUS_KM = 6371;

/** Latitude/longitude in degrees to a point on a sphere of the given radius (y is north). */
export function latLonToVec3(lat: number, lon: number, radius = 1): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(lat);
  const lam = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(radius * Math.cos(phi) * Math.cos(lam), radius * Math.sin(phi), -radius * Math.cos(phi) * Math.sin(lam));
}

/** Earth-fixed coordinates in km to scene units. */
export function ecefToVec3(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x / EARTH_RADIUS_KM, z / EARTH_RADIUS_KM, -y / EARTH_RADIUS_KM);
}

/** Direction to the sun in the Earth-fixed frame (good to about a degree). */
export function sunDirection(date: Date): THREE.Vector3 {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = (date.getTime() - start) / 86_400_000;
  const declination = -23.44 * Math.cos((2 * Math.PI * (dayOfYear + 10)) / 365);
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  return latLonToVec3(declination, (12 - hours) * 15);
}

type Rings = number[][][];

function polygons(): Rings[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fc = feature(world as any, (world as any).objects.countries) as unknown as FeatureCollection<Polygon | MultiPolygon>;
  const out: Rings[] = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    if (f.geometry.type === "Polygon") out.push(f.geometry.coordinates as Rings);
    else for (const p of f.geometry.coordinates) out.push(p as Rings);
  }
  return out;
}

function trace(ctx: CanvasRenderingContext2D, polys: Rings[], w: number, h: number) {
  ctx.beginPath();
  for (const poly of polys) {
    for (const ring of poly) {
      ring.forEach(([lon, lat], i) => {
        const x = ((lon + 180) / 360) * w;
        const y = ((90 - lat) / 180) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
    }
  }
}

export interface EarthAssets {
  texture: THREE.CanvasTexture;
  landDots: Float32Array;
}

export function buildEarthAssets(): EarthAssets {
  const polys = polygons();

  // Surface texture: ocean, faint land fill, a grid, and glowing borders.
  const W = 4096;
  const H = 2048;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const ocean = ctx.createLinearGradient(0, 0, 0, H);
  ocean.addColorStop(0, "#040404");
  ocean.addColorStop(0.5, "#000000");
  ocean.addColorStop(1, "#040404");
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, W, H);

  trace(ctx, polys, W, H);
  ctx.fillStyle = "#0c0c0b";
  ctx.fill("evenodd");

  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let lon = -180; lon <= 180; lon += 15) {
    const x = ((lon + 180) / 360) * W;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    const y = ((90 - lat) / 180) * H;
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
  }
  ctx.stroke();

  trace(ctx, polys, W, H);
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(232, 228, 216, 0.07)";
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.strokeStyle = "rgba(232, 228, 216, 0.5)";
  ctx.lineWidth = 1.3;
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;

  // Land mask, sampled to decide where the dots go.
  const MW = 1440;
  const MH = 720;
  const mask = document.createElement("canvas");
  mask.width = MW;
  mask.height = MH;
  const mctx = mask.getContext("2d", { willReadFrequently: true })!;
  mctx.fillStyle = "#000";
  mctx.fillRect(0, 0, MW, MH);
  trace(mctx, polys, MW, MH);
  mctx.fillStyle = "#fff";
  mctx.fill("evenodd");
  const pixels = mctx.getImageData(0, 0, MW, MH).data;

  // Evenly spaced points on a sphere (Fibonacci spiral); keep the ones on land.
  const N = 90_000;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const dots: number[] = [];
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N;
    const r = Math.sqrt(1 - y * y);
    const theta = i * golden;
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    const lat = THREE.MathUtils.radToDeg(Math.asin(y));
    const lon = THREE.MathUtils.radToDeg(Math.atan2(-z, x));
    const px = Math.min(MW - 1, Math.floor(((lon + 180) / 360) * MW));
    const py = Math.min(MH - 1, Math.floor(((90 - lat) / 180) * MH));
    if (pixels[(py * MW + px) * 4] > 128) dots.push(x * 1.002, y * 1.002, z * 1.002);
  }

  return { texture, landDots: new Float32Array(dots) };
}

export const earthVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vViewNormal;
  varying vec3 vViewPos;
  void main() {
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vViewNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

export const earthFragment = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 sunDir;
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vViewNormal;
  varying vec3 vViewPos;
  void main() {
    vec3 tex = texture2D(map, vUv).rgb;
    float d = dot(normalize(vWorldNormal), sunDir);
    float day = smoothstep(-0.12, 0.3, d);
    vec3 col = tex * mix(0.45, 1.5, day);
    col += vec3(0.035, 0.033, 0.03) * day;
    // A thin line where day meets night.
    col += vec3(1.0, 0.37, 0.12) * smoothstep(0.012, 0.0, abs(d)) * 0.55;
    float fres = pow(1.0 - max(dot(normalize(vViewNormal), normalize(-vViewPos)), 0.0), 3.5);
    col += vec3(0.85, 0.83, 0.78) * fres * 0.4;
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export const atmosphereVertex = /* glsl */ `
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const atmosphereFragment = /* glsl */ `
  varying vec3 vNormal;
  void main() {
    float intensity = pow(0.74 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 4.0);
    gl_FragColor = vec4(0.8, 0.78, 0.74, 1.0) * intensity * 0.35;
  }
`;

export const dotsVertex = /* glsl */ `
  uniform vec3 sunDir;
  uniform float scale;
  varying float vDay;
  void main() {
    vDay = smoothstep(-0.12, 0.3, dot(normalize(position), sunDir));
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = scale * 0.011 / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

export const dotsFragment = /* glsl */ `
  varying float vDay;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    if (r > 0.5) discard;
    vec3 night = vec3(0.26, 0.26, 0.25);
    vec3 dayc = vec3(0.82, 0.8, 0.74);
    gl_FragColor = vec4(mix(night, dayc, vDay), mix(0.5, 0.9, vDay) * smoothstep(0.5, 0.3, r));
  }
`;

// Satellites: soft glowing points with a per-point size and colour.
export const pointsVertex = /* glsl */ `
  attribute float size;
  attribute vec3 tint;
  uniform float scale;
  varying vec3 vTint;
  void main() {
    vTint = tint;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * scale / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

export const pointsFragment = /* glsl */ `
  varying vec3 vTint;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    if (r > 1.0) discard;
    float core = smoothstep(0.35, 0.0, r);
    float glow = pow(1.0 - r, 2.0) * 0.55;
    gl_FragColor = vec4(vTint * (glow + core) + vec3(core * 0.6), glow + core);
  }
`;

// Event markers: a solid core with a ring that expands outward, so live events read as "active".
export const eventsVertex = /* glsl */ `
  attribute float sev;
  attribute float sel;
  attribute float seed;
  uniform float scale;
  varying float vSel;
  varying float vSeed;
  void main() {
    vSel = sel;
    vSeed = seed;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = (0.07 + 0.11 * sev) * (1.0 + sel * 0.8) * scale / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

export const eventsFragment = /* glsl */ `
  uniform float uTime;
  varying float vSel;
  varying float vSeed;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    if (r > 1.0) discard;
    float phase = fract(uTime * 0.55 + vSeed);
    float ring = smoothstep(0.09, 0.0, abs(r - phase)) * (1.0 - phase);
    float core = smoothstep(0.24, 0.14, r);
    vec3 hot = mix(vec3(1.0, 0.18, 0.2), vec3(1.0, 0.95, 0.9), vSel * core);
    float a = max(core, ring * 0.9);
    gl_FragColor = vec4(hot * a, a);
  }
`;

// Latency layer: hours to the first radar look, sampled from a small data texture
// (one texel per grid cell) and drawn as colour bands with contour lines.
export const latencyVertex = /* glsl */ `
  varying vec3 vPos;
  void main() {
    vPos = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const latencyFragment = /* glsl */ `
  uniform sampler2D grid;
  uniform float horizon;
  uniform float opacity;
  uniform float uTime;
  varying vec3 vPos;

  vec3 ramp(float h) {
    vec3 quick = vec3(0.91, 0.89, 0.85);
    vec3 slow = vec3(1.0, 0.37, 0.12);
    vec3 worst = vec3(1.0, 0.12, 0.2);
    vec3 c = mix(quick, slow, smoothstep(1.5, 3.2, h));
    return mix(c, worst, smoothstep(5.0, 7.0, h));
  }

  float contour(float h, float level) {
    float w = fwidth(h) * 1.4;
    return 1.0 - smoothstep(0.0, w, abs(h - level));
  }

  void main() {
    float lat = asin(clamp(vPos.y, -1.0, 1.0));
    float lon = atan(-vPos.z, vPos.x);
    vec2 uv = vec2(lon / 6.28318530718 + 0.5, lat / 3.14159265359 + 0.5);
    float h = texture2D(grid, uv).r * horizon;
    float never = smoothstep(horizon * 0.93, horizon * 0.99, h);
    float lines = max(contour(h, 1.0), max(contour(h, 3.0), contour(h, 6.0)));
    // Cells with no look at all are hatched instead of filled.
    float hatch = step(0.5, fract((vPos.x + vPos.y * 1.7 + vPos.z) * 60.0 + uTime * 0.15));
    vec3 col = ramp(h);
    // Quick places stay nearly clear; the gaps are what the operator needs to see.
    float fill = mix(0.035, 0.34, smoothstep(0.8, 4.0, h));
    float a = mix(fill, 0.5 * hatch, never) + lines * 0.5 * (1.0 - never);
    gl_FragColor = vec4(col, a * opacity);
  }
`;
