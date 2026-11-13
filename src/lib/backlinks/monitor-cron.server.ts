/**
 * HTTP entry point for scheduled saved-list runs: `GET|POST /api/cron/monitors`
 * with `Authorization: Bearer <RANKPROOF_CRON_SECRET or CRON_SECRET>`.
 * Vercel Cron sends exactly that header when CRON_SECRET is set; any other
 * scheduler can call it with curl. Without a secret the endpoint is off.
 */
import { timingSafeEqual } from "node:crypto";
import { runDueMonitors, type MonitorSql, type ScheduledReport } from "./monitor.server.ts";
import type { BacklinkObservation } from "./verify-api.server.ts";

export function cronSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = (env.RANKPROOF_CRON_SECRET ?? env.CRON_SECRET ?? "").trim();
  return value.length >= 16 ? value : null;
}

export function authorized(header: string | null, secret: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1]!.trim());
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function handleMonitorCron(
  request: Request,
  deps: {
    sql: () => Promise<MonitorSql>;
    verify?: (items: Record<string, unknown>[]) => Promise<BacklinkObservation[]>;
    notify?: (url: string, payload: unknown) => Promise<void>;
    env?: NodeJS.ProcessEnv;
    now?: () => Date;
  },
): Promise<Response> {
  const env = deps.env ?? process.env;
  const secret = cronSecret(env);
  if (!secret) {
    return json(404, {
      ok: false,
      error: "Scheduled runs are off. Set RANKPROOF_CRON_SECRET (16+ characters) to enable them.",
    });
  }
  if (!authorized(request.headers.get("authorization"), secret)) {
    return json(401, { ok: false, error: "Unauthorized" });
  }
  const verify =
    deps.verify ??
    (async (items: Record<string, unknown>[]) => {
      const { verifyBacklinks } = await import("./verify-api.server.ts");
      return (await verifyBacklinks({ items }, { allowRender: env.RANKPROOF_RENDER === "1" }))
        .results;
    });
  const notify =
    deps.notify ??
    (async (url: string, payload: unknown) => {
      // The URL was typed by a user: the full policy, DNS included, applies.
      const { checkPublicUrl } = await import("./net.server.ts");
      const verdict = await checkPublicUrl(url);
      if (!verdict.allowed) throw new Error(`webhook refused: ${verdict.reason}`);
      const { sendWebhook } = await import("./verify-history.server.ts");
      await sendWebhook(url, payload as Parameters<typeof sendWebhook>[1]);
    });
  const origin = (env.PUBLIC_ORIGIN ?? env.BETTER_AUTH_URL ?? "").replace(/\/+$/, "");
  let report: ScheduledReport;
  try {
    report = await runDueMonitors(await deps.sql(), {
      verify,
      notify,
      now: deps.now,
      maxLists: Number(env.RANKPROOF_CRON_MAX_LISTS) || 5,
      budgetMs: 240_000,
      link: origin ? `${origin}/monitors` : null,
    });
  } catch (error) {
    console.error("[monitor-cron]", error);
    return json(500, { ok: false, error: "Scheduled runs failed; see the server log." });
  }
  // Counts and ids only: nothing about whose lists or which URLs.
  return json(200, {
    ok: true,
    ran: report.ran.length,
    failed: report.ran.filter((r) => r.error).length,
    notified: report.ran.filter((r) => r.notified).length,
    remaining: report.remaining,
  });
}
