/// <reference types="vite/client" />

import { IfcAPI } from "web-ifc";
import { Matrix3, Matrix4, Vector3 } from "three";
import wasmUrl from "web-ifc/web-ifc.wasm?url";
import type { IfcGeometry } from "./ifc-loader";

// A single-threaded WASM instance needs neither shared memory nor COOP/COEP.
self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  const api = new IfcAPI();
  let model: number | undefined;
  try {
    if (!event.data.byteLength) throw new Error("IFC file is empty");
    await api.Init(() => wasmUrl, true);
    try {
      model = api.OpenModel(new Uint8Array(event.data), {
        COORDINATE_TO_ORIGIN: true,
        ALLOW_INCOMPATIBLE_SCHEMA_ALIASES: false,
      });
    } catch {
      throw new Error(
        "IFC file could not be parsed or its schema is unsupported",
      );
    }
    if (model < 0)
      throw new Error(
        "IFC file could not be parsed or its schema is unsupported",
      );
    const meshes: {
      positions: Float64Array;
      normals: Float32Array;
      indices: Uint32Array;
      color: [number, number, number, number];
    }[] = [];
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    api.StreamAllMeshes(
      model,
      (mesh) => {
        for (let g = 0; g < mesh.geometries.size(); g++) {
          const placed = mesh.geometries.get(g);
          const geometry = api.GetGeometry(model!, placed.geometryExpressID);
          try {
            const vertices = api.GetVertexArray(
              geometry.GetVertexData(),
              geometry.GetVertexDataSize(),
            );
            const indices = api.GetIndexArray(
              geometry.GetIndexData(),
              geometry.GetIndexDataSize(),
            );
            if (!vertices.length || !indices.length) continue;
            if (vertices.length % 6 || indices.length % 3)
              throw new Error("Invalid IFC triangle buffers");
            // web-ifc's flat matrix already includes IFC Z-up -> Y-up and project
            // length units -> metres (StreamAllMeshes's explicit true argument).
            const transform = new Matrix4().fromArray(
              placed.flatTransformation,
            );
            if (
              !Number.isFinite(transform.determinant()) ||
              transform.determinant() === 0
            ) {
              throw new Error("Invalid IFC geometry transform");
            }
            const normalMatrix = new Matrix3().getNormalMatrix(transform);
            const positions = new Float64Array(vertices.length / 2);
            const normals = new Float32Array(vertices.length / 2);
            const point = new Vector3();
            for (let v = 0; v < vertices.length / 6; v++) {
              point.fromArray(vertices, v * 6).applyMatrix4(transform);
              for (let axis = 0; axis < 3; axis++) {
                const value = point.getComponent(axis);
                if (!Number.isFinite(value))
                  throw new Error("Invalid IFC vertex coordinates");
                positions[v * 3 + axis] = value;
                min[axis] = Math.min(min[axis], value);
                max[axis] = Math.max(max[axis], value);
              }
              point
                .fromArray(vertices, v * 6 + 3)
                .applyNormalMatrix(normalMatrix);
              if (![point.x, point.y, point.z].every(Number.isFinite))
                throw new Error("Invalid IFC normals");
              point.toArray(normals, v * 3);
            }
            if (indices.some((index) => index >= vertices.length / 6))
              throw new Error("Invalid IFC triangle indices");
            // Mirrored mapped items need reversed winding after baking placement.
            if (transform.determinant() < 0) {
              for (let i = 0; i < indices.length; i += 3) {
                [indices[i + 1], indices[i + 2]] = [
                  indices[i + 2],
                  indices[i + 1],
                ];
              }
            }
            const { x, y, z, w } = placed.color;
            meshes.push({ positions, normals, indices, color: [x, y, z, w] });
          } finally {
            geometry.delete();
          }
        }
      },
      true,
    );
    if (!meshes.length)
      throw new Error("IFC file contains no renderable triangle geometry");
    const offset = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];
    const result: IfcGeometry = {
      meshes: meshes.map((mesh) => ({
        ...mesh,
        positions: Float32Array.from(
          mesh.positions,
          (value, i) => value - offset[i % 3],
        ),
      })),
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    };
    const transfers = result.meshes.flatMap((mesh) => [
      mesh.positions.buffer,
      mesh.normals.buffer,
      mesh.indices.buffer,
    ]);
    self.postMessage({ data: result }, { transfer: transfers });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : "IFC parsing failed",
    });
  } finally {
    if (model !== undefined && model >= 0) api.CloseModel(model);
    api.Dispose();
  }
};
