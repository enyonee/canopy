// Sign in (`/login`) and create an account (`/register`), over POST /api/login and /api/register. The session is
// the runtime's cookie; after either, every cached answer is dropped because it was read as somebody else.
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { AlertCircle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { app } from '@/gen/app';
import { endpoints } from '@/gen/endpoints';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { EntityForm } from '@/components/entity-form';
import { useSessionChanged, useViewer } from '@/lib/session';
import { inApp } from '@/lib/paths';

function AuthFrame({ title, description, children, footer }: { title: string; description: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="grid min-h-[calc(100dvh-10rem)] place-items-center">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-primary text-lg font-bold text-primary-foreground shadow-md" aria-hidden="true">{app.title[0]}</span>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <div className="rounded-xl border bg-card p-6 shadow-sm sm:p-8">{children}</div>
        <p className="mt-6 text-center text-sm text-muted-foreground">{footer}</p>
      </div>
    </div>
  );
}

export function LoginScreen() {
  const { next } = useSearch({ strict: false }) as { next?: string };
  const navigate = useNavigate();
  const changed = useSessionChanged();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const roles = app.roles!;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!login.trim() || !password) { setError(`Enter your ${roles.loginLabel.toLowerCase()} and password.`); return; }
    setBusy(true);
    try {
      const r = await endpoints.login({ login: login.trim(), password });
      await changed({ user: r.user, role: r.role });
      toast.success(r.flash || 'Signed in');
      await navigate({ to: inApp(next) ?? '/' });
    } catch (err) {
      setError(err instanceof ApiError ? err.errors.join(' · ') : String(err));
    } finally { setBusy(false); }
  };
  const type = /email/i.test(roles.login) ? 'email' : 'text';
  return (
    <AuthFrame title={`Sign in to ${app.title}`} description="Welcome back. Enter your details to continue."
      footer={roles.register ? <>New here? <Link to="/register" className="font-medium text-primary underline-offset-4 hover:underline">Create an account</Link></> : null}>
      <form onSubmit={submit} noValidate className="grid gap-5">
        {error && <Alert variant="destructive"><AlertCircle /><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="grid gap-2">
          <Label htmlFor="login">{roles.loginLabel}</Label>
          <Input id="login" name="login" type={type} autoComplete={type === 'email' ? 'email' : 'username'} value={login} onChange={(e) => setLogin(e.target.value)} autoFocus required aria-invalid={error ? true : undefined} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required aria-invalid={error ? true : undefined} />
        </div>
        <Button type="submit" className="w-full" disabled={busy}>{busy && <Loader2 className="animate-spin" aria-hidden="true" />}Sign in</Button>
      </form>
    </AuthFrame>
  );
}

export function RegisterScreen() {
  const navigate = useNavigate();
  const changed = useSessionChanged();
  const viewer = useViewer();
  const roles = app.roles!;
  const entity = app.entities[roles.entity];
  return (
    <AuthFrame title="Create your account" description={`Join ${app.title} in a minute.`}
      footer={<>Already have an account? <Link to="/login" className="font-medium text-primary underline-offset-4 hover:underline">Sign in</Link></>}>
      <EntityForm entity={entity} names={roles.registerFields} viewer={viewer} submit="Create account" compact
        onSubmit={async (body) => {
          const r = await endpoints.register(body);
          await changed({ user: r.user, role: r.role });
          toast.success(r.flash || 'Welcome');
          await navigate({ to: '/' });
        }} />
    </AuthFrame>
  );
}
