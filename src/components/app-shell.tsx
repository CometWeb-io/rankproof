import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Github, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Verify links", short: "Verify" },
  { to: "/monitors", label: "Saved lists", short: "Lists" },
  { to: "/audit", label: "Domain audit", short: "Audit" },
] as const;

export function AppShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:border focus:border-border focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:text-fg"
      >
        Skip to main content
      </a>
      <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 py-5 md:px-6 md:py-6">
        <header className="sticky top-3 z-30 flex h-14 items-center gap-2 rounded-2xl before:pointer-events-none before:absolute before:-inset-x-px before:-top-4 before:h-[calc(1rem-1px)] before:bg-bg before:content-[''] border border-line bg-[rgba(18,18,20,0.82)] pr-2 pl-4 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.6)] backdrop-blur-md">
          <Link to="/" className="mr-1 flex shrink-0 items-center gap-2 rounded-md sm:mr-3">
            <Link2 className="size-5 text-accent" aria-hidden />
            <span className="font-display text-base font-bold tracking-tight text-fg">
              RankProof
            </span>
          </Link>
          <nav aria-label="Primary" className="flex items-center gap-0.5 sm:gap-1">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: true }}
                aria-label={item.label}
                className={cn(
                  "inline-flex h-9 items-center rounded-lg px-2 text-sm sm:px-3 font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-fg",
                  "data-[status=active]:bg-surface-3 data-[status=active]:text-fg",
                )}
              >
                <span className="sm:hidden">{item.short}</span>
                <span className="hidden sm:inline">{item.label}</span>
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <a
              href="https://github.com/CometWeb-io/rankproof/blob/main/docs/metrics.md"
              className="hidden h-9 items-center rounded-lg px-3 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg sm:inline-flex"
            >
              Methodology
            </a>
            <a
              href="https://github.com/CometWeb-io/rankproof"
              aria-label="RankProof on GitHub"
              className="inline-flex h-9 items-center gap-2 rounded-lg px-2 text-sm text-muted sm:px-3 transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <Github className="size-4" aria-hidden />
              <span className="hidden sm:inline">GitHub</span>
            </a>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="flex flex-1 flex-col outline-none">
          {children}
        </main>
        <footer className="mt-16 flex flex-col gap-3 border-t border-line-soft pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-[13px] leading-relaxed text-muted sm:flex-row sm:items-start sm:justify-between sm:gap-8">
          <div className="max-w-2xl">{footer}</div>
          <p className="shrink-0 text-subtle">
            MIT licensed · runs on your machine · no paid SEO APIs
          </p>
        </footer>
      </div>
    </>
  );
}
