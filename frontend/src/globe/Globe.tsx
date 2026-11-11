import { useEffect, useMemo, useRef, useState } from "react";
import type { Tle } from "../types";
import { GlobeScene, type HoverInfo, type LatencyGrid, type Marker, type Target } from "./scene";

interface Props {
  satellites: Tle[];
  target: Target | null;
  targetLabel: string | null;
  markers: Marker[];
  selectedMarker: string | null;
  speed: number;
  resetKey: number;
  latency: LatencyGrid | null;
  onTick: (date: Date) => void;
  onPick: (id: string) => void;
  onAccess: (names: string[]) => void;
}

const coord = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(1).padStart(5, "0")}${v >= 0 ? pos : neg}`;

export default function Globe({ satellites, target, targetLabel, markers, selectedMarker, speed, resetKey, latency, onTick, onPick, onAccess }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const dial = useRef<SVGGElement>(null);
  const reticle = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const scene = useRef<GlobeScene | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const cb = useRef({ onTick, onPick, onAccess });
  cb.current = { onTick, onPick, onAccess };

  useEffect(() => {
    if (!holder.current) return;
    try {
      const s = new GlobeScene(holder.current);
      s.onTick = (d) => cb.current.onTick(d);
      s.onPick = (id) => cb.current.onPick(id);
      s.onAccess = (n) => cb.current.onAccess(n);
      s.onHover = setHover;
      // The overlay follows the camera every frame, so it is moved directly instead of through React state.
      s.onFrame = (h) => {
        if (ring.current) {
          const size = h.r * 2.2;
          ring.current.style.transform = `translate(${h.cx - size / 2}px, ${h.cy - size / 2}px)`;
          ring.current.style.width = ring.current.style.height = `${size}px`;
        }
        dial.current?.setAttribute("transform", `rotate(${-h.camLon} 100 100)`);
        if (readout.current) readout.current.textContent = `VIEW ${coord(h.camLat, "N", "S")} ${coord(h.camLon, "E", "W")}`;
        if (reticle.current) {
          const t = h.target;
          reticle.current.style.opacity = t && t.visible ? "1" : "0";
          if (t) reticle.current.style.transform = `translate(${t.x}px, ${t.y}px)`;
        }
      };
      scene.current = s;
      return () => {
        s.dispose();
        scene.current = null;
      };
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (satellites.length) scene.current?.setSatellites(satellites);
  }, [satellites]);
  useEffect(() => {
    scene.current?.setTarget(target);
  }, [target, satellites]);
  useEffect(() => {
    scene.current?.setMarkers(markers, selectedMarker);
  }, [markers, selectedMarker]);
  useEffect(() => {
    scene.current?.setSpeed(speed);
  }, [speed]);
  useEffect(() => {
    if (resetKey) scene.current?.resetTime();
  }, [resetKey]);
  useEffect(() => {
    scene.current?.setLatency(latency);
  }, [latency]);

  const ticks = useMemo(() => Array.from({ length: 72 }, (_, i) => i * 5), []);

  return (
    <div className="globe" ref={holder}>
      {failed && <div className="globe-failed">The 3D view needs WebGL, which this browser has turned off.</div>}
      <div className="hud-ring" ref={ring} aria-hidden="true">
        <svg viewBox="0 0 200 200">
          <circle cx="100" cy="100" r="96" className="ring-line" />
          <g ref={dial}>
            {ticks.map((a) => (
              <line key={a} x1="100" y1={a % 30 === 0 ? 1 : 2.6} x2="100" y2="4" transform={`rotate(${a} 100 100)`} className={a % 30 === 0 ? "tick major" : "tick"} />
            ))}
            {[0, 90, 180, 270].map((a) => (
              <text key={a} x="100" y="9.5" transform={`rotate(${a} 100 100)`} className="ring-label">
                {String(a).padStart(3, "0")}
              </text>
            ))}
          </g>
          <path d="M100 0 L97.6 -4 L102.4 -4 Z" className="ring-pointer" transform="translate(0 4)" />
        </svg>
      </div>
      <div className="reticle" ref={reticle} key={targetLabel ?? "none"} aria-hidden="true">
        <i className="tl" />
        <i className="tr" />
        <i className="bl" />
        <i className="br" />
        {targetLabel && <span>{targetLabel}</span>}
      </div>
      <span className="cam-readout" ref={readout} aria-hidden="true" />
      {hover && (
        <div className="tip" style={{ left: hover.x + 14, top: hover.y - 10 }}>
          <strong>{hover.name}</strong>
          <span>{hover.detail}</span>
          {hover.planned && <span className="tip-hot">In this order's plan</span>}
        </div>
      )}
    </div>
  );
}
