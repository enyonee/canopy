// The navigation icons webgen picked by name (src/gen/app.ts `nav[].icon`), as lucide components.
import { BarChart3, Calendar, CheckSquare, FileText, List, MessageSquare, Package, Receipt, Settings, ShoppingCart, Table2, Tags, Users, type LucideIcon } from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  package: Package, 'shopping-cart': ShoppingCart, receipt: Receipt, users: Users, tags: Tags, chart: BarChart3,
  'check-square': CheckSquare, calendar: Calendar, message: MessageSquare, 'file-text': FileText, settings: Settings,
  table: Table2, list: List,
};

export const iconFor = (name: string): LucideIcon => ICONS[name] ?? Table2;
