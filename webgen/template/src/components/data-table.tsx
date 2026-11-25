// The rows of a list as a table on wide screens and as stacked cards on narrow ones, with sortable headers,
// a link to each row's own page and the row's actions.
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import type { Entity, Field } from '@/lib/model';
import type { Row } from '@/lib/api';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { FieldValue } from '@/components/field-value';
import { RowActions } from '@/components/row-actions';
import { rowName } from '@/lib/rows';
import { can, type Viewer } from '@/lib/perms';
import { cn } from '@/lib/utils';

export type Sort = { field: string; dir: 'asc' | 'desc' } | null;

const ID: Field = { name: 'id', label: 'ID', kind: 'int', type: 'integer', required: false, derived: true, secret: false, default: null, options: null, target: null, bounds: [], unique: false };
export const columnField = (entity: Entity, name: string) => (name === 'id' ? ID : entity.fields.find((f) => f.name === name));
const numeric = (f?: Field) => Boolean(f && (f.kind === 'money' || f.type === 'integer' || f.type === 'number') && f.kind !== 'ref');

type Props = {
  entity: Entity; rows: Row[]; columns: readonly string[]; rowActions: readonly string[]; viewer: Viewer;
  labels?: Readonly<Record<string, readonly string[]>>; sort?: Sort; onSort?: (field: string) => void; onEdit?: (row: Row) => void;
  caption: string; loading?: boolean; linkFirst?: boolean;
};

function SortHeader({ f, sort, onSort }: { f: Field; sort?: Sort; onSort?: (field: string) => void }) {
  const active = sort?.field === f.name;
  const Icon = !active ? ChevronsUpDown : sort?.dir === 'asc' ? ArrowUp : ArrowDown;
  if (!onSort || (f.derived && f.name !== 'id')) return <>{f.label}</>;
  return (
    <button type="button" onClick={() => onSort(f.name)} className={cn('-mx-1.5 inline-flex items-center gap-1 rounded px-1.5 py-1 uppercase hover:bg-muted hover:text-foreground', active && 'text-foreground')}>
      {f.label}
      <Icon className={cn('size-3.5', !active && 'opacity-40')} aria-hidden="true" />
    </button>
  );
}

export function DataTable({ entity, rows, columns, rowActions, viewer, labels = {}, sort, onSort, onEdit, caption, loading, linkFirst = true }: Props) {
  const cols = columns.map((c) => ({ name: c, f: columnField(entity, c) }));
  const hasActions = rowActions.length > 0;
  const mayOpen = can(viewer, entity.name, 'view');
  // The first column opens the row, unless it is itself a link (a reference to another row).
  const firstLinks = linkFirst && mayOpen && cols[0]?.f?.kind !== 'ref';
  const first = (r: Row, i: number, content: React.ReactNode) =>
    i === 0 && firstLinks ? <Link to={`/${entity.name}/${r.id}`} className="font-medium text-foreground underline-offset-4 hover:text-primary hover:underline">{content}</Link> : content;

  if (loading) {
    return (
      <div className="space-y-2 p-4" aria-busy="true" aria-label={`Loading ${caption}`}>
        {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }
  return (
    <>
      <div className="hidden md:block">
        <Table>
          <caption className="sr-only">{caption}</caption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {cols.map(({ name, f }) => (
                <TableHead key={name} className={cn(numeric(f) && 'text-right')} aria-sort={sort?.field === name ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {f ? <SortHeader f={f} sort={sort} onSort={onSort} /> : name}
                </TableHead>
              ))}
              {hasActions && <TableHead><span className="sr-only">Actions</span></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id} data-row-id={r.id}>
                {cols.map(({ name, f }, i) => (
                  <TableCell key={name} className={cn(numeric(f) && 'text-right')}>
                    {first(r, i, name === 'id' ? <span className="tabular-nums text-muted-foreground">#{r.id}</span> : <FieldValue entity={entity} field={f} row={r} viewer={viewer} labels={labels[name]} />)}
                  </TableCell>
                ))}
                {hasActions && <TableCell className="w-0"><RowActions entity={entity} row={r} names={rowActions} viewer={viewer} onEdit={onEdit} /></TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="divide-y md:hidden" aria-label={caption}>
        {rows.map((r) => (
          <li key={r.id} className="space-y-3 p-4" data-row-id={r.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 font-medium">{mayOpen && linkFirst ? <Link to={`/${entity.name}/${r.id}`} className="underline-offset-4 hover:text-primary hover:underline">{rowName(entity, r)}</Link> : rowName(entity, r)}</div>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {cols.slice(cols[0]?.name === entity.labelField || cols[0]?.name === 'id' ? 1 : 0).map(({ name, f }) => (
                <div key={name} className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{f?.label ?? name}</dt>
                  <dd className="truncate">{name === 'id' ? `#${r.id}` : <FieldValue entity={entity} field={f} row={r} viewer={viewer} labels={labels[name]} />}</dd>
                </div>
              ))}
            </dl>
            {hasActions && <div className="flex justify-end"><RowActions entity={entity} row={r} names={rowActions} viewer={viewer} onEdit={onEdit} /></div>}
          </li>
        ))}
      </ul>
    </>
  );
}
