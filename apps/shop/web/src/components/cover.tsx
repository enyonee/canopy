// The picture of a record that has none: one tone per category (the theme's ordinal tones, contrast-checked: the
// icon in the tone's text colour reads at 4.5:1 on its background), a soft radial light, and the category's icon.
// No patterns, no colour per row: a catalogue without photos stays calm, and the same row always looks the same.
import { Apple, Book, Car, Coffee, Dumbbell, Flower2, Footprints, Gamepad2, Gift, Image, Laptop, Music, Package, Pill, Shirt, Sofa, Ticket, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

const ICONS: Record<string, LucideIcon> = {
  coffee: Coffee, image: Image, book: Book, shirt: Shirt, footprints: Footprints, music: Music, gamepad: Gamepad2, apple: Apple,
  flower: Flower2, laptop: Laptop, sofa: Sofa, gift: Gift, car: Car, pill: Pill, dumbbell: Dumbbell, ticket: Ticket,
};

export function Cover({ name, icon, tone = 0, className, size = 'md' }: { name: string; icon?: string; tone?: number; className?: string; size?: 'sm' | 'md' | 'lg' }) {
  const Icon = icon ? ICONS[icon] : undefined;
  const fallback = !Icon && icon === 'package' ? Package : undefined;
  const Glyph = Icon ?? fallback;
  const big = size === 'lg' ? 'size-20' : size === 'sm' ? 'size-7' : 'size-12';
  const style = { background: `radial-gradient(120% 90% at 30% 15%, color-mix(in oklab, var(--tone-${tone}-bg) 55%, var(--card)), var(--tone-${tone}-bg) 70%)`, color: `var(--tone-${tone}-fg)` };
  return (
    <div className={cn('relative flex items-center justify-center overflow-hidden', className)} style={style} aria-hidden="true">
      {Glyph ? <Glyph className={big} strokeWidth={1.4} />
        : <span className={cn('font-semibold', size === 'lg' ? 'text-6xl' : size === 'sm' ? 'text-sm' : 'text-4xl')}>{name.slice(0, 1).toUpperCase()}</span>}
    </div>
  );
}
