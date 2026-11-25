// The picture of a record that has none: a neutral muted surface with the icon of its category (or its initial).
// No pattern and no colour of its own, so a catalogue without photos stays calm; the same row always looks the same.
import { Apple, Book, Car, Coffee, Dumbbell, Flower2, Footprints, Gamepad2, Gift, Image, Laptop, Music, Package, Pill, Shirt, Sofa, Ticket, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

const ICONS: Record<string, LucideIcon> = {
  coffee: Coffee, image: Image, book: Book, shirt: Shirt, footprints: Footprints, music: Music, gamepad: Gamepad2, apple: Apple,
  flower: Flower2, laptop: Laptop, sofa: Sofa, gift: Gift, car: Car, pill: Pill, dumbbell: Dumbbell, ticket: Ticket,
};

export function Cover({ name, icon, className, size = 'md' }: { name: string; icon?: string; className?: string; size?: 'sm' | 'md' | 'lg' }) {
  const Icon = icon ? ICONS[icon] : undefined;
  const fallback = !Icon && icon === 'package' ? Package : undefined;
  const Glyph = Icon ?? fallback;
  const big = size === 'lg' ? 'size-16' : size === 'sm' ? 'size-6' : 'size-10';
  return (
    <div className={cn('relative flex items-center justify-center overflow-hidden bg-muted text-muted-foreground', className)} aria-hidden="true">
      {Glyph ? <Glyph className={cn(big, 'opacity-60')} strokeWidth={1.25} />
        : <span className={cn('font-semibold opacity-50', size === 'lg' ? 'text-6xl' : size === 'sm' ? 'text-sm' : 'text-4xl')}>{name.slice(0, 1).toUpperCase()}</span>}
    </div>
  );
}
