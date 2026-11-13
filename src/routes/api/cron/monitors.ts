import { createFileRoute } from "@tanstack/react-router";

async function handle({ request }: { request: Request }): Promise<Response> {
  const [{ handleMonitorCron }, { getSql }] = await Promise.all([
    import("@/lib/backlinks/monitor-cron.server"),
    import("@/lib/db"),
  ]);
  return handleMonitorCron(request, { sql: getSql });
}

export const Route = createFileRoute("/api/cron/monitors")({
  server: { handlers: { GET: handle, POST: handle } },
});
