// A cover for a record without a picture: an SVG drawn from the hash of its name (gradient, pattern) and the icon of
// its category. No network, no randomness: the same row always looks the same, in the theme's colours.
import { Apple, Book, Car, Coffee, Dumbbell, Flower2, Footprints, Gamepad2, Gift, Image, Laptop, Music, Package, Pill, Shirt, Sofa, Ticket, type LucideIcon } from 'lucide-react';
import { hash, hueOf } from '@/lib/visual';
import { cn } from '@/lib/utils';

const ICONS: Record<string, LucideIcon> = {
  coffee: Coffee, image: Image, book: Book, shirt: Shirt, footprints: Footprints, music: Music, gamepad: Gamepad2, apple: Apple,
  flower: Flower2, laptop: Laptop, sofa: Sofa, gift: Gift, car: Car, pill: Pill, dumbbell: Dumbbell, ticket: Ticket, package: Package,
};
export const wordIcon = (word: string): LucideIcon => ICONS[word] ?? Package;

function Pattern({ kind, id }: { kind: number; id: string }) {
  const stroke = { stroke: 'white', strokeOpacity: 0.22, fill: 'none' } as const;
  if (kind === 0) {
    return <g {...stroke} strokeWidth={1.5}>{[40, 80, 120, 160, 200].map((r) => <circle key={r} cx="88%" cy="12%" r={r} />)}</g>;
  }
  if (kind === 1) {
    return <g {...stroke} strokeWidth={2}>{[0, 1, 2, 3, 4, 5].map((i) => <path key={i} d={`M-20 ${60 + i * 34} C 80 ${20 + i * 34}, 160 ${110 + i * 34}, 420 ${50 + i * 34}`} />)}</g>;
  }
  if (kind === 2) {
    return (
      <>
        <defs>
          <pattern id={`${id}-dots`} width="18" height="18" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1.6" fill="white" fillOpacity="0.28" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${id}-dots)`} />
      </>
    );
  }
  return (
    <>
      <defs>
        <pattern id={`${id}-stripes`} width="22" height="22" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
          <rect width="9" height="22" fill="white" fillOpacity="0.12" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id}-stripes)`} />
    </>
  );
}

export function Cover({ name, icon = 'package', className, size = 'md' }: { name: string; icon?: string; className?: string; size?: 'md' | 'lg' }) {
  const h = hash(name);
  const hue = hueOf(name);
  const id = `cv${h.toString(36)}`;
  const Icon = wordIcon(icon);
  const from = `color-mix(in oklab, oklch(0.62 0.16 ${hue}) 55%, var(--brand))`;
  const to = `color-mix(in oklab, oklch(0.78 0.12 ${(hue + 50) % 360}) 70%, var(--brand))`;
  return (
    <div className={cn('relative overflow-hidden', className)} aria-hidden="true">
      <svg className="absolute inset-0 size-full" preserveAspectRatio="xMidYMid slice" viewBox="0 0 400 300">
        <defs>
          <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: from }} />
            <stop offset="1" style={{ stopColor: to }} />
          </linearGradient>
          <radialGradient id={`${id}-l`} cx="20%" cy="0%" r="90%">
            <stop offset="0" stopColor="white" stopOpacity="0.35" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="400" height="300" fill={`url(#${id}-g)`} />
        <Pattern kind={h % 4} id={id} />
        <rect width="400" height="300" fill={`url(#${id}-l)`} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className={cn('flex items-center justify-center rounded-2xl bg-white/20 text-white shadow-lg ring-1 ring-white/30 backdrop-blur-sm',
          size === 'lg' ? 'size-24' : 'size-14')}>
          <Icon className={size === 'lg' ? 'size-11' : 'size-7'} strokeWidth={1.6} />
        </span>
      </div>
      <div className="absolute inset-0 bg-black/0 dark:bg-black/15" />
    </div>
  );
}
