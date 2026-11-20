import { useEffect, useRef } from "react";
import laptopRotAsset from "@/assets/laptopRot.png";

interface WebrotLogoProps {
  compact?: boolean;
  interactive?: boolean;
  className?: string;
}

const laptopRotSrc = typeof laptopRotAsset === "string" ? laptopRotAsset : laptopRotAsset.src;

export function LaptopRotIcon({ size = 32 }: { size?: number }) {
  const width = Math.round((size * 180) / 160);
  return (
    <img
      src={laptopRotSrc}
      alt=""
      width={width}
      height={size}
      aria-hidden="true"
      draggable={false}
      className="wt-brand-mark"
      style={{ width, height: size, objectFit: "contain", display: "block" }}
    />
  );
}

export function WebrotLogo({ compact = false, interactive = false, className = "" }: WebrotLogoProps) {
  const hostRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!interactive) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // smooth pointer-follow lerp tilt for the landing wordmark
    let mouseX = 0;
    let mouseY = 0;
    let lerpedX = 0;
    let lerpedY = 0;
    let rafId = 0;

    const onMove = (e: MouseEvent) => {
      mouseX = (e.clientX / window.innerWidth) * 18 - 9;
      mouseY = (e.clientY / window.innerHeight) * 14 - 7;
    };

    const tick = () => {
      lerpedX += (mouseX - lerpedX) * 0.05;
      lerpedY += (mouseY - lerpedY) * 0.05;
      if (hostRef.current) {
        hostRef.current.style.transform = `translate3d(${lerpedX.toFixed(2)}px, ${lerpedY.toFixed(2)}px, 0) rotate(${(lerpedX * 0.14).toFixed(2)}deg)`;
      }
      rafId = requestAnimationFrame(tick);
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    rafId = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(rafId);
    };
  }, [interactive]);

  return (
    <span ref={hostRef} className={`wt-logo ${compact ? "is-compact" : ""} ${className}`}>
      <LaptopRotIcon size={compact ? 28 : 54} />
      <span className="wt-wordmark">
        <span>web</span>
        <span className="wt-wordmark-accent">rot</span>
      </span>
    </span>
  );
}
