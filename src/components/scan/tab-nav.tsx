import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Tab, TabItem } from "@/components/scan/types";

const GROUPS: { label: string; ids: Tab[] }[] = [
  { label: "Summary", ids: ["overview", "plan"] },
  { label: "Links", ids: ["links", "domains", "anchors", "pages", "toxic", "sources", "issues"] },
  { label: "Search", ids: ["serp", "keywords", "performance"] },
  { label: "Site", ids: ["structure", "outbound"] },
  { label: "Opportunities", ids: ["gap", "prospects", "mentions"] },
];

export function TabNav({
  tabs,
  active,
  onChange,
}: {
  tabs: TabItem[];
  active: Tab;
  onChange: (tab: Tab) => void;
}) {
  const byId = new Map(tabs.map((item) => [item[0], item]));
  const order = GROUPS.flatMap((group) => group.ids).filter((id) => byId.has(id));
  // Anything not assigned to a group still shows up, at the end.
  for (const [id] of tabs) if (!order.includes(id)) order.push(id);
  const groups = [
    ...GROUPS.map((group) => ({ ...group, ids: group.ids.filter((id) => byId.has(id)) })),
    {
      label: "More",
      ids: tabs.map(([id]) => id).filter((id) => !GROUPS.some((g) => g.ids.includes(id))),
    },
  ].filter((group) => group.ids.length > 0);

  function move(event: KeyboardEvent<HTMLDivElement>) {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!delta && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const index = order.indexOf(active);
    const next =
      event.key === "Home"
        ? order[0]
        : event.key === "End"
          ? order[order.length - 1]
          : order[(index + delta + order.length) % order.length];
    if (!next) return;
    onChange(next);
    requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
  }

  return (
    <div
      role="tablist"
      aria-label="Report sections"
      onKeyDown={move}
      className="flex flex-wrap gap-x-6 gap-y-3 rounded-xl border border-border bg-surface/60 p-3"
    >
      {groups.map((group) => (
        <div key={group.label} role="presentation" className="max-w-full min-w-0">
          <p className="mb-1.5 px-1 text-xs text-subtle">{group.label}</p>
          <div role="presentation" className="flex flex-wrap gap-1.5">
            {group.ids.map((id) => {
              const [, label, count] = byId.get(id)!;
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
                    "h-9 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors duration-[var(--motion-quick)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected
                      ? "bg-fg text-accent-fg"
                      : "text-muted hover:bg-surface-3 hover:text-fg",
                  )}
                >
                  {label}
                  {count > 0 ? (
                    <span className="ml-1.5 font-mono text-xs tabular-nums opacity-70">
                      {count}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function TabPanel({ id, active, children }: { id: Tab; active: Tab; children: ReactNode }) {
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
