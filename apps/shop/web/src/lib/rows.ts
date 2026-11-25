import type { Entity } from '@/lib/model';
import type { Row } from '@/lib/api';

// How a row is titled: its label field when that field is required (a name, an email), else "Order #3" — an
// optional first text field (an order's address) labels a select well but titles a page badly.
export function rowName(entity: Entity, row: Row) {
  const lf = entity.labelField && entity.fields.find((f) => f.name === entity.labelField);
  return lf && lf.required && row[lf.name] ? String(row[lf.name]) : `${entity.label} #${row.id}`;
}
