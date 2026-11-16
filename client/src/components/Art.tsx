import { hueOf, initials } from '../lib/format';

/** Item or currency artwork: the uploaded image, or a generated monogram placeholder. */
export function Art({ url, name, className = '', round }: { url: string | null; name: string; className?: string; round?: boolean }) {
  if (url) return <img className={`art ${round ? 'art-round' : ''} ${className}`} src={url} alt="" loading="lazy" draggable={false} />;
  const h = hueOf(name);
  return (
    <div
      className={`art art-placeholder ${round ? 'art-round' : ''} ${className}`}
      style={{ background: `linear-gradient(135deg, hsl(${h} 32% 82%), hsl(${(h + 40) % 360} 30% 70%))`, color: `hsl(${h} 35% 25%)` }}
      aria-hidden="true"
    >
      <span>{initials(name)}</span>
    </div>
  );
}
