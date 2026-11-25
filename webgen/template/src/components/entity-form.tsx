// A form over some fields of an entity: create, edit, a transition's or an action's own fields, a related add.
// Checks what the graph lets the browser check, posts JSON, and shows a 400 next to the field it names
// (or above the form when it names none).
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { AlertCircle, Loader2 } from 'lucide-react';
import type { Entity, Field } from '@/lib/model';
import type { Body, Row } from '@/lib/api';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { FieldInput, toBody, toFormValue, type FormValues } from '@/components/field-input';
import type { Viewer } from '@/lib/perms';
import { cn } from '@/lib/utils';

export type FormProps = {
  entity: Entity;
  names: readonly string[];
  row?: Row | null;
  viewer: Viewer;
  submit: string;
  /** Every listed field is required (a transition's or an action's own fields are). */
  allRequired?: boolean;
  onSubmit: (body: Body) => Promise<unknown>;
  onCancel?: () => void;
  cancel?: string;
  compact?: boolean;
  autoFocus?: boolean;
};

// Which field a server message is about, when it starts with the field's name or caption.
function fieldOf(fields: readonly Field[], message: string) {
  const m = message.toLowerCase();
  return fields.find((f) => m.startsWith(f.name.toLowerCase() + ' ') || m.startsWith(f.label.toLowerCase() + ' '));
}

export function EntityForm({ entity, names, row, viewer, submit, allRequired, onSubmit, onCancel, cancel = 'Cancel', compact, autoFocus = true }: FormProps) {
  const fields = names.map((n) => entity.fields.find((f) => f.name === n)).filter((f): f is Field => Boolean(f));
  const defaults = Object.fromEntries(fields.map((f) => [f.name, toFormValue(f, row?.[f.name])]));
  const { control, handleSubmit, setError, formState } = useForm<FormValues>({ defaultValues: defaults, mode: 'onTouched' });
  const [problems, setProblems] = useState<string[]>([]);

  const send = handleSubmit(async (values) => {
    setProblems([]);
    try {
      await onSubmit(toBody(fields, values, fields.map((f) => f.name)));
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 400) return;
      const rest: string[] = [];
      for (const msg of e.errors) {
        const f = fieldOf(fields, msg);
        if (f) setError(f.name, { type: 'server', message: msg }, { shouldFocus: true });
        else rest.push(msg);
      }
      setProblems(rest);
    }
  });

  const wide = (f: Field) => f.kind === 'longtext' || compact;
  return (
    <form onSubmit={send} noValidate className="grid gap-6" aria-busy={formState.isSubmitting || undefined}>
      {problems.length > 0 && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Please fix the following</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </AlertDescription>
        </Alert>
      )}
      <div className={cn('grid gap-5', !compact && 'sm:grid-cols-2')}>
        {fields.map((f, i) => (
          <div key={f.name} className={cn(wide(f) && 'sm:col-span-2')}>
            <FieldInput f={f} control={control} viewer={viewer} required={Boolean(allRequired) || f.required} error={formState.errors[f.name]?.message} autoFocus={autoFocus && i === 0} />
          </div>
        ))}
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel && <Button type="button" variant="outline" onClick={onCancel}>{cancel}</Button>}
        <Button type="submit" disabled={formState.isSubmitting}>
          {formState.isSubmitting && <Loader2 className="animate-spin" aria-hidden="true" />}
          {submit}
        </Button>
      </div>
    </form>
  );
}
