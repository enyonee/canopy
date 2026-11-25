// Create (`/Entity/new`) and edit (`/Entity/:id/edit`): the form's fields for the viewer's role, without what the
// server fills itself (`fill`, the viewer's own field), then the graph's `after`/`afterEdit` or the row's page.
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useRouter } from '@tanstack/react-router';
import { app } from '@/gen/app';
import { endpoints } from '@/gen/endpoints';
import type { Entity } from '@/lib/model';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/page-header';
import { ErrorState } from '@/components/states';
import { Guard } from '@/components/guard';
import { EntityForm } from '@/components/entity-form';
import { rowName } from '@/lib/rows';
import { can, ownField, type Viewer } from '@/lib/perms';
import { useViewer } from '@/lib/session';
import { useRun } from '@/lib/run';

export function formNames(entity: Entity, viewer: Viewer) {
  const own = ownField(viewer, entity.name);
  return (entity.form.byRole[viewer.role ?? ''] ?? entity.form.fields).filter((n) => n !== own && !entity.form.fill.includes(n));
}

function FormBody({ entity, mode }: { entity: Entity; mode: 'new' | 'edit' }) {
  const { id } = useParams({ strict: false }) as { id?: string };
  const viewer = useViewer();
  const run = useRun();
  const router = useRouter();
  const navigate = useNavigate();
  const data = useQuery({ queryKey: ['row', entity.name, Number(id)], queryFn: () => endpoints.entities[entity.name].get(Number(id)), enabled: mode === 'edit' });
  const title = entity.form.title ?? (mode === 'new' ? `New ${entity.label.toLowerCase()}` : `Edit ${entity.label.toLowerCase()}`);
  const listCrumb = { label: entity.list.title, to: !entity.list.hidden ? `/${entity.name}` : undefined };
  if (mode === 'edit' && data.isError) return <ErrorState error={data.error} />;
  const row = mode === 'edit' ? data.data : null;
  const back = () => (router.history.length > 1 ? router.history.back() : void navigate({ to: row ? `/${entity.name}/${row.id}` : `/${entity.name}` }));
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={title} description={entity.form.intro ?? undefined}
        crumbs={[listCrumb, ...(row ? [{ label: rowName(entity, row), to: `/${entity.name}/${row.id}` }] : []), { label: mode === 'new' ? 'New' : 'Edit' }]} />
      <Card>
        <CardContent>
          {mode === 'edit' && !row ? (
            <div className="grid gap-5 sm:grid-cols-2" aria-busy="true">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-16" />)}</div>
          ) : (
            <EntityForm entity={entity} names={formNames(entity, viewer)} row={row} viewer={viewer} onCancel={back}
              submit={entity.form.submit ?? (mode === 'new' ? `Create ${entity.label.toLowerCase()}` : 'Save changes')}
              onSubmit={(body) => run.mutateAsync({
                go: () => (row ? endpoints.entities[entity.name].update(row.id, body) : endpoints.entities[entity.name].create(body)),
                opts: { inline: true, row: row ?? undefined, after: (row ? entity.form.afterEdit : entity.form.after) ?? `/${entity.name}/{id}` },
              })} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function FormScreen({ entity, mode }: { entity: string; mode: 'new' | 'edit' }) {
  const e = app.entities[entity];
  return <Guard allow={(v) => can(v, entity, mode === 'new' ? 'create' : 'edit')}><FormBody entity={e} mode={mode} /></Guard>;
}
