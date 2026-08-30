import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Tab, TabItem } from "@/components/scan/types";

export function TabNav({
  tabs,
  active,
  onChange,
}: {
  tabs: TabItem[];
  active: Tab;
  onChange: (tab: Tab) => void;
}) {
  return (
    <div role="tablist" aria-label="Report sections" className="flex flex-wrap gap-2">
      {tabs.map(([id, label, count]) => {
        const selected = active === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={selected}
            aria-controls={`panel-${id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            className={cn(
              "h-11 min-w-[44px] rounded-full border px-4 text-sm font-medium transition-colors duration-[var(--motion-quick)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
              selected
                ? "border-fg-soft bg-fg text-accent-fg"
                : "border-border bg-surface text-muted hover:text-fg",
            )}
          >
            {label}
            {count > 0 ? (
              <span className="ml-2 font-mono text-xs tabular-nums opacity-70">{count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  id,
  active,
  children,
}: {
  id: Tab;
  active: Tab;
  children: ReactNode;
}) {
  if (active !== id) return null;
  return (
    <div
      role="tabpanel"
      id={`panel-${id}`}
      aria-labelledby={`tab-${id}`}
      tabIndex={0}
      className="focus:outline-none"
    >
      {children}
    </div>
  );
}
