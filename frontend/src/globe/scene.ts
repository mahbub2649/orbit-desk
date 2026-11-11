import * as satellite from "satellite.js";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Pass, Tle } from "../types";
import {
  atmosphereFragment,
  atmosphereVertex,
  buildEarthAssets,
  dotsFragment,
  dotsVertex,
  earthFragment,
  earthVertex,
  ecefToVec3,
  eventsFragment,
  eventsVertex,
  latLonToVec3,
  latencyFragment,
  latencyVertex,
  pointsFragment,
  pointsVertex,
  sunDirection,
} from "./earth";

export interface Target {
  lat: number;
  lon: number;
  radiusKm: number;
  plan: Pass[];
}

export interface Marker {
  id: string;
  lat: number;
  lon: number;
  severity: number;
  label: string;
}

export interface LatencyGrid {
  rows: number;
  cols: number;
  cellDeg: number;
  horizonHours: number;
  /** Row-major, south to north, west to east. null = no look inside the window. */
  hours: (number | null)[];
  looks: number[];
}

export interface HoverInfo {
  kind: "satellite" | "event" | "cell";
  name: string;
  detail: string;
  planned: boolean;
  x: number;
  y: number;
}

/** Per-frame numbers for the overlay drawn on top of the canvas. */
export interface Hud {
  cx: number;
  cy: number;
  r: number;
  camLat: number;
  camLon: number;
  target: { x: number; y: number; visible: boolean } | null;
}

interface Sat {
  tle: Tle;
  rec: satellite.SatRec;
  periodMin: number;
}

const BONE = new THREE.Color("#e8e4d8");
const ORANGE = new THREE.Color("#ff5f1f");
const GREEN = new THREE.Color("#b7ff3c");
const RING_POINTS = 120;
const MAX_LINKS = 8;
// Same access limits as the backend's simplified model.
const MIN_INC = 15;
const MAX_INC = 45;

function positionAt(rec: satellite.SatRec, date: Date, gmst = satellite.gstime(date)): THREE.Vector3 | null {
  const pv = satellite.propagate(rec, date);
  if (!pv || typeof pv.position !== "object" || !pv.position) return null;
  const ecf = satellite.eciToEcf(pv.position, gmst);
  if (!Number.isFinite(ecf.x)) return null;
  return ecefToVec3(ecf.x, ecf.y, ecf.z);
}

export class GlobeScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.01, 500);
  private controls: OrbitControls;
  private earthMaterial: THREE.ShaderMaterial;
  private dotsMaterial: THREE.ShaderMaterial;
  private satMaterial: THREE.ShaderMaterial;
  private eventMaterial: THREE.ShaderMaterial;
  private satPoints: THREE.Points | null = null;
  private eventPoints: THREE.Points | null = null;
  private rings: THREE.LineSegments | null = null;
  private links: THREE.LineSegments;
  private targetGroup = new THREE.Group();
  private pulse: THREE.Mesh | null = null;
  private sats: Sat[] = [];
  private satPositions: (THREE.Vector3 | null)[] = [];
  private markers: Marker[] = [];
  private markerPositions: THREE.Vector3[] = [];
  private planned = new Set<number>();
  private targetNormal: THREE.Vector3 | null = null;
  private accessKey = "";
  private raf = 0;
  private resizeObserver: ResizeObserver;
  private simBase = Date.now();
  private realBase = performance.now();
  private speed = 1;
  private lastRingUpdate = -1e9;
  private lastTick = 0;
  private fly: { from: THREE.Vector3; to: THREE.Vector3; start: number } | null = null;
  private pointer: { x: number; y: number } | null = null;
  private downAt: { x: number; y: number } | null = null;
  private latency: LatencyGrid | null = null;
  private latencyMesh: THREE.Mesh | null = null;
  private latencyMaterial: THREE.ShaderMaterial;
  private latencyFade = { value: 0, target: 0 };

  onTick: (date: Date) => void = () => {};
  onHover: (info: HoverInfo | null) => void = () => {};
  onPick: (markerId: string) => void = () => {};
  onAccess: (names: string[]) => void = () => {};
  onFrame: (hud: Hud) => void = () => {};

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);

    this.camera.position.copy(latLonToVec3(28, 60, 5.0));
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.35;
    this.controls.maxDistance = 8;
    this.controls.rotateSpeed = 0.5;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.3;
    this.controls.addEventListener("start", () => {
      this.fly = null;
    });

    const assets = buildEarthAssets();
    const sunDir = { value: sunDirection(new Date()) };
    const scale = { value: 1 };

    this.earthMaterial = new THREE.ShaderMaterial({
      uniforms: { map: { value: assets.texture }, sunDir },
      vertexShader: earthVertex,
      fragmentShader: earthFragment,
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), this.earthMaterial));

    this.dotsMaterial = new THREE.ShaderMaterial({
      uniforms: { sunDir, scale },
      vertexShader: dotsVertex,
      fragmentShader: dotsFragment,
      transparent: true,
      depthWrite: false,
    });
    const dotsGeometry = new THREE.BufferGeometry();
    dotsGeometry.setAttribute("position", new THREE.BufferAttribute(assets.landDots, 3));
    this.scene.add(new THREE.Points(dotsGeometry, this.dotsMaterial));

    this.scene.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(1.14, 96, 64),
        new THREE.ShaderMaterial({
          vertexShader: atmosphereVertex,
          fragmentShader: atmosphereFragment,
          blending: THREE.AdditiveBlending,
          side: THREE.BackSide,
          transparent: true,
          depthWrite: false,
        }),
      ),
    );

    this.scene.add(this.buildStars());
    this.scene.add(this.targetGroup);

    this.satMaterial = new THREE.ShaderMaterial({
      uniforms: { scale },
      vertexShader: pointsVertex,
      fragmentShader: pointsFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.eventMaterial = new THREE.ShaderMaterial({
      uniforms: { scale, uTime: { value: 0 } },
      vertexShader: eventsVertex,
      fragmentShader: eventsFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.latencyMaterial = new THREE.ShaderMaterial({
      uniforms: { grid: { value: null }, horizon: { value: 24 }, opacity: { value: 0 }, uTime: { value: 0 } },
      vertexShader: latencyVertex,
      fragmentShader: latencyFragment,
      transparent: true,
      depthWrite: false,
    });

    // Lines from the target to every satellite that could image it right now.
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_LINKS * 6), 3));
    lg.setDrawRange(0, 0);
    this.links = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: GREEN, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.links.frustumCulled = false;
    this.scene.add(this.links);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    const el = this.renderer.domElement;
    const local = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    el.addEventListener("pointermove", (e) => {
      this.pointer = local(e);
    });
    el.addEventListener("pointerleave", () => {
      this.pointer = null;
      this.onHover(null);
    });
    el.addEventListener("pointerdown", (e) => {
      this.downAt = local(e);
    });
    el.addEventListener("pointerup", (e) => {
      const up = local(e);
      // A click, not a drag.
      if (this.downAt && Math.hypot(up.x - this.downAt.x, up.y - this.downAt.y) < 5) {
        const hit = this.nearestMarker(up.x, up.y, 16);
        if (hit) this.onPick(hit.marker.id);
      }
      this.downAt = null;
    });

    this.animate();
  }

  private buildStars(): THREE.Points {
    const n = 1800;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(60 + Math.random() * 40);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ color: 0xbfbcb2, size: 1.1, sizeAttenuation: false, transparent: true, opacity: 0.4, depthWrite: false }));
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dotsMaterial.uniforms.scale.value = (h * this.renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
  }

  simTime(): Date {
    return new Date(this.simBase + (performance.now() - this.realBase) * this.speed);
  }

  setSpeed(speed: number) {
    this.simBase = this.simTime().getTime();
    this.realBase = performance.now();
    this.speed = speed;
  }

  resetTime() {
    this.simBase = Date.now();
    this.realBase = performance.now();
    this.lastRingUpdate = -1e9;
  }

  setSatellites(tles: Tle[]) {
    this.sats = tles.map((tle) => {
      const rec = satellite.twoline2satrec(tle.line1, tle.line2);
      return { tle, rec, periodMin: (2 * Math.PI) / rec.no };
    });
    if (this.satPoints) this.scene.remove(this.satPoints);
    if (this.rings) this.scene.remove(this.rings);

    const n = this.sats.length;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("tint", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("size", new THREE.BufferAttribute(new Float32Array(n), 1));
    this.satPoints = new THREE.Points(g, this.satMaterial);
    this.satPoints.frustumCulled = false;
    this.scene.add(this.satPoints);

    const rg = new THREE.BufferGeometry();
    rg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * RING_POINTS * 6), 3));
    rg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * RING_POINTS * 6), 3));
    this.rings = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.rings.frustumCulled = false;
    this.scene.add(this.rings);
    this.applyTints();
  }

  setMarkers(markers: Marker[], selectedId: string | null) {
    this.markers = markers;
    this.markerPositions = markers.map((m) => latLonToVec3(m.lat, m.lon, 1.006));
    if (this.eventPoints) this.scene.remove(this.eventPoints);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.markerPositions.flatMap((p) => [p.x, p.y, p.z]), 3));
    g.setAttribute("sev", new THREE.Float32BufferAttribute(markers.map((m) => m.severity), 1));
    g.setAttribute("sel", new THREE.Float32BufferAttribute(markers.map((m) => (m.id === selectedId ? 1 : 0)), 1));
    g.setAttribute("seed", new THREE.Float32BufferAttribute(markers.map((_, i) => (i * 0.37) % 1), 1));
    this.eventPoints = new THREE.Points(g, this.eventMaterial);
    this.eventPoints.frustumCulled = false;
    this.scene.add(this.eventPoints);
  }

  /** Show or hide the worldwide latency layer. Passing null fades it out. */
  setLatency(grid: LatencyGrid | null) {
    this.latencyFade.target = grid ? 1 : 0;
    if (!grid) return;
    this.latency = grid;
    const data = new Uint8Array(grid.rows * grid.cols * 4);
    grid.hours.forEach((h, i) => {
      data[i * 4] = h == null ? 255 : Math.min(254, Math.round((h / grid.horizonHours) * 255));
      data[i * 4 + 3] = 255;
    });
    const tex = new THREE.DataTexture(data, grid.cols, grid.rows, THREE.RGBAFormat);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    (this.latencyMaterial.uniforms.grid.value as THREE.Texture | null)?.dispose();
    this.latencyMaterial.uniforms.grid.value = tex;
    this.latencyMaterial.uniforms.horizon.value = grid.horizonHours;
    if (!this.latencyMesh) {
      this.latencyMesh = new THREE.Mesh(new THREE.SphereGeometry(1.002, 128, 96), this.latencyMaterial);
      this.latencyMesh.renderOrder = 1;
      this.scene.add(this.latencyMesh);
    }
  }

  /** Where the pointer's ray meets the globe, as latitude and longitude. */
  private pointerLatLon(x: number, y: number): { lat: number; lon: number } | null {
    const ndc = new THREE.Vector3((x / this.container.clientWidth) * 2 - 1, -(y / this.container.clientHeight) * 2 + 1, 0.5).unproject(this.camera);
    const origin = this.camera.position;
    const dir = ndc.sub(origin).normalize();
    const b = origin.dot(dir);
    const disc = b * b - (origin.lengthSq() - 1);
    if (disc <= 0) return null;
    const hit = origin.clone().addScaledVector(dir, -b - Math.sqrt(disc));
    return { lat: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(hit.y, -1, 1))), lon: THREE.MathUtils.radToDeg(Math.atan2(-hit.z, hit.x)) };
  }

  private applyTints() {
    if (!this.satPoints) return;
    const tint = this.satPoints.geometry.getAttribute("tint") as THREE.BufferAttribute;
    const size = this.satPoints.geometry.getAttribute("size") as THREE.BufferAttribute;
    this.sats.forEach((s, i) => {
      const hot = this.planned.has(s.tle.norad_id);
      const c = hot ? ORANGE : BONE;
      const k = hot ? 1 : 0.75;
      tint.setXYZ(i, c.r * k, c.g * k, c.b * k);
      size.setX(i, hot ? 0.08 : 0.042);
    });
    tint.needsUpdate = true;
    size.needsUpdate = true;
    this.lastRingUpdate = -1e9;
  }

  setTarget(target: Target | null) {
    this.targetGroup.clear();
    this.pulse = null;
    this.targetNormal = null;
    this.planned = new Set(target?.plan.map((p) => p.norad_id) ?? []);
    this.applyTints();
    this.controls.autoRotate = !target;
    if (!target) {
      this.links.geometry.setDrawRange(0, 0);
      if (this.accessKey) {
        this.accessKey = "";
        this.onAccess([]);
      }
      return;
    }

    const normal = latLonToVec3(target.lat, target.lon).normalize();
    this.targetNormal = normal;
    const anchor = new THREE.Group();
    anchor.position.copy(normal.clone().multiplyScalar(1.005));
    anchor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);

    const r = Math.max(target.radiusKm, 150) / 6371;
    const flat = (inner: number, outer: number, opacity: number) =>
      new THREE.Mesh(new THREE.RingGeometry(inner, outer, 64), new THREE.MeshBasicMaterial({ color: ORANGE, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
    anchor.add(flat(r * 0.93, r, 0.95));
    this.pulse = flat(r * 0.96, r, 0.7);
    anchor.add(this.pulse);
    this.targetGroup.add(anchor);

    // For the next planned collections: the ground track around the moment of imaging,
    // and a line from the target up to where the satellite will be.
    const now = this.simTime().getTime();
    const upcoming = target.plan.filter((p) => new Date(p.time).getTime() > now - 60_000).slice(0, 5);
    const byId = new Map(this.sats.map((s) => [s.tle.norad_id, s]));
    const track: number[] = [];
    const beams: number[] = [];
    const marks: number[] = [];
    for (const pass of upcoming) {
      const sat = byId.get(pass.norad_id);
      if (!sat) continue;
      const t0 = new Date(pass.time).getTime();
      let prev: THREE.Vector3 | null = null;
      for (let dt = -300; dt <= 300; dt += 15) {
        const p = positionAt(sat.rec, new Date(t0 + dt * 1000));
        if (!p) continue;
        const ground = p.clone().normalize().multiplyScalar(1.004);
        if (prev) track.push(prev.x, prev.y, prev.z, ground.x, ground.y, ground.z);
        prev = ground;
      }
      const at = positionAt(sat.rec, new Date(t0));
      if (at) {
        const a = anchor.position;
        beams.push(a.x, a.y, a.z, at.x, at.y, at.z);
        marks.push(at.x, at.y, at.z);
      }
    }
    const line = (data: number[], color: THREE.Color, opacity: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(data, 3));
      return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
    };
    if (track.length) this.targetGroup.add(line(track, ORANGE, 0.9));
    if (beams.length) {
      this.targetGroup.add(line(beams, ORANGE, 0.35));
      const mg = new THREE.BufferGeometry();
      mg.setAttribute("position", new THREE.Float32BufferAttribute(marks, 3));
      mg.setAttribute("tint", new THREE.Float32BufferAttribute(marks.map((_, i) => [ORANGE.r, ORANGE.g, ORANGE.b][i % 3]), 3));
      mg.setAttribute("size", new THREE.Float32BufferAttribute(new Array(marks.length / 3).fill(0.035), 1));
      this.targetGroup.add(new THREE.Points(mg, this.satMaterial));
    }

    this.flyTo(target.lat, target.lon);
  }

  flyTo(lat: number, lon: number) {
    const distance = THREE.MathUtils.clamp(this.camera.position.length(), 3.9, 5.0);
    // Look from slightly south so the target sits a little above the middle of the view.
    const viewDir = latLonToVec3(THREE.MathUtils.clamp(lat - 10, -80, 80), lon);
    this.fly = { from: this.camera.position.clone(), to: viewDir.multiplyScalar(distance), start: performance.now() };
  }

  private updateSatellites(date: Date) {
    if (!this.satPoints) return;
    const gmst = satellite.gstime(date);
    const pos = this.satPoints.geometry.getAttribute("position") as THREE.BufferAttribute;
    this.satPositions = this.sats.map((s, i) => {
      const p = positionAt(s.rec, date, gmst);
      if (p) pos.setXYZ(i, p.x, p.y, p.z);
      else pos.setXYZ(i, 0, 0, 0);
      return p;
    });
    pos.needsUpdate = true;
  }

  /** Which satellites could image the target at this instant, with the simplified access model. */
  private updateAccess() {
    const n = this.targetNormal;
    if (!n) return;
    const pos = this.links.geometry.getAttribute("position") as THREE.BufferAttribute;
    const names: string[] = [];
    let count = 0;
    this.satPositions.forEach((p, i) => {
      if (!p || count >= MAX_LINKS) return;
      const rho = p.clone().sub(n);
      const incidence = 90 - THREE.MathUtils.radToDeg(Math.asin(rho.dot(n) / rho.length()));
      if (incidence < MIN_INC || incidence > MAX_INC) return;
      pos.setXYZ(count * 2, n.x, n.y, n.z);
      pos.setXYZ(count * 2 + 1, p.x, p.y, p.z);
      names.push(this.sats[i].tle.name);
      count++;
    });
    pos.needsUpdate = true;
    this.links.geometry.setDrawRange(0, count * 2);
    const key = names.join("|");
    if (key !== this.accessKey) {
      this.accessKey = key;
      this.onAccess(names);
    }
  }

  /** Each satellite's orbit drawn as a ring, as it stands at this moment. */
  private updateRings(date: Date) {
    if (!this.rings) return;
    const gmst = satellite.gstime(date);
    const pos = this.rings.geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = this.rings.geometry.getAttribute("color") as THREE.BufferAttribute;
    const t0 = date.getTime();
    this.sats.forEach((s, si) => {
      const hot = this.planned.has(s.tle.norad_id);
      const c = hot ? ORANGE : BONE;
      const k = hot ? 0.8 : 0.085;
      let prev: THREE.Vector3 | null = null;
      const pts: (THREE.Vector3 | null)[] = [];
      for (let j = 0; j <= RING_POINTS; j++) pts.push(positionAt(s.rec, new Date(t0 + (j / RING_POINTS) * s.periodMin * 60_000), gmst));
      for (let j = 0; j < RING_POINTS; j++) {
        const a: THREE.Vector3 | null = pts[j] ?? prev;
        const b: THREE.Vector3 | null = pts[j + 1] ?? a;
        const base = (si * RING_POINTS + j) * 2;
        if (a && b) {
          pos.setXYZ(base, a.x, a.y, a.z);
          pos.setXYZ(base + 1, b.x, b.y, b.z);
        }
        // Fade along the ring so the direction of travel is visible.
        const fade = k * (1 - 0.8 * (j / RING_POINTS));
        col.setXYZ(base, c.r * fade, c.g * fade, c.b * fade);
        col.setXYZ(base + 1, c.r * fade, c.g * fade, c.b * fade);
        prev = a;
      }
    });
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  private occluded(p: THREE.Vector3): boolean {
    const cam = this.camera.position;
    const dir = p.clone().sub(cam);
    const len = dir.length();
    dir.divideScalar(len);
    const b = cam.dot(dir);
    const disc = b * b - (cam.lengthSq() - 0.99);
    if (disc <= 0) return false;
    const t = -b - Math.sqrt(disc);
    return t > 0 && t < len - 0.02;
  }

  private toScreen(p: THREE.Vector3): { x: number; y: number } {
    const s = p.clone().project(this.camera);
    return { x: (s.x * 0.5 + 0.5) * this.container.clientWidth, y: (-s.y * 0.5 + 0.5) * this.container.clientHeight };
  }

  private nearestMarker(x: number, y: number, radius: number): { marker: Marker; x: number; y: number } | null {
    let best: { marker: Marker; x: number; y: number } | null = null;
    let bestDist = radius;
    this.markerPositions.forEach((p, i) => {
      if (this.occluded(p)) return;
      const s = this.toScreen(p);
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestDist) {
        bestDist = d;
        best = { marker: this.markers[i], ...s };
      }
    });
    return best;
  }

  private updateHover() {
    if (!this.pointer) return;
    const { x, y } = this.pointer;
    const hit = this.nearestMarker(x, y, 14);
    if (hit) {
      this.renderer.domElement.style.cursor = "pointer";
      return this.onHover({ kind: "event", name: hit.marker.label, detail: "Click to open", planned: false, x: hit.x, y: hit.y });
    }
    this.renderer.domElement.style.cursor = "";
    let best: HoverInfo | null = null;
    let bestDist = 14;
    this.satPositions.forEach((p, i) => {
      if (!p || this.occluded(p)) return;
      const s = this.toScreen(p);
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestDist) {
        bestDist = d;
        const sat = this.sats[i];
        best = { kind: "satellite", name: sat.tle.name, detail: `${Math.round((p.length() - 1) * 6371)} km altitude`, planned: this.planned.has(sat.tle.norad_id), ...s };
      }
    });
    const g = this.latency;
    if (!best && g && this.latencyFade.target === 1) {
      const at = this.pointerLatLon(x, y);
      if (at) {
        const row = Math.min(g.rows - 1, Math.max(0, Math.floor((at.lat + 90) / g.cellDeg)));
        const col = Math.floor((((at.lon + 180) % 360) + 360) % 360 / g.cellDeg) % g.cols;
        const h = g.hours[row * g.cols + col];
        const n = g.looks[row * g.cols + col];
        const where = `${Math.abs(at.lat).toFixed(1)}°${at.lat >= 0 ? "N" : "S"} ${Math.abs(at.lon).toFixed(1)}°${at.lon >= 0 ? "E" : "W"}`;
        const wait = h == null ? `no look in ${g.horizonHours} h` : h < 1 ? `first look in ${Math.round(h * 60)} min` : `first look in ${h.toFixed(1)} h`;
        best = { kind: "cell", name: where, detail: `${wait} · ${n} look${n === 1 ? "" : "s"} in ${g.horizonHours} h`, planned: false, x, y };
      }
    }
    this.onHover(best);
  }

  private emitHud() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const d = this.camera.position.length();
    // Apparent radius of the sphere on screen.
    const r = (h / 2) * (1 / Math.sqrt(d * d - 1)) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const c = this.camera.position;
    let target: Hud["target"] = null;
    if (this.targetNormal) {
      const p = this.targetNormal.clone().multiplyScalar(1.005);
      target = { ...this.toScreen(p), visible: !this.occluded(p) };
    }
    this.onFrame({
      cx: w / 2,
      cy: h / 2,
      r,
      camLat: THREE.MathUtils.radToDeg(Math.asin(c.y / d)),
      camLon: THREE.MathUtils.radToDeg(Math.atan2(-c.z, c.x)),
      target,
    });
  }

  private animate = () => {
    this.raf = requestAnimationFrame(this.animate);
    const now = performance.now();
    const date = this.simTime();

    if (this.fly) {
      const t = Math.min(1, (now - this.fly.start) / 1500);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const len = THREE.MathUtils.lerp(this.fly.from.length(), this.fly.to.length(), e);
      this.camera.position.copy(this.fly.from.clone().normalize().lerp(this.fly.to.clone().normalize(), e).normalize().multiplyScalar(len));
      if (t >= 1) this.fly = null;
    }
    this.controls.update();

    this.earthMaterial.uniforms.sunDir.value.copy(sunDirection(date));
    this.eventMaterial.uniforms.uTime.value = now / 1000;
    const fade = this.latencyFade;
    if (fade.value !== fade.target) fade.value = THREE.MathUtils.clamp(fade.value + Math.sign(fade.target - fade.value) * 0.04, 0, 1);
    this.latencyMaterial.uniforms.opacity.value = fade.value;
    this.latencyMaterial.uniforms.uTime.value = now / 1000;
    if (this.latencyMesh) this.latencyMesh.visible = fade.value > 0;
    this.updateSatellites(date);
    this.updateAccess();
    if (now - this.lastRingUpdate > (this.speed > 30 ? 120 : 1500)) {
      this.updateRings(date);
      this.lastRingUpdate = now;
    }
    if (this.pulse) {
      const phase = (now % 2200) / 2200;
      this.pulse.scale.setScalar(1 + phase * 2.4);
      (this.pulse.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - phase);
    }
    (this.links.material as THREE.LineBasicMaterial).opacity = 0.55 + 0.4 * Math.sin(now / 140);
    if (now - this.lastTick > 200) {
      this.lastTick = now;
      this.onTick(date);
      this.updateHover();
    }
    this.renderer.render(this.scene, this.camera);
    this.emitHud();
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
