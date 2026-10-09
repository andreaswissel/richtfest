export type RecordData = Record<string, any>;
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T = RecordData>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "include",
    method: method ?? (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok || result.error)
    throw new ApiError(
      response.status,
      result.message || "The request could not be completed.",
    );
  return result.data as T;
}
export const list = (value: any, key?: string): RecordData[] =>
  Array.isArray(value)
    ? value
    : Array.isArray(value?.[key || "items"])
      ? value[key || "items"]
      : [];

export async function uploadFile<T = RecordData>(
  path: string,
  form: FormData,
): Promise<T> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0)
    throw new ApiError(400, "Choose a file to upload.");
  const initiated = await api<{
    fileId: string;
    version: number;
    uploadUrl: string;
    uploadMethod: string;
    uploadHeaders?: Record<string, string>;
    completeUrl: string;
    expiresAt?: string;
  }>(`${path}/initiate`, {
    name: String(form.get("label") || file.name),
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    sourceType: "upload",
    sourceMetadata: { label: String(form.get("label") || "") },
  });
  const uploadUrl = initiated.uploadUrl;
  const apiPath = (url: string) =>
    url.startsWith("/api/") ? url.slice(4) : url;
  try {
    const uploadResponse = await fetch(uploadUrl, {
      method: initiated.uploadMethod || "PUT",
      credentials: uploadUrl.startsWith("/") ? "include" : "omit",
      headers: initiated.uploadHeaders,
      body: file,
    });
    if (!uploadResponse.ok)
      throw new ApiError(
        uploadResponse.status,
        "The file could not be uploaded to storage.",
      );
    return await api<T>(apiPath(initiated.completeUrl), {});
  } catch (error) {
    await api(
      apiPath(initiated.completeUrl.replace(/\/complete$/, "/cancel")),
      {},
    ).catch(() => undefined);
    throw error;
  }
}

export async function uploadFiles(
  path: string,
  files: File[],
  label: string,
  onProgress: (
    results: Array<{
      name: string;
      status: "uploading" | "uploaded" | "failed";
      error?: string;
    }>,
  ) => void,
): Promise<
  Array<{ name: string; status: "uploaded" | "failed"; error?: string }>
> {
  const results: Array<{
    name: string;
    status: "uploading" | "uploaded" | "failed";
    error?: string;
  }> = files.map((file) => ({ name: file.name, status: "uploading" }));
  onProgress([...results]);
  for (const [index, file] of files.entries()) {
    const form = new FormData();
    form.set("file", file);
    form.set("label", label);
    try {
      await uploadFile(path, form);
      results[index] = { name: file.name, status: "uploaded" };
    } catch (error) {
      results[index] = {
        name: file.name,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    onProgress([...results]);
  }
  return results.filter(
    (
      result,
    ): result is {
      name: string;
      status: "uploaded" | "failed";
      error?: string;
    } => result.status !== "uploading",
  );
}
