import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function RoleTooltip({ anchor, text }: { anchor: HTMLElement | null; text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      if (!ref.current) return;
      const box = anchor.getBoundingClientRect();
      const hint = ref.current.getBoundingClientRect();
      const left = Math.max(12, Math.min(box.left + (box.width - hint.width) / 2, window.innerWidth - hint.width - 12));
      const below = box.bottom + 12;
      const top = below + hint.height <= window.innerHeight - 12 ? below : Math.max(12, box.top - hint.height - 12);
      setPosition({ left, top });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchor, text]);
  return anchor ? createPortal(<div ref={ref} role="tooltip" className="floating-ability" style={position}>{text}</div>, document.body) : null;
}
