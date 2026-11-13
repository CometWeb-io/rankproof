import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { MonitorsPage } from "@/components/monitors/monitors-page";

export const Route = createFileRoute("/monitors")({
  head: () => ({ meta: [{ title: "Saved lists · RankProof" }] }),
  component: () => (
    <AppShell
      footer={
        <p>
          Runs are compared on the server with the list&rsquo;s previous run. Fetched HTML is not
          stored here; for evidence you can archive, use{" "}
          <code className="font-mono text-fg-soft">rankproof verify --history</code>.
        </p>
      }
    >
      <MonitorsPage />
    </AppShell>
  ),
});
