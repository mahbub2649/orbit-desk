import { useEffect, useRef, useState, type ReactNode } from "react";

const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A number that counts up to its value when it changes. */
export function Count({ value, decimals = 0, suffix = "" }: { value: number; decimals?: number; suffix?: string }) {
  const [shown, setShown] = useState(reduced() ? value : 0);
  const from = useRef(0);
  useEffect(() => {
    if (reduced()) return setShown(value);
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 700);
      const v = a + (value - a) * (1 - Math.pow(1 - k, 3));
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <>
      {shown.toFixed(decimals)}
      {suffix}
    </>
  );
}

const GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789/#<>";

/** Text that resolves from random characters, left to right, when it changes. */
export function Scramble({ text }: { text: string }) {
  const [out, setOut] = useState(text);
  useEffect(() => {
    if (reduced()) return setOut(text);
    let frame = 0;
    const total = 16;
    const id = setInterval(() => {
      frame++;
      const solid = Math.floor((frame / total) * text.length);
      setOut(
        text
          .split("")
          .map((ch, i) => (i < solid || ch === " " ? ch : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]))
          .join(""),
      );
      if (frame >= total) {
        clearInterval(id);
        setOut(text);
      }
    }, 28);
    return () => clearInterval(id);
  }, [text]);
  return <span aria-label={text}>{out}</span>;
}

export function Plate({ title, index, right, children, className = "" }: { title?: string; index?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`plate ${className}`}>
      {title && (
        <header className="plate-head">
          <h2>
            {index && <span className="idx">{index}</span>}
            {title}
          </h2>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, children, tone }: { label: string; children: ReactNode; tone?: "hot" | "ok" | "bad" }) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

export function Bar({ value, tone = "hot" }: { value: number; tone?: "hot" | "dim" }) {
  return (
    <span className={`bar ${tone}`} aria-hidden="true">
      <i style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </span>
  );
}
