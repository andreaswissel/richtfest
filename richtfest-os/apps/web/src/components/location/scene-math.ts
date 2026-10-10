import type { LocationPointCloud, SceneObject } from "@richtfest/shared";

/** An observation of displayed samples, never a clearance or collision certificate. */
export function pointsInEnvelope(
  cloud: LocationPointCloud,
  object: SceneObject,
) {
  const angle = (object.rotation * Math.PI) / 180;
  const cos = Math.cos(angle),
    sin = Math.sin(angle);
  let count = 0;
  for (let i = 0; i < cloud.positions.length; i += 3) {
    const dx = cloud.positions[i] - object.position[0];
    const y = cloud.positions[i + 1] - object.position[1];
    const dz = cloud.positions[i + 2] - object.position[2];
    const x = cos * dx - sin * dz,
      z = sin * dx + cos * dz;
    if (
      Math.abs(x) <= object.size[0] / 2 &&
      y >= 0 &&
      y <= object.size[1] &&
      Math.abs(z) <= object.size[2] / 2
    )
      count++;
  }
  return count;
}
