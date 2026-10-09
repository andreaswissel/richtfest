import { afterEach, expect, test } from "bun:test";
import { api, ApiError, list } from "../src/api";
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
test("API sends cookie credentials and preserves request data", async () => {
  let options: RequestInit | undefined;
  globalThis.fetch = (async (_url, init) => {
    options = init;
    return Response.json({ data: { id: "saved" }, error: null, message: null });
  }) as typeof fetch;
  expect(await api("/projects", { name: "House" })).toEqual({ id: "saved" });
  expect(options?.credentials).toBe("include");
  expect(options?.method).toBe("POST");
  expect(JSON.parse(options?.body as string)).toEqual({ name: "House" });
});
test("API rejects permission errors instead of presenting them as saved data", async () => {
  globalThis.fetch = (async () =>
    Response.json(
      { data: null, error: { code: "forbidden" }, message: "Access denied" },
      { status: 403 },
    )) as typeof fetch;
  await expect(api("/projects", {})).rejects.toBeInstanceOf(ApiError);
  await expect(api("/projects", {})).rejects.toThrow("Access denied");
});
test("list normalizes an array or explicit collection without accepting objects as rows", () => {
  expect(list([{ id: 1 }])).toEqual([{ id: 1 }]);
  expect(list({ projects: [{ id: 2 }] }, "projects")).toEqual([{ id: 2 }]);
  expect(list({ id: 3 })).toEqual([]);
});

test("file upload initiates, streams raw bytes, and completes the version", async () => {
  const { uploadFile } = await import("../src/api");
  const data = new FormData();
  data.set("file", new File(["test"], "plan.txt", { type: "text/plain" }));
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/initiate"))
      return Response.json({
        data: {
          fileId: "file-1",
          version: 1,
          uploadUrl: "/api/projects/project-1/files/file-1/versions/1/upload",
          uploadMethod: "PUT",
          uploadHeaders: { "content-type": "text/plain" },
          completeUrl:
            "/api/projects/project-1/files/file-1/versions/1/complete",
        },
        error: null,
      });
    if (String(url).endsWith("/upload"))
      return Response.json({ data: { uploaded: true }, error: null });
    return Response.json({ data: { id: "file-1" }, error: null });
  }) as typeof fetch;
  expect(await uploadFile("/projects/project-1/files", data)).toEqual({
    id: "file-1",
  });
  expect(calls).toHaveLength(3);
  expect(calls[0]?.init?.method).toBe("POST");
  expect(JSON.parse(calls[0]?.init?.body as string)).toMatchObject({
    name: "plan.txt",
    mimeType: "text/plain;charset=utf-8",
    sizeBytes: 4,
  });
  expect(calls[1]?.init?.method).toBe("PUT");
  expect(await new Response(calls[1]?.init?.body).text()).toBe("test");
  expect(calls[1]?.init?.headers).toEqual({ "content-type": "text/plain" });
  expect(calls[2]?.init?.method).toBe("POST");
  expect(calls[2]?.url).toBe(
    "/api/projects/project-1/files/file-1/versions/1/complete",
  );
});
