import { useCallback, useEffect, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

/** Draggable column widths for the desktop layout (nav | main | agent), remembered per browser. */

export interface Widths { nav: number; agent: number }

export const DEFAULT_WIDTHS: Widths = { nav: 180, agent: 380 };
const KEY = "rp:widths";
const MIN = { nav: 120, agent: 260 };
const MAIN_MIN = 360; // keep the centre usable

export function clampWidths(w: Widths, viewport: number): Widths {
  const nav = Math.round(Math.min(Math.max(w.nav, MIN.nav), 420));
  const agentMax = Math.max(MIN.agent, viewport - nav - MAIN_MIN);
  const agent = Math.round(Math.min(Math.max(w.agent, MIN.agent), agentMax));
  return { nav, agent };
}

function load(): Widths {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Widths> | null;
    if (raw && typeof raw.nav === "number" && typeof raw.agent === "number") return { nav: raw.nav, agent: raw.agent };
  } catch { /* storage blocked or bad JSON: defaults */ }
  return DEFAULT_WIDTHS;
}

export function useColumnWidths(): [Widths, (w: Widths) => void] {
  const [widths, setWidths] = useState<Widths>(() => clampWidths(load(), window.innerWidth));
  const set = useCallback((w: Widths) => {
    const c = clampWidths(w, window.innerWidth);
    setWidths(c);
    try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    const onResize = () => setWidths((w) => clampWidths(w, window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return [widths, set];
}

interface Props {
  side: "nav" | "agent";
  widths: Widths;
  onChange: (w: Widths) => void;
}

/** A thin vertical handle on the nav's right edge or the agent's left edge. */
export function Splitter({ side, widths, onChange }: Props) {
  const [drag, setDrag] = useState(false);
  const value = widths[side];
  const apply = (v: number) => onChange({ ...widths, [side]: v });

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(true);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    apply(side === "nav" ? e.clientX : window.innerWidth - e.clientX);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDrag(false);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const grow = side === "nav" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "nav" ? "ArrowLeft" : "ArrowRight";
    if (e.key === grow) apply(value + step);
    else if (e.key === shrink) apply(value - step);
    else if (e.key === "Enter") apply(DEFAULT_WIDTHS[side]);
    else return;
    e.preventDefault();
  };

  useEffect(() => {
    document.body.classList.toggle("col-resizing", drag);
    return () => document.body.classList.remove("col-resizing");
  }, [drag]);

  return (
    <div
      className={`splitter splitter-${side}${drag ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "nav" ? "Resize panel list" : "Resize agent"}
      aria-valuenow={value}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => apply(DEFAULT_WIDTHS[side])}
      onKeyDown={key}
    />
  );
}
