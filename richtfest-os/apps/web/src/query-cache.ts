import { dehydrate, hydrate } from "@tanstack/react-query";
import { queryClient } from "./query";
// This is a disposable rendering cache. Postgres remains authoritative for every record.
// Restore only after the server has authenticated the current user and workspace.
export function persistWorkspaceCache(scope: string) {
  let db: IDBDatabase | undefined,
    disposed = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const request = indexedDB.open("richtfest-query-cache", 1);
  request.onupgradeneeded = () =>
    request.result.createObjectStore("workspaces");
  request.onsuccess = () => {
    db = request.result;
    if (disposed) {
      db.close();
      return;
    }
    const read = db
      .transaction("workspaces")
      .objectStore("workspaces")
      .get(scope);
    read.onsuccess = () => {
      const saved = read.result;
      if (saved && Date.now() - saved.at < 300_000)
        hydrate(queryClient, saved.state);
    };
  };
  request.onerror = () => {
    /* Cache availability must never block the workspace. */
  };
  const unsubscribe = queryClient.getQueryCache().subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!db || disposed) return;
      const state = dehydrate(queryClient, {
        shouldDehydrateQuery: (q) =>
          q.state.status === "success" &&
          !String(q.queryKey[0]).startsWith("/auth/") &&
          q.queryKey[0] !== "/access/dev-outbox" &&
          q.queryKey[0] !== "security",
      });
      try {
        db.transaction("workspaces", "readwrite")
          .objectStore("workspaces")
          .put({ at: Date.now(), state }, scope);
      } catch {
        /* A full or disabled cache is safe to ignore. */
      }
    }, 400);
  });
  return () => {
    disposed = true;
    unsubscribe();
    if (timer) clearTimeout(timer);
    db?.close();
  };
}
