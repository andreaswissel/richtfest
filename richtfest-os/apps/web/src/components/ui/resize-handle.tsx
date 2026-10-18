import type { CSSProperties } from "react";
import { cn } from "../../lib/utils";

/**
 * Vertical drag handle for a panel edge. `edge` says which edge of the panel it sits on: dragging away from the
 * panel widens it. Arrow keys step by 16 px, Home/End jump to the limits.
 */
export function ResizeHandle({ value, min, max, onChange, edge, label, className, style }: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  edge: "left" | "right";
  label: string;
  className?: string;
  style?: CSSProperties;
}) {
  const clamp = (n: number) => Math.round(Math.min(max, Math.max(min, n)));
  const sign = edge === "right" ? 1 : -1;
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      title={label}
      className={cn("resize-handle", className)}
      style={style}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          onChange(clamp(value + (event.key === "ArrowRight" ? 16 : -16) * sign));
        } else if (event.key === "Home") {
          event.preventDefault();
          onChange(min);
        } else if (event.key === "End") {
          event.preventDefault();
          onChange(max);
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const start = event.clientX, base = value, target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        target.dataset.dragging = "true";
        const move = (e: PointerEvent) => onChange(clamp(base + (e.clientX - start) * sign));
        const up = () => {
          delete target.dataset.dragging;
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", up);
          target.removeEventListener("pointercancel", up);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
        target.addEventListener("pointercancel", up);
      }}
    />
  );
}
