// A person's initials in a circle tinted by a hash of their name: the same person, the same colour, everywhere.
import { avatarStyle } from '@/lib/visual';
import { initials } from '@/lib/format';
import { cn } from '@/lib/utils';

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  return (
    <span className={cn('flex shrink-0 items-center justify-center rounded-full font-semibold', size === 'sm' ? 'size-6 text-[10px]' : 'size-8 text-xs')}
      style={avatarStyle(name)} aria-hidden="true">{initials(name)}</span>
  );
}
