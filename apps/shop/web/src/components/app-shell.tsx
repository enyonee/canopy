// The frame of every screen: a sidebar of what the viewer may open (a drawer on phones), the signed-in user,
// the theme switch, and the page itself in <main>.
import { useState, type ReactNode } from 'react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { ExternalLink, LogIn, LogOut, Menu, Monitor, Moon, PanelLeft, Sun, UserPlus } from 'lucide-react';
import { app } from '@/gen/app';
import { endpoints } from '@/gen/endpoints';
import type { NavItem } from '@/lib/model';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { iconFor } from '@/components/icons';
import { can, canSee, isAdmin, type Viewer } from '@/lib/perms';
import { useSessionChanged, useViewer, userName } from '@/lib/session';
import { useTheme, type ThemeChoice } from '@/lib/theme';
import { initials, enumLabel } from '@/lib/format';
import { toastError } from '@/lib/run';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

export function visibleNav(viewer: Viewer): NavItem[] {
  return app.nav.filter((n) => {
    if (n.kind === 'entity') return can(viewer, n.entity!, 'view');
    if (n.kind === 'list') return canSee(viewer, n.roles) && can(viewer, n.entity!, 'view');
    return canSee(viewer, n.roles);
  });
}

function Brand({ compact }: { compact?: boolean } = {}) {
  return (
    <Link to="/" className="flex items-center gap-2.5 rounded-md px-1 font-semibold tracking-tight">
      <span className="flex size-8 items-center justify-center rounded-lg bg-brand-gradient text-sm font-bold text-white shadow-md" aria-hidden="true">{app.title[0]}</span>
      {!compact && <span className="text-lg">{app.title}</span>}
    </Link>
  );
}

function NavLink({ n, active, onNavigate, compact }: { n: NavItem; active: boolean; onNavigate?: () => void; compact?: boolean }) {
  const Icon = iconFor(n.icon);
  return (
    <Link to={n.to} onClick={onNavigate} aria-current={active ? 'page' : undefined} title={compact ? n.title : undefined} aria-label={compact ? n.title : undefined}
      className={cn(compact && 'justify-center px-0', 'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
        active && 'bg-card text-accent-text shadow-xs hover:bg-card hover:text-accent-text')}>
      <span className={cn('flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors group-hover:text-foreground', active && 'text-accent-text group-hover:text-accent-text')}>
        <Icon className="size-4" aria-hidden="true" />
      </span>
      {!compact && n.title}
    </Link>
  );
}

// The menu in groups (Browse, Records, Lists, Insights, Pages: webgen's model), each with its heading.
function NavLinks({ viewer, onNavigate, compact }: { viewer: Viewer & { loading: boolean }; onNavigate?: () => void; compact?: boolean }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const items = visibleNav(viewer);
  const groups = [...new Set(items.map((n) => n.group))];
  return (
    <nav aria-label="Main" className="flex flex-col gap-5">
      {viewer.loading
        ? <div className="space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
        : groups.map((g) => (
            <div key={g} className="space-y-1">
              {groups.length > 1 && !compact && <p className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground/80 uppercase">{g}</p>}
              {items.filter((n) => n.group === g).map((n) => (
                <NavLink key={n.to} n={n} compact={compact} active={path === n.to || path.startsWith(`${n.to}/`)} onNavigate={onNavigate} />
              ))}
            </div>
          ))}
      {!viewer.loading && isAdmin(viewer) && app.roles && (
        <div className="space-y-1">
          {!compact && <p className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground/80 uppercase">Admin</p>}
          <a href="/admin" title={compact ? 'Admin console' : undefined} aria-label={compact ? 'Admin console' : undefined} className="group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground">
            <span className="flex size-7 items-center justify-center rounded-md bg-muted"><ExternalLink className="size-4" aria-hidden="true" /></span>
            {!compact && 'Admin console'}
          </a>
        </div>
      )}
    </nav>
  );
}

function ThemeMenuItems() {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemeChoice)}>
      <DropdownMenuRadioItem value="light"><Sun />Light</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="dark"><Moon />Dark</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="system"><Monitor />System</DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  );
}

function ThemeToggle() {
  const { resolved } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Colour theme">{resolved === 'dark' ? <Moon /> : <Sun />}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end"><DropdownMenuLabel>Theme</DropdownMenuLabel><ThemeMenuItems /></DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu({ viewer }: { viewer: Viewer & { loading: boolean } }) {
  const navigate = useNavigate();
  const changed = useSessionChanged();
  if (!app.roles) return null;
  if (viewer.loading) return <Skeleton className="size-9 rounded-full" />;
  if (!viewer.user) {
    return (
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm"><Link to="/login"><LogIn />Sign in</Link></Button>
        {app.roles.register && <Button asChild size="sm" className="hidden sm:inline-flex"><Link to="/register"><UserPlus />Create account</Link></Button>}
      </div>
    );
  }
  const name = userName(viewer.user);
  const signOut = async () => {
    try {
      const r = await endpoints.logout();
      await changed({ user: null, role: r.role });
      toast.success(r.flash || 'Signed out');
      await navigate({ to: '/' });
    } catch (e) { toastError(e); }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-9 gap-2 rounded-full pr-3 pl-1" aria-label={`Account: ${name}`}>
          <span className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary" aria-hidden="true">{initials(name)}</span>
          <span className="hidden max-w-32 truncate text-sm sm:inline">{name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate font-medium" data-testid="signed-in">{name}</div>
          <div className="truncate text-xs text-muted-foreground">{String(viewer.user[app.roles.login] ?? '')} · {enumLabel(viewer.role)}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}><LogOut />Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// With one or two places to go a sidebar is mostly empty: those go in the header. More than that get a sidebar.
const TOP_NAV_MAX = 2;

function TopLinks({ viewer }: { viewer: Viewer }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav aria-label="Main" className="hidden items-center gap-1 lg:flex">
      {visibleNav(viewer).map((n) => {
        const active = path === n.to || path.startsWith(`${n.to}/`);
        return (
          <Link key={n.to} to={n.to} aria-current={active ? 'page' : undefined}
            className={cn('rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground', active && 'bg-primary/10 text-primary')}>
            {n.title}
          </Link>
        );
      })}
      {isAdmin(viewer) && app.roles && <a href="/admin" className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground">Admin console</a>}
    </nav>
  );
}

const COLLAPSE_KEY = 'canopy-sidebar';

// The workspace frame (shadcn's sidebar-07 shape): a full-height sidebar that folds to icons, a header with the fold
// button and the account; on phones the menu is a drawer. One or two places to go need no sidebar: they sit in the header.
export function AppShell({ children }: { children?: ReactNode }) {
  const viewer = useViewer();
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } });
  const fold = () => { const next = !compact; setCompact(next); try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* the choice is not kept */ } };
  const count = viewer.loading ? 0 : visibleNav(viewer).length + (isAdmin(viewer) && app.roles ? 1 : 0);
  const sidebar = viewer.loading || count > TOP_NAV_MAX;
  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only z-50 rounded-md bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3">Skip to content</a>
      {sidebar && (
        <aside className={cn('hidden shrink-0 border-r border-sidebar-border bg-sidebar transition-[width] duration-200 ease-snappy lg:block', compact ? 'w-16' : 'w-64')} aria-label="Sidebar">
          <div className={cn('sticky top-0 flex h-dvh flex-col gap-6 overflow-y-auto py-4', compact ? 'px-2' : 'px-3')}>
            <div className={cn('flex h-8 items-center', compact && 'justify-center')}><Brand compact={compact} /></div>
            <NavLinks viewer={viewer} compact={compact} />
            {viewer.user && !compact && (
              <div className="mt-auto flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2 shadow-xs">
                <span className="flex size-8 items-center justify-center rounded-full bg-primary/12 text-xs font-semibold text-primary" aria-hidden="true">{initials(userName(viewer.user))}</span>
                <div className="min-w-0 text-sm">
                  <p className="truncate font-medium">{userName(viewer.user)}</p>
                  <p className="truncate text-xs text-muted-foreground">{enumLabel(viewer.role)}</p>
                </div>
              </div>
            )}
          </div>
        </aside>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-6">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu"><Menu /></Button>
            </SheetTrigger>
            <SheetContent className="px-4 py-5">
              <SheetTitle className="sr-only">Menu</SheetTitle>
              <SheetDescription className="sr-only">Where you can go in {app.title}</SheetDescription>
              <Brand />
              <NavLinks viewer={viewer} onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          {sidebar && (
            <>
              <Button variant="ghost" size="icon-sm" className="hidden lg:inline-flex" aria-label={compact ? 'Expand sidebar' : 'Collapse sidebar'} aria-pressed={compact} onClick={fold}><PanelLeft /></Button>
              <span className="hidden h-5 w-px bg-border lg:block" aria-hidden="true" />
            </>
          )}
          <div className={cn(sidebar && 'lg:hidden')}><Brand /></div>
          {!sidebar && <TopLinks viewer={viewer} />}
          <div className="ml-auto flex items-center gap-1.5">
            <ThemeToggle />
            <UserMenu viewer={viewer} />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 outline-none sm:px-6 sm:py-8 lg:px-8">
          {children ?? <Outlet />}
        </main>
      </div>
    </div>
  );
}
