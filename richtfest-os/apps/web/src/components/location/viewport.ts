import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type {
  LocationContext,
  LocationPointCloud,
  SceneObject,
  SceneVector,
} from "@richtfest/shared";
import type { IfcGeometry } from "./ifc-loader";
import type { SiteOverlay } from "./site-geometry";
import { AERIAL_HALF_WIDTH_M, RAIL_NOISE_HALF_WIDTH_M, type Point2 } from "@richtfest/shared";

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
    roads: boolean;
    railNoise: boolean;
    plan: boolean;
    aerial: boolean;
  };
  site: SiteOverlay;
  selected: string | null;
  tool: "select" | "place" | "measure" | "align" | "pan";
  treeStyle: "schematic" | "illustrative";
  measurement: SceneVector[];
  clipHeight: number;
  dark: boolean;
  constructionLabel: string;
};
export function createViewport(
  host: HTMLElement,
  callbacks: {
    select: (id: string | null) => void;
    place: (point: SceneVector) => void;
    measure: (point: SceneVector) => void;
    /** Snaps a measuring point (to building and plan corners); used for clicks and the live preview alike. */
    snap?: (point: SceneVector) => SceneVector;
    align: (point: Point2) => void;
    /** Camera distance from its target, reported when it crosses the far-imagery threshold. */
    zoom?: (zoomedOut: boolean) => void;
  },
) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.localClippingEnabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Static source geometry only needs a new shadow map after scene edits, not
  // every orbit/pan. Lighting is illustrative, not a geolocated sun study.
  renderer.shadowMap.autoUpdate = false;
  host.appendChild(renderer.domElement);
  renderer.domElement.setAttribute("aria-label", "3D viewport");
  const scene = new THREE.Scene();
  const skyCanvas = document.createElement("canvas");
  skyCanvas.width = 256;
  skyCanvas.height = 128;
  const skyContext = skyCanvas.getContext("2d")!;
  const skyGradient = skyContext.createLinearGradient(0, 0, 0, 128);
  skyGradient.addColorStop(0, "#819db6");
  skyGradient.addColorStop(0.45, "#e0e7e8");
  skyGradient.addColorStop(0.55, "#f1eadd");
  skyGradient.addColorStop(1, "#85867e");
  skyContext.fillStyle = skyGradient;
  skyContext.fillRect(0, 0, 256, 128);
  const sky = new THREE.CanvasTexture(skyCanvas);
  sky.colorSpace = THREE.SRGBColorSpace;
  sky.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromEquirectangular(sky);
  pmrem.dispose();
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.35;
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 6000);
  const homeDirection = new THREE.Vector3(0.8, 0.95, 1).normalize();
  const homeTarget = new THREE.Vector3(0, 5, 0);
  camera.position.copy(homeTarget).addScaledVector(homeDirection, 190);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(homeTarget);
  controls.maxDistance = 2600;
  controls.minDistance = 1;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.update();
  const fill = new THREE.HemisphereLight(0xdde8f3, 0x777366, 1.2);
  scene.add(fill);
  const sun = new THREE.DirectionalLight(0xffefda, 3);
  sun.position.set(-65, 110, 55);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00015;
  sun.shadow.normalBias = 0.12;
  Object.assign(sun.shadow.camera, {
    left: -160,
    right: 160,
    top: 160,
    bottom: -160,
    near: 1,
    far: 500,
  });
  scene.add(sun);
  const groups = {
    buildings: new THREE.Group(),
    trees: new THREE.Group(),
    objects: new THREE.Group(),
    lidar: new THREE.Group(),
    measure: new THREE.Group(),
    roads: new THREE.Group(),
    railNoise: new THREE.Group(),
    plan: new THREE.Group(),
    dimensions: new THREE.Group(),
    aerial: new THREE.Group(),
    construction: new THREE.Group(),
  };
  Object.values(groups).forEach((group) => scene.add(group));
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000),
    new THREE.MeshStandardMaterial({
      color: 0xc7c8bb,
      roughness: 1,
      side: THREE.DoubleSide,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.04;
  ground.receiveShadow = true;
  scene.add(ground);
  const grid = new THREE.GridHelper(240, 48, 0x77857c, 0x77857c);
  grid.material.transparent = true;
  grid.material.opacity = 0.18;
  grid.material.depthWrite = false;
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
  const constructionBounds = new THREE.Box3();
  let current: ViewportState | undefined;
  const render = () => renderer.render(scene, camera);
  let initialFrame = true;
  const frame = (box?: THREE.Box3) => {
    const target = box ? box.getCenter(new THREE.Vector3()) : homeTarget;
    const radius = box ? box.getSize(new THREE.Vector3()).length() / 2 : 58;
    const halfFov = Math.atan(
      Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) *
        Math.min(1, camera.aspect),
    );
    const distance = Math.max(12, (radius / Math.sin(halfFov)) * 1.15);
    camera.position.copy(target).addScaledVector(homeDirection, distance);
    controls.target.copy(target);
    controls.update();
  };
  controls.addEventListener("change", render);
  // Far aerial imagery is only worth loading once the planner zooms out past the neighbourhood.
  let zoomedOut = false;
  const checkZoom = () => {
    const out = camera.position.distanceTo(controls.target) > 320;
    if (out !== zoomedOut) { zoomedOut = out; callbacks.zoom?.(out); }
  };
  controls.addEventListener("change", checkZoom);
  const resize = new ResizeObserver(() => {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    scene.traverse((node) => {
      if (node instanceof THREE.Sprite && node.userData.screen) screenSized(node, node.userData.screen.px, node.userData.screen.aspect);
      if (node instanceof Line2) (node.material as LineMaterial).resolution.set(renderer.domElement.width, renderer.domElement.height);
    });
    if (initialFrame) {
      initialFrame = false;
      frame();
    }
    render();
  });
  resize.observe(host);
  const disposeGroup = (group: THREE.Group) => {
    group.traverse((node) => {
      if (
        node instanceof THREE.Mesh ||
        node instanceof THREE.LineSegments ||
        node instanceof THREE.Points ||
        node instanceof THREE.Line ||
        node instanceof THREE.Sprite
      ) {
        // Sprites share one geometry across the scene.
        if (!(node instanceof THREE.Sprite)) node.geometry.dispose();
        const material = node.material as THREE.Material & { map?: THREE.Texture | null };
        if (!Array.isArray(material) && material.map !== pointTexture) material.map?.dispose();
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
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.22 }),
    );
    mesh.add(line);
  };
  /** Stacked ground layers stay ordered at any zoom: depth offsets instead of centimetre gaps, which z-fight from far away. */
  const groundLayer = <M extends THREE.Material>(material: M, level: number) => {
    material.polygonOffset = true;
    material.polygonOffsetFactor = -level;
    material.polygonOffsetUnits = -level * 4;
    return material;
  };
  /** Flat strip along a polyline, one quad per segment: a visible axis at any zoom, unlike 1px lines. */
  const ribbon = (parts: Point2[][], width: number, color: number, opacity: number, y: number) => {
    const positions: number[] = [];
    for (const part of parts)
      for (let i = 0; i + 1 < part.length; i++) {
        const [ax, az] = part[i], [bx, bz] = part[i + 1];
        const length = Math.hypot(bx - ax, bz - az);
        if (!length) continue;
        const nx = (-(bz - az) / length) * (width / 2), nz = ((bx - ax) / length) * (width / 2);
        positions.push(ax + nx, y, az + nz, bx + nx, y, bz + nz, bx - nx, y, bz - nz, ax + nx, y, az + nz, bx - nx, y, bz - nz, ax - nx, y, az - nz);
      }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const mesh = new THREE.Mesh(geometry, groundLayer(new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }), 4));
    mesh.renderOrder = 2;
    return mesh;
  };
  const dot = (x: number, z: number, radius: number, color: number) => {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 12, 8),
      new THREE.MeshBasicMaterial({ color, depthTest: false }),
    );
    mesh.position.set(x, 0.3, z);
    mesh.renderOrder = 9;
    return mesh;
  };
  /** Text that keeps its screen size at any zoom, centred on its position. */
  const label = (text: string, color = "#7a2a1d") => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    const font = "600 44px Inter, sans-serif";
    context.font = font;
    canvas.width = Math.ceil(context.measureText(text).width) + 36;
    canvas.height = 68;
    context.font = font;
    context.fillStyle = "rgba(255,255,255,0.95)";
    context.beginPath();
    context.roundRect(1, 1, canvas.width - 2, canvas.height - 2, 12);
    context.fill();
    context.strokeStyle = color;
    context.lineWidth = 3;
    context.stroke();
    context.fillStyle = color;
    context.textBaseline = "middle";
    context.fillText(text, 18, 36);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, toneMapped: false, sizeAttenuation: false }));
    sprite.renderOrder = 12;
    return screenSized(sprite, 20, canvas.width / canvas.height);
  };
  /** Fixed CSS-pixel size for non-attenuated sprites, whatever the viewport height. */
  const screenSized = (sprite: THREE.Sprite, px: number, aspect = 1) => {
    sprite.userData.screen = { px, aspect };
    const height = (px / Math.max(1, host.clientHeight)) * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    sprite.scale.set(height * aspect, height, 1);
    return sprite;
  };
  /** Pixel-wide line with a white halo, drawn over everything: readable on imagery, buildings and ground. */
  const fatLine = (points: THREE.Vector3[], color: number, width: number, dashed = false) => {
    const group = new THREE.Group();
    const { width: w, height: h } = renderer.domElement;
    for (const [lineColor, lineWidth, order] of [[0xffffff, width + 3, 10], [color, width, 11]] as const) {
      const geometry = new LineGeometry();
      geometry.setPositions(points.flatMap((p) => [p.x, p.y, p.z]));
      const material = new LineMaterial({ color: lineColor, linewidth: lineWidth * renderer.getPixelRatio(), depthTest: false, transparent: true, dashed: dashed && lineColor !== 0xffffff, dashSize: 0.8, gapSize: 0.5 });
      material.resolution.set(w, h);
      const line = new Line2(geometry, material);
      line.computeLineDistances();
      line.renderOrder = order;
      group.add(line);
    }
    return group;
  };
  const pointTexture = (() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ffffff";
    context.beginPath();
    context.arc(32, 32, 30, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#e8590c";
    context.beginPath();
    context.arc(32, 32, 20, 0, Math.PI * 2);
    context.fill();
    return new THREE.CanvasTexture(canvas);
  })();
  const handle = (p: THREE.Vector3) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: pointTexture, depthTest: false, toneMapped: false, sizeAttenuation: false }));
    screenSized(sprite, 14);
    sprite.position.copy(p);
    sprite.renderOrder = 12;
    return sprite;
  };
  let preview: SceneVector | null = null;
  const drawMeasure = (points: SceneVector[]) => {
    disposeGroup(groups.measure);
    const ends = (points.length === 1 && preview ? [points[0], preview] : points).map((p) => new THREE.Vector3(...p));
    if (ends.length === 2) {
      groups.measure.add(fatLine(ends, 0xe8590c, 3.5, points.length === 1));
      const mid = ends[0].clone().add(ends[1]).multiplyScalar(0.5);
      const text = `${ends[0].distanceTo(ends[1]).toFixed(2)} m`;
      const tag = label(text, "#b5400a");
      tag.position.copy(mid);
      groups.measure.add(tag);
    }
    for (const p of ends) groups.measure.add(handle(p));
  };
  function update(next: ViewportState) {
    const previous = current;
    current = next;
    scene.background = next.dark ? new THREE.Color(0x202a34) : sky;
    renderer.toneMappingExposure = next.dark ? 0.8 : 1;
    fill.intensity = next.dark ? 0.85 : 1.2;
    sun.intensity = next.dark ? 2 : 3;
    (ground.material as THREE.MeshStandardMaterial).color.set(
      next.dark ? 0x333f43 : 0xc7c8bb,
    );
    grid.material.color.set(next.dark ? 0x90a8ae : 0x77857c);
    if (
      previous?.context !== next.context ||
      previous?.objects !== next.objects ||
      previous?.models !== next.models ||
      previous?.layers.buildings !== next.layers.buildings ||
      previous?.layers.objects !== next.layers.objects ||
      previous?.layers.trees !== next.layers.trees ||
      previous?.treeStyle !== next.treeStyle ||
      (previous?.tool === "measure") !== (next.tool === "measure")
    )
      renderer.shadowMap.needsUpdate = true;
    if (previous?.context !== next.context) {
      disposeGroup(groups.buildings);
      for (const [index, building] of next.context.buildings.entries()) {
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
          const mesh = new THREE.Mesh(geometry, [
            new THREE.MeshStandardMaterial({
              color: 0xe6e3da,
              roughness: 0.95,
            }),
            new THREE.MeshStandardMaterial({
              // Display palette, not inferred facade materials.
              color: building.height
                ? [0xd3cec2, 0xc4cccb, 0xd5d3ca][index % 3]
                : 0x9ca3aa,
              roughness: 0.9,
            }),
          ]);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          edges(mesh, 0x65707a);
          group.add(mesh);
        }
        groups.buildings.add(group);
      }
    }
    if (
      previous?.context !== next.context ||
      previous?.treeStyle !== next.treeStyle ||
      (previous?.tool === "measure") !== (next.tool === "measure")
    ) {
      disposeGroup(groups.trees);
      for (const tree of next.context.trees) {
        const group = new THREE.Group();
        group.userData.id = `tree:${tree.id}`;
        group.position.set(tree.position[0], 0, tree.position[1]);
        // Decorative crowns are never measurement targets. Unknown dimensions
        // keep their schematic markers rather than inventing a full-sized tree.
        if (
          next.treeStyle === "illustrative" &&
          next.tool !== "measure" &&
          tree.height &&
          tree.crownDiameter
        ) {
          const clusters = [
            [0, 0.65, 0, 0.36],
            [-0.23, 0.53, 0.04, 0.27],
            [0.22, 0.57, -0.1, 0.28],
            [0.06, 0.5, 0.22, 0.27],
            [-0.08, 0.8, -0.12, 0.25],
          ].map(([x, y, z, radius]) => {
            const geometry = new THREE.IcosahedronGeometry(radius, 1);
            geometry.translate(x, y, z);
            return geometry;
          });
          const crown = mergeGeometries(clusters)!;
          clusters.forEach((geometry) => geometry.dispose());
          crown.computeBoundingBox();
          const bounds = crown.boundingBox!;
          const centre = bounds.getCenter(new THREE.Vector3());
          const size = bounds.getSize(new THREE.Vector3());
          crown.translate(-centre.x, -bounds.min.y, -centre.z);
          crown.scale(
            tree.crownDiameter / size.x,
            (tree.height * 0.55) / size.y,
            tree.crownDiameter / size.z,
          );
          crown.translate(0, tree.height * 0.45, 0);
          const leaves = new THREE.Mesh(
            crown,
            new THREE.MeshStandardMaterial({
              color: 0x6e8956,
              roughness: 0.95,
              flatShading: true,
            }),
          );
          const trunk = new THREE.Mesh(
            new THREE.CylinderGeometry(
              tree.crownDiameter * 0.016,
              tree.crownDiameter * 0.025,
              tree.height * 0.65,
              8,
            ),
            new THREE.MeshStandardMaterial({ color: 0x78624c, roughness: 1 }),
          );
          trunk.position.y = tree.height * 0.325;
          leaves.castShadow = trunk.castShadow = true;
          leaves.receiveShadow = trunk.receiveShadow = true;
          group.add(leaves, trunk);
          groups.trees.add(group);
          continue;
        }
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
            const mesh = new THREE.Mesh(
              geometry,
              new THREE.MeshStandardMaterial({
                color: new THREE.Color(r, g, b),
                opacity: a,
                transparent: a < 1,
                roughness: 0.8,
                side: THREE.DoubleSide,
              }),
            );
            mesh.castShadow = a >= 0.98;
            mesh.receiveShadow = true;
            group.add(mesh);
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
              toneMapped: false,
              clippingPlanes: [slice],
            }),
          ),
        );
      }
    }
    if (previous?.site.axes !== next.site.axes) {
      disposeGroup(groups.roads);
      // Added sources in the primary indigo, open suggestions in amber, everything else muted.
      for (const axis of next.site.axes) {
        groups.roads.add(ribbon(axis.parts, axis.kind === "rail" ? 1.6 : 2.4,
          axis.added ? 0x5b60b9 : axis.suggested ? 0xd97706 : axis.kind === "rail" ? 0x7a5236 : 0x59616d, axis.added || axis.suggested ? 0.95 : 0.7, 0.06));
        // Suggestions also get a pixel-wide line so they stay visible from the surroundings view.
        if (axis.suggested)
          for (const part of axis.parts)
            if (part.length > 1) groups.roads.add(fatLine(part.map(([x, z]) => new THREE.Vector3(x, 0.1, z)), 0xd97706, 3));
      }
    }
    if (previous?.site.railNoise !== next.site.railNoise) {
      disposeGroup(groups.railNoise);
      if (next.site.railNoise) {
        const texture = new THREE.TextureLoader().load(next.site.railNoise, render);
        texture.colorSpace = THREE.SRGBColorSpace;
        const size = RAIL_NOISE_HALF_WIDTH_M * 2;
        // The image is north-up and centred on the site origin, which is local (0, 0).
        const plane = new THREE.Mesh(
          new THREE.PlaneGeometry(size, size),
          groundLayer(new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false }), 3),
        );
        plane.rotation.x = -Math.PI / 2;
        plane.position.y = 0.01;
        plane.renderOrder = 1;
        groups.railNoise.add(plane);
      }
    }
    if (previous?.site.aerial.near !== next.site.aerial.near || previous?.site.aerial.far !== next.site.aerial.far) {
      disposeGroup(groups.aerial);
      // Both images are north-up and centred on the site origin; the sharp near window lies on top.
      for (const [extent, url, y] of [["far", next.site.aerial.far, -0.035], ["near", next.site.aerial.near, -0.03]] as const) {
        if (!url) continue;
        const texture = new THREE.TextureLoader().load(url, () => { renderer.shadowMap.needsUpdate = true; render(); });
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        const size = AERIAL_HALF_WIDTH_M[extent] * 2;
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), groundLayer(new THREE.MeshStandardMaterial({ map: texture, roughness: 1 }), extent === "near" ? 2 : 1));
        plane.rotation.x = -Math.PI / 2;
        plane.position.y = y;
        // Shadows only on the near window: the sun's shadow box covers the site, and its edge would show as a seam far out.
        plane.receiveShadow = extent === "near";
        groups.aerial.add(plane);
      }
      renderer.shadowMap.needsUpdate = true;
    }
    if (previous?.site.plan !== next.site.plan) {
      disposeGroup(groups.plan);
      for (const wall of next.site.plan?.walls ?? []) {
        const geometry = new THREE.ExtrudeGeometry(
          new THREE.Shape(wall.ring.map(([x, z]) => new THREE.Vector2(x, -z))),
          { depth: 3, bevelEnabled: false },
        );
        geometry.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({ color: wall.exterior ? 0x3c4a63 : 0x9aa3b0, roughness: 0.8, transparent: true, opacity: 0.9 }),
        );
        mesh.position.y = 0.02;
        groups.plan.add(mesh);
      }
    }
    if (previous?.site.distances !== next.site.distances || previous?.site.picks !== next.site.picks || previous?.site.snaps !== next.site.snaps || previous?.tool !== next.tool) {
      disposeGroup(groups.dimensions);
      for (const item of next.site.distances) {
        const points = [item.from, item.to].map(([x, z]) => new THREE.Vector3(x, 0.4, z));
        groups.dimensions.add(fatLine(points, 0xc92a2a, 2.5));
        const sprite = label(item.label);
        sprite.position.set((item.from[0] + item.to[0]) / 2, 0.4, (item.from[1] + item.to[1]) / 2);
        groups.dimensions.add(sprite);
      }
      if (next.tool === "align") {
        for (const [x, z] of next.site.snaps) groups.dimensions.add(dot(x, z, 0.25, 0x8a91a0));
        next.site.picks.forEach(([x, z], index) => groups.dimensions.add(dot(x, z, 0.6, index % 2 ? 0xb4432f : 0x5b60b9)));
      }
    }
    slice.constant = next.clipHeight;
    for (const key of ["buildings", "trees", "objects", "lidar", "roads", "railNoise", "plan", "aerial"] as const)
      groups[key].visible = next.layers[key];
    if (
      previous?.objects !== next.objects || previous?.models !== next.models ||
      previous?.site.plan !== next.site.plan ||
      previous?.layers.objects !== next.layers.objects || previous?.layers.plan !== next.layers.plan ||
      previous?.constructionLabel !== next.constructionLabel
    ) {
      disposeGroup(groups.construction);
      constructionBounds.makeEmpty();
      const plannedIds = new Set(next.objects.filter((object) => object.kind === "mass" || object.kind === "ifc").map((object) => object.id));
      const planned = [
        ...(next.layers.plan ? [groups.plan] : []),
        ...(next.layers.objects ? groups.objects.children.filter((node) => plannedIds.has(node.userData.id)) : []),
      ];
      // Display-only locator: never include it in picking, measurement or framing bounds.
      for (const node of planned) {
        const box = new THREE.Box3().setFromObject(node);
        if (box.isEmpty()) continue;
        constructionBounds.union(box);
        const { min, max } = box;
        groups.construction.add(fatLine([
          new THREE.Vector3(min.x, min.y + 0.08, min.z),
          new THREE.Vector3(max.x, min.y + 0.08, min.z),
          new THREE.Vector3(max.x, min.y + 0.08, max.z),
          new THREE.Vector3(min.x, min.y + 0.08, max.z),
          new THREE.Vector3(min.x, min.y + 0.08, min.z),
        ], 0x0f766e, 3));
      }
      if (!constructionBounds.isEmpty()) {
        const tag = label(next.constructionLabel, "#0f766e");
        tag.position.copy(constructionBounds.getCenter(new THREE.Vector3()));
        tag.position.y = constructionBounds.max.y + 1;
        tag.center.set(0.5, 0);
        groups.construction.add(tag);
      }
    }
    grid.visible = !(next.layers.aerial && groups.aerial.children.length);
    if (next.measurement.length !== 1 || next.tool !== "measure") preview = null;
    drawMeasure(next.tool === "measure" || next.measurement.length === 2 ? next.measurement : []);
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
    // Pan tool: the left button moves the view instead of orbiting, like the plan editor's hand.
    controls.mouseButtons.LEFT = next.tool === "pan" ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    renderer.domElement.style.cursor =
      next.tool === "pan" ? "grab" : next.tool === "select" ? "default" : "crosshair";
    render();
  }
  const raycaster = new THREE.Raycaster();
  raycaster.params.Points!.threshold = 0.22;
  let pointer = [0, 0];
  const down = (e: PointerEvent) => {
    pointer = [e.clientX, e.clientY];
  };
  const aim = (e: PointerEvent) => {
    const bounds = host.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((e.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((e.clientY - bounds.top) / bounds.height) * 2 + 1,
      ),
      camera,
    );
  };
  const surfaceHit = () => {
    const targets = [
      groups.buildings,
      groups.trees,
      groups.objects,
      ...(current?.tool === "measure" ? [groups.lidar] : []),
    ].filter((g) => g.visible);
    return raycaster
      .intersectObjects(targets, true)
      .find(
        (h) =>
          !(h.object instanceof THREE.LineSegments) &&
          (!(h.object instanceof THREE.Points) ||
            h.point.y <= current!.clipHeight),
      );
  };
  /** A visible surface under the pointer, else the flat ground reference; snapped like a click. */
  const measurePoint = (): SceneVector | null => {
    const point =
      surfaceHit()?.point ??
      raycaster.ray.intersectPlane(
        new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
        new THREE.Vector3(),
      );
    if (!point) return null;
    const raw = point.toArray() as SceneVector;
    return callbacks.snap ? callbacks.snap(raw) : raw;
  };
  // After the first point the line follows the pointer and measures live.
  let moveFrame = 0;
  const move = (e: PointerEvent) => {
    if (!current || current.tool !== "measure" || current.measurement.length !== 1 || e.buttons) return;
    cancelAnimationFrame(moveFrame);
    moveFrame = requestAnimationFrame(() => {
      if (!current || current.tool !== "measure" || current.measurement.length !== 1) return;
      aim(e);
      preview = measurePoint();
      drawMeasure(current.measurement);
      render();
    });
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
    if (current.tool === "pan") return;
    if (current.tool === "align") {
      const point = raycaster.ray.intersectPlane(
        new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
        new THREE.Vector3(),
      );
      if (point) callbacks.align([point.x, point.z]);
      return;
    }
    if (current.tool === "place") {
      const point = raycaster.ray.intersectPlane(
        new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
        new THREE.Vector3(),
      );
      if (point) callbacks.place(point.toArray() as SceneVector);
      return;
    }
    const hit = surfaceHit();
    if (current.tool === "measure") {
      const point = measurePoint();
      preview = null;
      if (point) callbacks.measure(point);
    } else {
      let node: THREE.Object3D | null = hit?.object ?? null;
      while (node && !node.userData.id) node = node.parent;
      callbacks.select(node?.userData.id ?? null);
    }
  };
  renderer.domElement.addEventListener("pointerdown", down);
  renderer.domElement.addEventListener("pointerup", up);
  renderer.domElement.addEventListener("pointermove", move);
  return {
    update,
    view(mode: "perspective" | "top" | "street" | "area") {
      if (mode === "area") {
        // The 2 × 2 km surroundings window from above, centred on the site.
        controls.target.set(0, 0, 0);
        camera.position.set(0, 2400, 0.01);
        controls.update();
        checkZoom();
        render();
        return;
      }
      const target = controls.target;
      const offset =
        mode === "top"
          ? [0, 150, 0.01]
          : mode === "street"
            ? [25, 4, 35]
            : homeDirection.clone().multiplyScalar(190).toArray();
      camera.position.copy(target).add(new THREE.Vector3(...offset));
      controls.update();
      render();
    },
    focus(id?: string | null) {
      const node = Object.values(groups)
        .flatMap((group) => group.children)
        .find((node) => node.userData.id === id);
      frame(node ? new THREE.Box3().setFromObject(node) : undefined);
      render();
    },
    fitConstruction() {
      frame(constructionBounds.isEmpty() ? undefined : constructionBounds);
      render();
    },
    dispose() {
      resize.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener("pointerdown", down);
      renderer.domElement.removeEventListener("pointerup", up);
      renderer.domElement.removeEventListener("pointermove", move);
      cancelAnimationFrame(moveFrame);
      pointTexture.dispose();
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
      sun.shadow.dispose();
      environment.dispose();
      sky.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
