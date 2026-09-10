import React, { useEffect, useState } from "react";

// Live wall clock (HH:MM with small seconds) — the centerpiece of My Day and
// of the worker's scan page. Styled by the surrounding .clock-hero.
export default function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="time">
      {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
      <span className="sec">:{String(now.getSeconds()).padStart(2, "0")}</span>
    </div>
  );
}
