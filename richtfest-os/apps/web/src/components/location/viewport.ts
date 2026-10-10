import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type {
  LocationContext,
  LocationPointCloud,
  SceneObject,
  SceneVector,
} from "@richtfest/shared";
import type { IfcGeometry } from "./ifc-loader";

export type ViewportState = {
  context: LocationContext;
  objects: SceneObject[];
  models: Record<string, IfcGeometry>;
  cloud?: LocationPointCloud;
  layers: {
    buildings: boolean;
    trees: boolean;
    objects: boolean;
    lidar: boolean;
  };
  selected: string | null;
  tool: "select" | "place" | "measure";
  measurement: SceneVector[];
  clipHeight: number;
  dark: boolean;
};
export function createViewport(
  host: HTMLElement,
  callbacks: {
    select: (id: string | null) => void;
    place: (point: SceneVector) => void;
    measure: (point: SceneVector) => void;
  },
) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.localClippingEnabled = true;
  host.appendChild(renderer.domElement);
  renderer.domElement.setAttribute("aria-label", "3D viewport");
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 2000);
  camera.position.set(95, 95, 120);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 5, 0);
  controls.maxDistance = 500;
  controls.minDistance = 1;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.update();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x86919b, 2.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(80, 120, 40);
  scene.add(sun);
  const groups = {
    buildings: new THREE.Group(),
    trees: new THREE.Group(),
    objects: new THREE.Group(),
    lidar: new THREE.Group(),
    measure: new THREE.Group(),
  };
  Object.values(groups).forEach((group) => scene.add(group));
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(240, 240),
    new THREE.MeshStandardMaterial({
      color: 0xe9e8e4,
      roughness: 1,
      side: THREE.DoubleSide,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.04;
  scene.add(ground);
  const grid = new THREE.GridHelper(240, 48, 0xa6adb0, 0xcbd0d0);
  grid.position.y = -0.02;
  scene.add(grid);
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(1.5, 1.8, 40),
    new THREE.MeshBasicMaterial({ color: 0x5b60b9, side: THREE.DoubleSide }),
  );
  marker.rotation.x = -Math.PI / 2;
  marker.position.y = 0.03;
  scene.add(marker);
  const selection = new THREE.Box3Helper(new THREE.Box3(), 0x7279d7);
  selection.visible = false;
  scene.add(selection);
  const slice = new THREE.Plane(new THREE.Vector3(0, -1, 0), 50);
  let current: ViewportState | undefined;
  const render = () => renderer.render(scene, camera);
  controls.addEventListener("change", render);
  const resize = new ResizeObserver(() => {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    render();
  });
  resize.observe(host);
  const disposeGroup = (group: THREE.Group) => {
    group.traverse((node) => {
      if (
        node instanceof THREE.Mesh ||
        node instanceof THREE.LineSegments ||
        node instanceof THREE.Points ||
        node instanceof THREE.Line
      ) {
        node.geometry.dispose();
        (Array.isArray(node.material)
          ? node.material
          : [node.material]
        ).forEach((material) => material.dispose());
      }
    });
    group.clear();
  };
  const edges = (mesh: THREE.Mesh, color: number) => {
    const line = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry, 25),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 }),
    );
    mesh.add(line);
  };
  function update(next: ViewportState) {
    const previous = current;
    current = next;
    scene.background = new THREE.Color(next.dark ? 0x252930 : 0xf1f2f0);
    (ground.material as THREE.MeshStandardMaterial).color.set(
      next.dark ? 0x30363c : 0xe9e8e4,
    );
    if (previous?.context !== next.context) {
      disposeGroup(groups.buildings);
      disposeGroup(groups.trees);
      for (const building of next.context.buildings) {
        const group = new THREE.Group();
        group.userData.id = `building:${building.id}`;
        for (const polygon of building.polygons) {
          const shape = new THREE.Shape(
            polygon[0].map(([x, z]) => new THREE.Vector2(x, -z)),
          );
          shape.holes = polygon
            .slice(1)
            .map(
              (ring) =>
                new THREE.Path(ring.map(([x, z]) => new THREE.Vector2(x, -z))),
            );
          const geometry = new THREE.ExtrudeGeometry(shape, {
            depth: building.height ?? 0.12,
            bevelEnabled: false,
          });
          geometry.rotateX(-Math.PI / 2);
          const mesh = new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({
              color: building.height ? 0xc5c7ca : 0x9ca3aa,
              roughness: 0.85,
            }),
          );
          edges(mesh, 0x65707a);
          group.add(mesh);
        }
        groups.buildings.add(group);
      }
      for (const tree of next.context.trees) {
        const group = new THREE.Group();
        group.userData.id = `tree:${tree.id}`;
        group.position.set(tree.position[0], 0, tree.position[1]);
        // Crown discs + height poles deliberately avoid inventing crown undersides.
        const radius = (tree.crownDiameter ?? 1) / 2;
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(Math.max(0.05, radius - 0.08), radius, 48),
          new THREE.MeshBasicMaterial({
            color: 0x708875,
            side: THREE.DoubleSide,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.08;
        group.add(ring);
        if (tree.height) {
          const pole = new THREE.Mesh(
            new THREE.CylinderGeometry(0.07, 0.07, tree.height, 6),
            new THREE.MeshBasicMaterial({ color: 0x7c8c7e }),
          );
          pole.position.y = tree.height / 2;
          group.add(pole);
          const disc = new THREE.Mesh(
            new THREE.CircleGeometry(radius, 32),
            new THREE.MeshBasicMaterial({
              color: 0x8aa68f,
              side: THREE.DoubleSide,
              transparent: true,
              opacity: 0.32,
              depthWrite: false,
            }),
          );
          disc.rotation.x = -Math.PI / 2;
          disc.position.y = tree.height;
          group.add(disc);
          const rim = ring.clone();
          rim.geometry = ring.geometry.clone();
          rim.material = ring.material.clone();
          rim.position.y = tree.height;
          group.add(rim);
        }
        groups.trees.add(group);
      }
    }
    if (
      previous?.objects !== next.objects ||
      previous?.models !== next.models
    ) {
      disposeGroup(groups.objects);
      for (const object of next.objects) {
        const group = new THREE.Group();
        group.userData.id = object.id;
        group.position.fromArray(object.position);
        group.rotation.y = THREE.MathUtils.degToRad(object.rotation);
        if (object.kind === "ifc") {
          const model = next.models[object.id];
          for (const data of model?.meshes ?? []) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute(
              "position",
              new THREE.BufferAttribute(data.positions, 3),
            );
            geometry.setAttribute(
              "normal",
              new THREE.BufferAttribute(data.normals, 3),
            );
            geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
            const [r, g, b, a] = data.color;
            group.add(
              new THREE.Mesh(
                geometry,
                new THREE.MeshStandardMaterial({
                  color: new THREE.Color(r, g, b),
                  opacity: a,
                  transparent: a < 1,
                  roughness: 0.8,
                  side: THREE.DoubleSide,
                }),
              ),
            );
          }
        } else if (object.kind === "note") {
          const pin = new THREE.Mesh(
            new THREE.OctahedronGeometry(0.75),
            new THREE.MeshStandardMaterial({ color: 0x8580ba }),
          );
          pin.position.y = 1;
          group.add(pin);
        } else {
          const color = object.kind === "vehicle" ? 0xb97658 : 0x8096b3;
          const box = new THREE.Mesh(
            new THREE.BoxGeometry(...object.size),
            new THREE.MeshStandardMaterial({
              color,
              transparent: true,
              opacity: 0.6,
              roughness: 0.8,
            }),
          );
          box.position.y = object.size[1] / 2;
          edges(box, color);
          group.add(box);
          if (object.kind === "vehicle") {
            const nose = new THREE.Mesh(
              new THREE.BoxGeometry(
                object.size[0] * 0.95,
                object.size[1] * 0.35,
                object.size[2] * 0.18,
              ),
              new THREE.MeshStandardMaterial({ color: 0x626d77 }),
            );
            nose.position.set(0, object.size[1] * 0.62, -object.size[2] * 0.37);
            group.add(nose);
          }
        }
        groups.objects.add(group);
      }
    }
    if (previous?.cloud !== next.cloud) {
      disposeGroup(groups.lidar);
      if (next.cloud) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(next.cloud.positions, 3),
        );
        const colors = new Float32Array(next.cloud.positions.length);
        for (let i = 0; i < next.cloud.classifications.length; i++) {
          const groundPoint = next.cloud.classifications[i] === 2;
          const color = new THREE.Color(groundPoint ? 0x8796a0 : 0x597d65);
          color.toArray(colors, i * 3);
        }
        geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        groups.lidar.add(
          new THREE.Points(
            geometry,
            new THREE.PointsMaterial({
              size: 0.17,
              vertexColors: true,
              clippingPlanes: [slice],
            }),
          ),
        );
      }
    }
    slice.constant = next.clipHeight;
    for (const key of ["buildings", "trees", "objects", "lidar"] as const)
      groups[key].visible = next.layers[key];
    disposeGroup(groups.measure);
    if (next.measurement.length) {
      const geometry = new THREE.BufferGeometry().setFromPoints(
        next.measurement.map((p) => new THREE.Vector3(...p)),
      );
      groups.measure.add(
        new THREE.Line(
          geometry,
          new THREE.LineBasicMaterial({ color: 0x7771d0, depthTest: false }),
        ),
      );
      for (const p of next.measurement) {
        const point = new THREE.Mesh(
          new THREE.SphereGeometry(0.22, 8, 8),
          new THREE.MeshBasicMaterial({ color: 0x7771d0, depthTest: false }),
        );
        point.position.fromArray(p);
        point.renderOrder = 9;
        groups.measure.add(point);
      }
    }
    const selected = Object.values(groups)
      .flatMap((group) => group.children)
      .find(
        (node) => node.userData.id === next.selected && node.parent?.visible,
      );
    selection.visible = !!selected;
    if (selected) {
      selected.updateWorldMatrix(true, true);
      selection.box.setFromObject(selected);
      selection.updateMatrixWorld(true);
    }
    renderer.domElement.style.cursor =
      next.tool === "select" ? "default" : "crosshair";
    render();
  }
  const raycaster = new THREE.Raycaster();
  raycaster.params.Points!.threshold = 0.22;
  let pointer = [0, 0];
  const down = (e: PointerEvent) => {
    pointer = [e.clientX, e.clientY];
  };
  const up = (e: PointerEvent) => {
    if (
      !current ||
      e.button !== 0 ||
      Math.hypot(e.clientX - pointer[0], e.clientY - pointer[1]) > 4
    )
      return;
    const bounds = host.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((e.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((e.clientY - bounds.top) / bounds.height) * 2 + 1,
      ),
      camera,
    );
    if (current.tool === "place") {
      const point = raycaster.ray.intersectPlane(
        new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
        new THREE.Vector3(),
      );
      if (point) callbacks.place(point.toArray() as SceneVector);
      return;
    }
    const targets = [
      groups.buildings,
      groups.trees,
      groups.objects,
      ...(current.tool === "measure" ? [groups.lidar] : []),
    ].filter((g) => g.visible);
    const hit = raycaster
      .intersectObjects(targets, true)
      .find(
        (h) =>
          !(h.object instanceof THREE.LineSegments) &&
          (!(h.object instanceof THREE.Points) ||
            h.point.y <= current!.clipHeight),
      );
    if (current.tool === "measure") {
      const point =
        hit?.point ??
        raycaster.ray.intersectPlane(
          new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
          new THREE.Vector3(),
        );
      if (point) callbacks.measure(point.toArray() as SceneVector);
    } else {
      let node: THREE.Object3D | null = hit?.object ?? null;
      while (node && !node.userData.id) node = node.parent;
      callbacks.select(node?.userData.id ?? null);
    }
  };
  renderer.domElement.addEventListener("pointerdown", down);
  renderer.domElement.addEventListener("pointerup", up);
  return {
    update,
    view(mode: "perspective" | "top" | "street") {
      const target = controls.target;
      const offset =
        mode === "top"
          ? [0, 150, 0.01]
          : mode === "street"
            ? [25, 4, 35]
            : [95, 95, 120];
      camera.position.copy(target).add(new THREE.Vector3(...offset));
      controls.update();
      render();
    },
    focus(id?: string | null) {
      const node = Object.values(groups)
        .flatMap((group) => group.children)
        .find((node) => node.userData.id === id);
      const target = node
        ? new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3())
        : new THREE.Vector3(0, 5, 0);
      const distance = node
        ? Math.max(
            15,
            new THREE.Box3()
              .setFromObject(node)
              .getSize(new THREE.Vector3())
              .length() * 1.8,
          )
        : 130;
      camera.position
        .copy(target)
        .add(new THREE.Vector3(0.7, 0.65, 1).multiplyScalar(distance));
      controls.target.copy(target);
      controls.update();
      render();
    },
    dispose() {
      resize.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener("pointerdown", down);
      renderer.domElement.removeEventListener("pointerup", up);
      Object.values(groups).forEach(disposeGroup);
      scene.traverse((node) => {
        if (node instanceof THREE.Mesh || node instanceof THREE.LineSegments) {
          node.geometry.dispose();
          (Array.isArray(node.material)
            ? node.material
            : [node.material]
          ).forEach((m) => m.dispose());
        }
      });
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
