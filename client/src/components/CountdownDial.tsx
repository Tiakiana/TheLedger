/** Small circular timer: the ring empties as the deadline approaches, with the remaining seconds inside. */
export function CountdownDial({ remainingMs, totalMs, size = 44, label, showSeconds = true }: { remainingMs: number; totalMs: number; size?: number; label?: string; showSeconds?: boolean }) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, remainingMs / totalMs));
  const secs = Math.max(0, Math.ceil(remainingMs / 1000));
  return (
    <div className="dial" style={{ width: size, height: size }} role="timer" aria-label={label ?? `${secs} seconds remaining`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} className="dial-track" strokeWidth={4} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className="dial-fill"
          strokeWidth={4}
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          strokeLinecap="round"
        />
      </svg>
      {showSeconds && <span className="dial-text">{secs}</span>}
    </div>
  );
}
