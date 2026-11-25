// References: a JSON row carries a referenced row's id; its caption comes with it from the server
// (`_labels`, readOnly in the OpenAPI row schema) for each reference the viewer may see. The choices of a select or a filter are the
// rows of the target entity the viewer may read, loaded once per entity.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { app } from '@/gen/app';
import { endpoints } from '@/gen/endpoints';
import type { Row } from '@/lib/api';
import type { Viewer } from '@/lib/perms';
import { can } from '@/lib/perms';

export type Option = { id: string; label: string };

const labelOf = (entity: string, row: Row) => {
  const lf = app.entities[entity]?.labelField;
  return lf && row[lf] !== null && row[lf] !== undefined && row[lf] !== '' ? String(row[lf]) : `#${row.id}`;
};

async function allRows(entity: string): Promise<Option[]> {
  const out: Option[] = [];
  for (let page = 1; page <= 20; page++) {
    const p = await endpoints.entities[entity].list({ page });
    out.push(...p.rows.map((r) => ({ id: String(r.id), label: labelOf(entity, r) })));
    if (page >= p.pages) break;
  }
  return out;
}

export const optionsKey = (target: string) => ['options', target] as const;

/** The rows a reference may point at, for a select or a filter; nothing when the viewer cannot read them. */
export function useOptions(target: string | null, viewer: Viewer) {
  const enabled = Boolean(target) && can(viewer, target!, 'view');
  return useQuery({ queryKey: optionsKey(target ?? ''), queryFn: () => allRows(target!), enabled, staleTime: 60_000 });
}

/** The caption of a reference cell: the server's label, a choice already loaded, the viewer themself, else "#id". */
export function useRefLabel() {
  const qc = useQueryClient();
  return (row: Row, field: string, target: string, viewer: Viewer): string | null => {
    const id = row[field];
    if (id === null || id === undefined || id === '') return null;
    const given = (row._labels as Record<string, unknown> | undefined)?.[field];
    if (given !== undefined && given !== null && given !== '') return String(given);
    const loaded = qc.getQueryData<Option[]>(optionsKey(target))?.find((o) => o.id === String(id));
    if (loaded) return loaded.label;
    if (app.roles && target === app.roles.entity && viewer.user && String(viewer.user.id) === String(id)) return 'You';
    return `#${id}`;
  };
}
