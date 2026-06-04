import React, { useEffect, useId, useMemo, useRef, useState } from "react";

const HEAD_RADIUS = 78;
const TAIL_POINTS = 54;

type Point = {
  x: number;
  y: number;
};

type Size = {
  width: number;
  height: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function fmt(n: number) {
  return Number.isFinite(n) ? n.toFixed(2) : "0";
}

function buildLiquidPath(points: Point[], speed: number) {
  if (points.length < 2) return "";

  const outline: Point[] = [];
  const inner: Point[] = [];
  const lastIndex = points.length - 1;

  const stretch = clamp(speed * 5.5, 0, 260);

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const next = points[Math.min(i + 1, lastIndex)];

    const dx = next.x - p.x;
    const dy = next.y - p.y;
    const len = Math.hypot(dx, dy) || 1;

    const nx = -dy / len;
    const ny = dx / len;

    const t = i / lastIndex;
    const taper = Math.pow(1 - t, 2.9);
    const width = Math.max(1.5, HEAD_RADIUS * taper + stretch * (1 - t));

    outline.push({
      x: p.x + nx * width,
      y: p.y + ny * width,
    });

    inner.push({
      x: p.x - nx * width,
      y: p.y - ny * width,
    });
  }

  const shape = [...outline, ...inner.reverse()];
  if (shape.length < 3) return "";

  let d = `M ${fmt(shape[0].x)} ${fmt(shape[0].y)}`;

  for (let i = 1; i < shape.length; i++) {
    const prev = shape[i - 1];
    const curr = shape[i];
    const mx = (prev.x + curr.x) / 2;
    const my = (prev.y + curr.y) / 2;
    d += ` Q ${fmt(prev.x)} ${fmt(prev.y)} ${fmt(mx)} ${fmt(my)}`;
  }

  d += " Z";
  return d;
}

export default function App() {
  const [size, setSize] = useState<Size>({
    width: typeof window !== "undefined" ? window.innerWidth : 0,
    height: typeof window !== "undefined" ? window.innerHeight : 0,
  });

  const [tail, setTail] = useState<Point[]>(() => {
    const startX = typeof window !== "undefined" ? window.innerWidth / 2 : 0;
    const startY = typeof window !== "undefined" ? window.innerHeight / 2 : 0;

    return Array.from({ length: TAIL_POINTS }, () => ({
      x: startX,
      y: startY,
    }));
  });

  const [alpha, setAlpha] = useState(0);
  const [speed, setSpeed] = useState(0);

  const baseId = useId().replace(/:/g, "");
  const outerClipId = `${baseId}-outer-clip`;
  const innerClipId = `${baseId}-inner-clip`;
  const glowId = `${baseId}-glow`;

  const speedRef = useRef(0);

  useEffect(() => {
    const updateSize = () => {
      setSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  useEffect(() => {
    let active = true;
    let rafId = 0;

    const target = {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    };

    const current = {
      x: target.x,
      y: target.y,
    };

    const trail = Array.from({ length: TAIL_POINTS }, () => ({
      x: target.x,
      y: target.y,
    }));

    let currentAlpha = 0;
    let targetAlpha = 0;
    let prevX = current.x;
    let prevY = current.y;

    const animate = () => {
      if (!active) return;

      current.x += (target.x - current.x) * 0.14;
      current.y += (target.y - current.y) * 0.14;

      const vx = current.x - prevX;
      const vy = current.y - prevY;
      const instantSpeed = Math.hypot(vx, vy);

      speedRef.current += (instantSpeed - speedRef.current) * 0.18;

      prevX = current.x;
      prevY = current.y;

      trail[0].x = current.x;
      trail[0].y = current.y;

      for (let i = 1; i < trail.length; i++) {
        trail[i].x += (trail[i - 1].x - trail[i].x) * 0.22;
        trail[i].y += (trail[i - 1].y - trail[i].y) * 0.22;
      }

      currentAlpha += (targetAlpha - currentAlpha) * 0.12;

      setTail([...trail]);
      setAlpha(currentAlpha);
      setSpeed(speedRef.current);

      rafId = requestAnimationFrame(animate);
    };

    const onMove = (x: number, y: number) => {
      target.x = x;
      target.y = y;
      targetAlpha = 1;
    };

    const onMouseMove = (e: MouseEvent) => {
      onMove(e.clientX, e.clientY);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        onMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    };

    const onLeave = () => {
      targetAlpha = 0;
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("mouseleave", onLeave);
    document.body.addEventListener("mouseleave", onLeave);

    rafId = requestAnimationFrame(animate);

    return () => {
      active = false;
      cancelAnimationFrame(rafId);

      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("mouseleave", onLeave);
      document.body.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  const liquidPath = useMemo(() => buildLiquidPath(tail, speed), [tail, speed]);

  const outerClipPath = useMemo(() => {
    if (!liquidPath || size.width === 0 || size.height === 0) return "";

    return `M 0 0 H ${size.width} V ${size.height} H 0 Z ${liquidPath}`;
  }, [liquidPath, size.width, size.height]);

  const outsideStyle: React.CSSProperties = {
    fontFamily: '"Space Grotesk", sans-serif',
    clipPath: outerClipPath ? `url(#${outerClipId})` : "none",
    WebkitClipPath: outerClipPath ? `url(#${outerClipId})` : "none",
  };

  const insideStyle: React.CSSProperties = {
    fontFamily: '"Space Grotesk", sans-serif',
    clipPath: liquidPath ? `url(#${innerClipId})` : "none",
    WebkitClipPath: liquidPath ? `url(#${innerClipId})` : "none",
    opacity: alpha > 0.01 ? 1 : 0,
    visibility: alpha > 0.01 ? "visible" : "hidden",
    backfaceVisibility: "hidden",
    WebkitBackfaceVisibility: "hidden",
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden select-none bg-[#d8d8d8]">
      <svg
        width="0"
        height="0"
        aria-hidden="true"
        focusable="false"
        style={{ position: "absolute" }}
      >
        <defs>
          <filter
            id={glowId}
            x="-50%"
            y="-50%"
            width="200%"
            height="200%"
            colorInterpolationFilters="sRGB"
          >
            <feGaussianBlur stdDeviation="12" />
          </filter>

          <clipPath
            id={outerClipId}
            clipPathUnits="userSpaceOnUse"
          >
            <path d={outerClipPath} fillRule="evenodd" />
          </clipPath>

          <clipPath
            id={innerClipId}
            clipPathUnits="userSpaceOnUse"
          >
            <path d={liquidPath} />
          </clipPath>
        </defs>
      </svg>

      <div
        style={{
          ...outsideStyle,
          zIndex: 10,
          textRendering: "geometricPrecision",
          WebkitFontSmoothing: "antialiased",
        }}
        className="absolute inset-0 pointer-events-none flex items-start justify-center pt-24 text-center font-medium uppercase tracking-[0.22em] text-neutral-500 text-lg sm:text-xl md:text-2xl lg:text-[27px]"
      >
        CURIOUS · THOUGHTFUL · RESILIENT · DRIVEN
      </div>

      <div
        style={{
          ...insideStyle,
          zIndex: 11,
          textRendering: "geometricPrecision",
          WebkitFontSmoothing: "antialiased",
        }}
        className="absolute inset-0 pointer-events-none flex items-start justify-center pt-24 text-center font-medium uppercase tracking-[0.22em] text-neutral-500 text-lg sm:text-xl md:text-2xl lg:text-[27px]"
      >
        CREATIVE · UNSTOPPABLE · VISIONARY · BOLD
      </div>

      <svg
        className="fixed inset-0 pointer-events-none"
        width="100%"
        height="100%"
        style={{
          zIndex: 40,
          opacity: alpha,
          overflow: "visible",
        }}
      >
        <path
          d={liquidPath}
          fill="rgba(255,255,255,0.18)"
          stroke="rgba(255,255,255,0.38)"
          strokeWidth="1"
        />
        <path
          d={liquidPath}
          fill="rgba(255,255,255,0.08)"
          filter={`url(#${glowId})`}
          opacity="0.8"
        />
      </svg>
    </div>
  );
}