// A static page (`/page/<id>`): heading, paragraphs, links, its global actions and live sections (a saved list
// preview, a create form, a paragraph).
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { app } from '@/gen/app';
import { endpoints } from '@/gen/endpoints';
import type { Page } from '@/lib/model';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import { Guard } from '@/components/guard';
import { DataTable } from '@/components/data-table';
import { EntityForm } from '@/components/entity-form';
import { ErrorState } from '@/components/states';
import { canSee, can, type Viewer } from '@/lib/perms';
import { useViewer } from '@/lib/session';
import { useRun } from '@/lib/run';
import { formNames } from '@/screens/form-screen';
import { inApp } from '@/lib/paths';

function ListSection({ id, limit, viewer }: { id: string; limit?: number; viewer: Viewer }) {
  const l = app.lists.find((x) => x.id === id)!;
  const e = app.entities[l.entity];
  const data = useQuery({ queryKey: ['list', `list:${id}`, { page: 1 }], queryFn: () => endpoints.lists[id]({ page: 1 }) });
  if (!canSee(viewer, l.roles)) return null;
  return (
    <Card className="gap-0 overflow-hidden pb-0">
      <CardHeader className="border-b pb-4"><CardTitle><Link to={`/list/${id}`} className="hover:text-primary">{l.title}</Link></CardTitle></CardHeader>
      {data.isError ? <div className="p-4"><ErrorState error={data.error} /></div>
        : <DataTable entity={e} rows={(data.data?.rows ?? []).slice(0, limit ?? Infinity)} columns={l.columns} rowActions={[]} viewer={viewer} caption={l.title} loading={data.isPending} />}
    </Card>
  );
}

function PageBody({ page }: { page: Page }) {
  const viewer = useViewer();
  const run = useRun();
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={page.heading} />
      {page.body.map((p, i) => <p key={i} className="leading-relaxed text-muted-foreground">{p}</p>)}
      {page.links.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {page.links.map((l) => inApp(l.href) ? <Button key={l.href} asChild variant="outline"><Link to={l.href}>{l.label}</Link></Button>
            : <Button key={l.href} asChild variant="outline"><a href={l.href} rel="noreferrer">{l.label}</a></Button>)}
        </div>
      )}
      {page.actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {page.actions.map((name) => {
            const a = app.globalActions.find((x) => x.name === name);
            if (!a || (a.by ? !a.by.includes(viewer.role ?? '') : !can(viewer, '*', `do:${name}`))) return null;
            return <Button key={name} onClick={() => void run.mutateAsync({ go: () => endpoints.actions[name]({}), opts: { after: a.after } }).catch(() => undefined)}>{a.title}</Button>;
          })}
        </div>
      )}
      {page.sections.map((s, i) => {
        if (s.text) return <p key={i} className="leading-relaxed">{s.text}</p>;
        if (s.list) return <ListSection key={i} id={s.list} limit={s.limit} viewer={viewer} />;
        if (s.form && can(viewer, s.form, 'create')) {
          const e = app.entities[s.form];
          return (
            <Card key={i}><CardHeader><CardTitle>New {e.label.toLowerCase()}</CardTitle></CardHeader>
              <CardContent><EntityForm entity={e} names={formNames(e, viewer)} viewer={viewer} submit={e.form.submit ?? 'Submit'} autoFocus={false}
                onSubmit={(body) => run.mutateAsync({ go: () => endpoints.entities[e.name].create(body), opts: { inline: true } })} /></CardContent></Card>
          );
        }
        return null;
      })}
    </div>
  );
}

export function PageScreen({ id }: { id: string }) {
  const page = app.pages.find((p) => p.id === id)!;
  return <Guard allow={(v) => canSee(v, page.roles)}><PageBody page={page} /></Guard>;
}
