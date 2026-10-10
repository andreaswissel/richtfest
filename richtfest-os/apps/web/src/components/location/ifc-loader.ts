export type IfcGeometry = {
  meshes: {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    color: [number, number, number, number];
  }[];
  size: [number, number, number];
};

/** Parses in a disposable worker. Transfers (and detaches) the supplied buffer. */
export function loadIfc(
  data: ArrayBuffer,
  signal?: AbortSignal,
): Promise<IfcGeometry> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("IFC loading aborted", "AbortError"));
      return;
    }
    const worker = new Worker(new URL("./ifc.worker.ts", import.meta.url), {
      type: "module",
    });
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("IFC loading aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (
      event: MessageEvent<{ data?: IfcGeometry; error?: string }>,
    ) => {
      cleanup();
      if (event.data.data) resolve(event.data.data);
      else
        reject(
          new Error(event.data.error ?? "IFC worker returned no geometry"),
        );
    };
    worker.onerror = (event) => {
      event.preventDefault();
      cleanup();
      reject(new Error(event.message || "IFC worker failed"));
    };
    worker.onmessageerror = () => {
      cleanup();
      reject(new Error("IFC worker response could not be decoded"));
    };
    try {
      worker.postMessage(data, [data]);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
