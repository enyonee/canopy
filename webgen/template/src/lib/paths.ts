// The runtime's paths are the front end's paths: /Entity, /Entity/:id, /list/<id>, /dashboard/<id>, /page/<id>.
// An `after` of the graph ("/list/cart", "/Order/{order}") is followed as written, with its placeholders filled.
import type { Row } from '@/lib/api';

export function fillPath(template: string, row: Row | undefined, extra: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { ...(row ?? {}), ...extra };
  return template.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(String(values[k] ?? '')));
}

/** A path inside this front end, or null for one that leaves it (another site, the admin console). */
export function inApp(path: string | null | undefined) {
  if (!path || !path.startsWith('/') || path.startsWith('//')) return null;
  return path;
}
