import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import type { MonitorListItem, MonitorRecord, MonitorRun } from "./monitor.server.ts";

/**
 * Web app wrappers around monitor.server.ts. Every function runs behind
 * authMiddleware: the user id comes from the verified session (or the local
 * dev user when sign-in is off and there is no DATABASE_URL), never from the
 * client.
 */

type Fail = { ok: false; error: string };

async function store() {
  const [{ getSql }, monitor] = await Promise.all([
    import("@/lib/db"),
    import("./monitor.server.ts"),
  ]);
  return { sql: await getSql(), monitor };
}

function failure(error: unknown): Fail {
  if (error instanceof Error && error.name === "MonitorInputError") {
    return { ok: false, error: error.message };
  }
  console.error("[monitor]", error);
  return { ok: false, error: "The saved lists could not be read or written. Try again." };
}

function idOf(data: unknown): number {
  const id = Number((data as { id?: unknown } | null)?.id);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw Object.assign(new Error("Unknown list."), { name: "MonitorInputError" });
  return id;
}

/** Where saved lists live, so the page can say whether they survive a restart. */
export const monitorStorage = createServerFn({ method: "GET" }).handler(
  async (): Promise<{
    durable: boolean;
    signInRequired: boolean;
    blocked: string | null;
    scheduled: boolean;
  }> => {
    const { dbSource } = await import("@/lib/db");
    const { authConfigured } = await import("@/lib/auth/verify.server");
    const durable = dbSource === "neon";
    const { cronSecret } = await import("./monitor-cron.server.ts");
    return {
      scheduled: cronSecret() !== null,
      durable,
      signInRequired: authConfigured,
      blocked:
        durable && !authConfigured
          ? "Saved lists need sign-in on a server with a database (set BETTER_AUTH_SECRET)."
          : null,
    };
  },
);

export const listMonitorsFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<{ ok: true; monitors: MonitorListItem[] } | Fail> => {
    try {
      const { sql, monitor } = await store();
      return { ok: true, monitors: await monitor.listMonitors(sql, context.userId) };
    } catch (error) {
      return failure(error);
    }
  });

export const saveMonitorFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: unknown) =>
      data as {
        id?: number | null;
        name?: unknown;
        pairs?: unknown;
        schedule?: unknown;
        webhook_url?: unknown;
      },
  )
  .handler(async ({ data, context }): Promise<{ ok: true; id: number } | Fail> => {
    try {
      const { sql, monitor } = await store();
      const { id } = await monitor.saveMonitor(sql, context.userId, {
        id: data?.id ? idOf(data) : null,
        name: data?.name,
        pairs: data?.pairs,
        schedule: data?.schedule,
        webhook_url: data?.webhook_url,
      });
      return { ok: true, id };
    } catch (error) {
      return failure(error);
    }
  });

export const deleteMonitorFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: unknown) => data)
  .handler(async ({ data, context }): Promise<{ ok: true } | Fail> => {
    try {
      const { sql, monitor } = await store();
      await monitor.deleteMonitor(sql, context.userId, idOf(data));
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  });

export const monitorDetailFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: unknown) => data)
  .handler(
    async ({
      data,
      context,
    }): Promise<{ ok: true; monitor: MonitorRecord; runs: MonitorRun[] } | Fail> => {
      try {
        const { sql, monitor } = await store();
        const id = idOf(data);
        const found = await monitor.getMonitor(sql, context.userId, id);
        if (!found) return { ok: false, error: "That list does not exist." };
        return {
          ok: true,
          monitor: found,
          runs: await monitor.monitorRuns(sql, context.userId, id),
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

export const runMonitorFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: unknown) => data)
  .handler(
    async ({
      data,
      context,
    }): Promise<{ ok: true; run: MonitorRun & { compared_with: string | null } } | Fail> => {
      try {
        const { sql, monitor } = await store();
        const { verifyBacklinks } = await import("./verify-api.server.ts");
        const run = await monitor.runMonitor(sql, context.userId, idOf(data), async (items) => {
          const response = await verifyBacklinks(
            { items },
            { allowRender: process.env.RANKPROOF_RENDER === "1" },
          );
          return response.results;
        });
        return { ok: true, run };
      } catch (error) {
        return failure(error);
      }
    },
  );
