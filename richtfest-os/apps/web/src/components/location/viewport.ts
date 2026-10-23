import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type {
  LocationContext,
  LocationTree,
  LocationScene,
  LocationPointCloud,
  SceneObject,
  SceneVector,
} from "@richtfest/shared";
import type { IfcGeometry } from "./ifc-loader";
import type { SiteOverlay } from "./site-geometry";
import { AERIAL_HALF_WIDTH_M, RAIL_NOISE_HALF_WIDTH_M, type Point2 } from "@richtfest/shared";

export type ViewportState = {
  context: LocationContext;
  /** Proposal/canonical geometry in local X/Z metres; optional groups support floor isolation. */
  assessment?: Array<{ id: string; polygons: Point2[][][]; height: number; base: number; color: number; group?: string; opacity?: number;
    edges?: boolean; roughness?: number; metalness?: number; section?: boolean; roof?: boolean }>;
  /** Fade other assessment groups without replacing their geometry; null restores the overview. */
  assessmentFocus?: string | null;
  /** Optional building cutaway; only walls/openings in the focused floor are clipped. */
  assessmentCutaway?: number | null;
  /** Keep geographic context visible but unobtrusive while inspecting the building. */
  surroundingsOpacity?: number;
  /** Building presentation uses direct orbit; site editors retain map-style pan. */
  orbitDrag?: boolean;
  /** Active canonical connections to the selected object; never inferred from mesh proximity. */
  assessmentRelated?: string[];
  /** A schematic, translucent level-zero surface. Null hides unknown ground; omitted keeps the site ground. */
  groundReference?: { bounds: [Point2, Point2] } | null;
  objects: SceneObject[];
  projectExtent?: LocationScene["projectExtent"];
  models: Record<string, IfcGeometry>;
  cloud?: LocationPointCloud;
  layers: {
    buildings: boolean;
    trees: boolean;
    /** Trees inferred from LiDAR, unreviewed; drawn apart from cadastre trees. */
    detectedTrees: boolean;
    objects: boolean;
    lidar: boolean;
    roads: boolean;
    railNoise: boolean;
    plan: boolean;
    aerial: boolean;
  };
  site: SiteOverlay;
  /** Cadastral parcels drawn on the ground; the adopted one is part of `assessment`. */
  parcels?: { items: Array<{ id: string; polygons: Point2[][][] }>; selected: string | null };
  /** Live Abstandsflächen per draft building: the part that holds and the part in conflict. */
  setbacks?: Array<{ id: string; clear: Point2[][][]; conflict: Point2[][][] }>;
  /** Footprint being drawn with the draw tool. */
  drawing?: { points: Point2[]; hover: Point2 | null } | null;
  /** Assessment item the planner can drag on the ground and extrude by its top handle. */
  editable?: { id: string; base: number; height: number; label: string } | null;
  selected: string | null;
  tool: "select" | "place" | "measure" | "align" | "pan" | "draw";
  treeStyle: "schematic" | "illustrative";
  measurement: SceneVector[];
  clipHeight: number;
  dark: boolean;
  constructionLabel: string;
  projectExtentLabel: string;
  siteAddressLabel: string;
};
export function createViewport(
  host: HTMLElement,
  callbacks: {
    /** The ground point under the click comes along so callers can pick flat layers such as parcels. */
    select: (id: string | null, ground?: Point2) => void;
    place: (point: SceneVector) => void;
    measure: (point: SceneVector) => void;
    /** Snaps a measuring point (to building and plan corners); used for clicks and the live preview alike. */
    snap?: (point: SceneVector) => SceneVector;
    align: (point: Point2) => void;
    /** Camera distance from its target, reported when it crosses the far-imagery threshold. */
    zoom?: (zoomedOut: boolean) => void;
    /** Ground point under the pointer while drawing (null when it leaves the ground). */
    hover?: (point: Point2 | null) => void;
    /** Click on the ground with the draw tool. */
    ground?: (point: Point2) => void;
    /** Dragging the editable item: "move" reports the ground offset since the drag began, "extrude" the new height. */
    drag?: {
      begin: (id: string, kind: "move" | "extrude") => void;
      move: (id: string, kind: "move" | "extrude", value: Point2 | number) => void;
    };
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
  // Plan view by default, north up: the camera looks straight down from a hair south of the target.
  const topDirection = new THREE.Vector3(0, 1, 0.001).normalize();
  const homeTarget = new THREE.Vector3(0, 0, 0);
  camera.position.copy(homeTarget).addScaledVector(topDirection, 190);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(homeTarget);
  controls.maxDistance = 2600;
  controls.minDistance = 1;
  controls.maxPolarAngle = Math.PI * 0.495;
  // Map navigation: drag pans across the ground, the wheel zooms to the cursor, and orbiting
  // needs Ctrl/⌘/Shift (OrbitControls' swap) or Option/Alt (handled below), or the right button.
  controls.screenSpacePanning = false;
  controls.zoomToCursor = true;
  controls.enableDamping = true;
  controls.dampingFactor = 0.2;
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
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
    detectedTrees: new THREE.Group(),
    objects: new THREE.Group(),
    lidar: new THREE.Group(),
    measure: new THREE.Group(),
    roads: new THREE.Group(),
    railNoise: new THREE.Group(),
    plan: new THREE.Group(),
    dimensions: new THREE.Group(),
    aerial: new THREE.Group(),
    construction: new THREE.Group(),
    buildingSelection: new THREE.Group(),
    assessment: new THREE.Group(),
    parcels: new THREE.Group(),
    setbacks: new THREE.Group(),
    drawing: new THREE.Group(),
    handles: new THREE.Group(),
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
  let outlinedBuilding: THREE.Object3D | undefined;
  const slice = new THREE.Plane(new THREE.Vector3(0, -1, 0), 50);
  const constructionBounds = new THREE.Box3();
  let current: ViewportState | undefined;
  const render = () => renderer.render(scene, camera);
  let initialFrame = true;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  let flight = 0;
  let fade = 0;
  /** Glides target and camera along the orbit (radius, tilt and heading eased separately) instead of jumping. */
  const fly = (target: THREE.Vector3, position: THREE.Vector3, ms = 450) => {
    cancelAnimationFrame(flight);
    const fromTarget = controls.target.clone();
    const from = new THREE.Spherical().setFromVector3(camera.position.clone().sub(fromTarget));
    const to = new THREE.Spherical().setFromVector3(position.clone().sub(target));
    let turn = to.theta - from.theta;
    if (turn > Math.PI) turn -= 2 * Math.PI;
    if (turn < -Math.PI) turn += 2 * Math.PI;
    let start: number | undefined;
    const step = (now: number) => {
      start ??= now;
      const k = ms <= 0 || reducedMotion ? 1 : Math.min(1, (now - start) / ms), e = k * k * (3 - 2 * k);
      controls.target.lerpVectors(fromTarget, target, e);
      const offset = new THREE.Vector3().setFromSphericalCoords(
        THREE.MathUtils.lerp(from.radius, to.radius, e), THREE.MathUtils.lerp(from.phi, to.phi, e), from.theta + turn * e);
      camera.position.copy(controls.target).add(offset);
      controls.update();
      if (k < 1) flight = requestAnimationFrame(step);
      else flight = 0;
    };
    if (ms <= 0 || reducedMotion) step(performance.now());
    else flight = requestAnimationFrame(step);
  };
  const viewDirection = () => camera.position.clone().sub(controls.target).normalize();
  /** Fits a box into view along `direction` (default: the current heading and tilt). */
  const frame = (box?: THREE.Box3, direction = viewDirection(), ms = 450, padding = 1.15) => {
    // An explicit caller framing wins even before ResizeObserver's first delivery.
    initialFrame = false;
    const target = box ? box.getCenter(new THREE.Vector3()) : homeTarget;
    const radius = box ? box.getSize(new THREE.Vector3()).length() / 2 : 58;
    const halfFov = Math.atan(
      Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) *
        Math.min(1, camera.aspect),
    );
    const distance = Math.max(12, (radius / Math.sin(halfFov)) * padding);
    fly(target, target.clone().addScaledVector(direction, distance), ms);
  };
  controls.addEventListener("change", render);
  // Damped panning and orbiting coast for a few frames after release.
  let coast = 0, interacting = false;
  const tick = () => {
    coast = 0;
    if (controls.update() || interacting) coast = requestAnimationFrame(tick);
  };
  controls.addEventListener("start", () => {
    cancelAnimationFrame(flight);
    flight = 0;
    interacting = true;
    renderer.domElement.style.cursor = "grabbing";
    if (!coast) coast = requestAnimationFrame(tick);
  });
  controls.addEventListener("end", () => {
    interacting = false;
    renderer.domElement.style.cursor = cursorFor(current);
    if (!coast) coast = requestAnimationFrame(tick);
  });
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
      if (node instanceof LineSegments2) (node.material as LineMaterial).resolution.set(renderer.domElement.width, renderer.domElement.height);
    });
    if (initialFrame) {
      initialFrame = false;
      frame(undefined, topDirection, 0);
    }
    render();
  });
  resize.observe(host);
  // Cadastre trees keep the established palette; LiDAR-detected (inferred, unreviewed) trees use the
  // same shapes in ochre so imported and inferred records stay distinguishable at a glance.
  const cadastreTree = { leaves: 0x6e8956, trunk: 0x78624c, ring: 0x708875, pole: 0x7c8c7e, disc: 0x8aa68f };
  const detectedTree = { leaves: 0xa39a5c, trunk: 0x7d6a52, ring: 0xa8874a, pole: 0xa39778, disc: 0xc9ab6e };
  const treeModel = (tree: LocationTree, id: string, state: ViewportState, palette: typeof cadastreTree) => {
    const group = new THREE.Group();
    group.userData.id = id;
    group.position.set(tree.position[0], 0, tree.position[1]);
    // Decorative crowns are never measurement targets. Unknown dimensions
    // keep their schematic markers rather than inventing a full-sized tree.
    if (
      state.treeStyle === "illustrative" &&
      state.tool !== "measure" &&
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
          color: palette.leaves,
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
        new THREE.MeshStandardMaterial({ color: palette.trunk, roughness: 1 }),
      );
      trunk.position.y = tree.height * 0.325;
      leaves.castShadow = trunk.castShadow = true;
      leaves.receiveShadow = trunk.receiveShadow = true;
      group.add(leaves, trunk);
      return group;
    }
    // Crown discs + height poles deliberately avoid inventing crown undersides.
    const radius = (tree.crownDiameter ?? 1) / 2;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(0.05, radius - 0.08), radius, 48),
      new THREE.MeshBasicMaterial({
        color: palette.ring,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.08;
    group.add(ring);
    if (tree.height) {
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.07, tree.height, 6),
        new THREE.MeshBasicMaterial({ color: palette.pole }),
      );
      pole.position.y = tree.height / 2;
      group.add(pole);
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(radius, 32),
        new THREE.MeshBasicMaterial({
          color: palette.disc,
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
    return group;
  };
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
        if (!Array.isArray(material) && material.map !== pointTexture && material.map !== extrudeTexture) material.map?.dispose();
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
  /** Pixel-wide line with a white halo; ground extents obey occlusion instead of appearing painted on roofs. */
  const fatLine = (points: THREE.Vector3[], color: number, width: number, dashed = false, depthTest = false) => {
    const group = new THREE.Group();
    const { width: w, height: h } = renderer.domElement;
    for (const [lineColor, lineWidth, order] of [[0xffffff, width + 3, 10], [color, width, 11]] as const) {
      const geometry = new LineGeometry();
      geometry.setPositions(points.flatMap((p) => [p.x, p.y, p.z]));
      const material = new LineMaterial({ color: lineColor, linewidth: lineWidth * renderer.getPixelRatio(), depthTest, depthWrite: false, transparent: true, dashed: dashed && lineColor !== 0xffffff, dashSize: 0.8, gapSize: 0.5 });
      if (depthTest) groundLayer(material, 5);
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
  /** Translucent flat polygon on the ground (with holes), ordered above imagery and parcels. */
  const flat = (polygon: Point2[][], color: number, opacity: number, y: number) => {
    const shape = new THREE.Shape(polygon[0]!.map(([x, z]) => new THREE.Vector2(x, -z)));
    shape.holes = polygon.slice(1).map((ring) => new THREE.Path(ring.map(([x, z]) => new THREE.Vector2(x, -z))));
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, groundLayer(new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }), 6));
    mesh.position.y = y;
    mesh.renderOrder = 7;
    return mesh;
  };
  /** Extrude grip: an indigo disc with up/down chevrons. */
  const extrudeTexture = (() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ffffff";
    context.beginPath();
    context.arc(32, 32, 30, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#4f46e5";
    context.beginPath();
    context.arc(32, 32, 25, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = "#ffffff";
    context.lineWidth = 5;
    context.lineCap = context.lineJoin = "round";
    context.beginPath();
    context.moveTo(22, 26); context.lineTo(32, 16); context.lineTo(42, 26);
    context.moveTo(22, 38); context.lineTo(32, 48); context.lineTo(42, 38);
    context.stroke();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  })();
  const cursorFor = (state?: ViewportState) =>
    !state || state.tool === "select" || state.tool === "pan" ? "grab" : "crosshair";
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
    controls.mouseButtons.LEFT = next.orbitDrag ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    controls.mouseButtons.RIGHT = next.orbitDrag ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    if (current?.assessment !== next.assessment) {
      disposeGroup(groups.assessment);
      // The outline belongs to meshes that are about to be replaced.
      if (outlinedBuilding?.parent === groups.assessment) outlinedBuilding = undefined;
      for (const item of next.assessment ?? []) {
        const group = new THREE.Group(); group.userData.id = item.id; group.userData.floor = item.group;
        group.userData.roof = item.roof; group.userData.section = item.section;
        for (const polygon of item.polygons) {
          if (!polygon[0]?.length) continue;
          const shape = new THREE.Shape(polygon[0].map(([x,z]) => new THREE.Vector2(x,-z)));
          shape.holes = polygon.slice(1).map(ring => new THREE.Path(ring.map(([x,z]) => new THREE.Vector2(x,-z))));
          const geometry = new THREE.ExtrudeGeometry(shape, { depth: Math.max(.04,item.height), bevelEnabled: false });
          geometry.rotateX(-Math.PI / 2);
          const opacity = item.opacity ?? (item.height > .1 ? .8 : .35);
          const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color:item.color, transparent: opacity < 1, opacity,
            roughness: item.roughness ?? .85, metalness: item.metalness ?? 0,
            depthWrite: item.opacity === undefined || opacity >= .5 }));
          mesh.position.y = item.base;
          mesh.userData.height = Math.max(.04, item.height);
          if (item.edges !== false) edges(mesh,item.color);
          mesh.castShadow = item.edges === false && opacity >= .98;
          mesh.userData.castShadow = mesh.castShadow;
          mesh.receiveShadow = item.edges === false;
          group.add(mesh);
          mesh.traverse(node => {
            if (node instanceof THREE.Mesh || node instanceof THREE.LineSegments) {
              const material = node.material as THREE.Material;
              material.userData.opacity = material.opacity;
              material.userData.depthWrite = material.depthWrite;
              material.userData.transparent = material.transparent;
              if (next.assessmentFocus && group.userData.floor !== next.assessmentFocus) {
                material.opacity *= .045;
                material.depthWrite = false;
                material.transparent = true;
              }
            }
          });
        }
        groups.assessment.add(group);
      }
    }

    const previous = current;
    current = next;
    scene.background = next.dark ? new THREE.Color(0x202a34) : next.groundReference !== undefined ? new THREE.Color(0xeef1f4) : sky;
    marker.visible = next.groundReference === undefined && !!next.siteAddressLabel;
    renderer.toneMappingExposure = next.dark ? 0.8 : 1;
    fill.intensity = next.dark ? 0.85 : 1.2;
    sun.intensity = next.dark ? 2 : 3;
    ground.visible = next.groundReference !== null;
    ground.material.transparent = !!next.groundReference;
    ground.material.opacity = next.groundReference ? .3 : 1;
    ground.material.depthWrite = !next.groundReference;
    ground.material.color.set(next.groundReference ? (next.dark ? 0x739887 : 0x7f9b80) : (next.dark ? 0x333f43 : 0xc7c8bb));
    if (next.groundReference) {
      const [[minX, minZ], [maxX, maxZ]] = next.groundReference.bounds;
      ground.scale.set((maxX - minX) / 4000, (maxZ - minZ) / 4000, 1);
      ground.position.set((minX + maxX) / 2, -.04, (minZ + maxZ) / 2);
    } else {
      ground.scale.set(1, 1, 1);
      ground.position.set(0, -.04, 0);
    }
    grid.material.color.set(next.dark ? 0x90a8ae : 0x77857c);
    if (
      previous?.context !== next.context ||
      previous?.objects !== next.objects ||
      previous?.models !== next.models ||
      previous?.layers.buildings !== next.layers.buildings ||
      previous?.layers.objects !== next.layers.objects ||
      previous?.layers.trees !== next.layers.trees ||
      previous?.layers.detectedTrees !== next.layers.detectedTrees ||
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
      disposeGroup(groups.detectedTrees);
      for (const tree of next.context.trees)
        groups.trees.add(treeModel(tree, `tree:${tree.id}`, next, cadastreTree));
      for (const tree of next.context.treeDetection?.trees ?? [])
        groups.detectedTrees.add(treeModel(tree, `detected-tree:${tree.id}`, next, detectedTree));
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
    for (const key of ["buildings", "trees", "detectedTrees", "objects", "lidar", "roads", "railNoise", "plan", "aerial"] as const)
      groups[key].visible = next.layers[key];
    if (
      previous?.context !== next.context || previous?.layers.buildings !== next.layers.buildings ||
      previous?.objects !== next.objects || previous?.models !== next.models ||
      previous?.site.plan !== next.site.plan ||
      previous?.layers.objects !== next.layers.objects || previous?.layers.plan !== next.layers.plan ||
      previous?.constructionLabel !== next.constructionLabel ||
      previous?.projectExtent !== next.projectExtent || previous?.projectExtentLabel !== next.projectExtentLabel || previous?.siteAddressLabel !== next.siteAddressLabel
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
      let locatorLabel = next.constructionLabel;
      if (constructionBounds.isEmpty()) {
        // An address-containing building is not evidence of the development's extent.
        // Only a source-backed plan interpretation can supply the fallback outline.
        const extent = next.projectExtent;
        locatorLabel = next.siteAddressLabel;
        if (extent && extent.context.siteId === next.context.siteId && extent.context.crs === (next.context.crs ?? "EPSG:25833") &&
          extent.context.origin.every((value, i) => value === next.context.origin[i])) {
          locatorLabel = next.projectExtentLabel;
          for (const ring of extent.rings) {
            const points = ring.map(([x, z]) => new THREE.Vector3(x, 0.08, z));
            for (const point of points) constructionBounds.expandByPoint(point);
            groups.construction.add(fatLine([...points, points[0]], 0x0f766e, 3, true, true));
          }
        }
      }
      // Editors that pass no labels (the site assessment's massing view) get no empty pill.
      const tag = label(locatorLabel || " ", "#0f766e");
      tag.visible = !!locatorLabel;
      if (constructionBounds.isEmpty()) tag.position.set(0, 1, 0);
      else {
        tag.position.copy(constructionBounds.getCenter(new THREE.Vector3()));
        tag.position.y = constructionBounds.max.y + 1;
      }
      tag.center.set(0.5, 0);
      groups.construction.add(tag);
    }
    grid.visible = next.groundReference === undefined && !(next.layers.aerial && groups.aerial.children.length);
    if (next.measurement.length !== 1 || next.tool !== "measure") preview = null;
    drawMeasure(next.tool === "measure" || next.measurement.length === 2 ? next.measurement : []);
    const selected = Object.values(groups)
      .flatMap((group) => group.children)
      .find(
        (node) => node.userData.id === next.selected && node.parent?.visible,
      );
    const building = selected?.parent === groups.buildings || selected?.parent === groups.assessment ? selected : undefined;
    if (building !== outlinedBuilding || previous?.assessmentRelated !== next.assessmentRelated || previous?.assessment !== next.assessment
      || previous?.assessmentFocus !== next.assessmentFocus || (building && !groups.buildingSelection.children.length)) {
      disposeGroup(groups.buildingSelection);
      outlinedBuilding = building;
      const connected = building ? groups.assessment.children.filter(node => node !== building && next.assessmentRelated?.includes(node.userData.id)
        && (!next.assessmentFocus || node.userData.floor === next.assessmentFocus)) : [];
      for (const object of [...(building ? [building] : []), ...connected]) {
      object.updateWorldMatrix(true, true);
      object.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        // Outline the rendered footprint extrusion, including concavities and holes, not its world-axis box.
        const edges = new THREE.EdgesGeometry(node.geometry, 25).applyMatrix4(node.matrixWorld);
        const geometry = new LineSegmentsGeometry().setPositions(edges.getAttribute("position").array as Float32Array);
        edges.dispose();
        const material = new LineMaterial({ color: object === building ? 0x7279d7 : 0x718c91, linewidth: 2 * renderer.getPixelRatio(), depthWrite: false,
          transparent: true, depthTest: object !== building,
          polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2, toneMapped: false });
        material.resolution.set(renderer.domElement.width, renderer.domElement.height);
        const outline = new LineSegments2(geometry, material);
        outline.renderOrder = 13;
        groups.buildingSelection.add(outline);
      });
      }
    }
    selection.visible = !!selected && !building;
    if (selected && !building) {
      selected.updateWorldMatrix(true, true);
      selection.box.setFromObject(selected);
      selection.updateMatrixWorld(true);
    }
    if (previous?.parcels !== next.parcels) {
      disposeGroup(groups.parcels);
      const segments: number[] = [];
      for (const parcel of next.parcels?.items ?? [])
        for (const polygon of parcel.polygons)
          for (const ring of polygon)
            for (let i = 0; i + 1 < ring.length; i++) segments.push(ring[i]![0], 0.05, ring[i]![1], ring[i + 1]![0], 0.05, ring[i + 1]![1]);
      if (segments.length) {
        const material = groundLayer(new LineMaterial({ color: next.dark ? 0xcbd5e1 : 0x475569, linewidth: 1 * renderer.getPixelRatio(), transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false }), 5);
        material.resolution.set(renderer.domElement.width, renderer.domElement.height);
        const lines = new LineSegments2(new LineSegmentsGeometry().setPositions(segments), material);
        lines.renderOrder = 6;
        groups.parcels.add(lines);
      }
      const selectedParcel = next.parcels?.items.find((parcel) => parcel.id === next.parcels?.selected);
      for (const polygon of selectedParcel?.polygons ?? []) {
        groups.parcels.add(flat(polygon, 0x5b60b9, 0.18, 0.055));
        for (const ring of polygon) groups.parcels.add(fatLine(ring.map(([x, z]) => new THREE.Vector3(x, 0.06, z)), 0x5b60b9, 2.5, false, true));
      }
    }
    if (previous?.setbacks !== next.setbacks) {
      disposeGroup(groups.setbacks);
      for (const item of next.setbacks ?? []) {
        for (const polygon of item.clear) groups.setbacks.add(flat(polygon, 0x16a34a, 0.3, 0.07));
        for (const polygon of item.conflict) {
          groups.setbacks.add(flat(polygon, 0xdc2626, 0.5, 0.075));
          for (const ring of polygon) groups.setbacks.add(fatLine(ring.map(([x, z]) => new THREE.Vector3(x, 0.08, z)), 0xdc2626, 2, false, true));
        }
      }
    }
    if (previous?.drawing !== next.drawing) {
      disposeGroup(groups.drawing);
      const drawing = next.drawing;
      if (drawing?.points.length) {
        const path = [...drawing.points, ...(drawing.hover ? [drawing.hover] : [])].map(([x, z]) => new THREE.Vector3(x, 0.12, z));
        if (path.length > 1) groups.drawing.add(fatLine(path, 0x1e293b, 2.5));
        // The closing edge stays dashed until the footprint is finished.
        if (path.length > 2) groups.drawing.add(fatLine([path.at(-1)!, path[0]!], 0x1e293b, 1.5, true));
        path.slice(0, drawing.points.length).forEach((point, index) => {
          const sprite = handle(point);
          if (index === 0) screenSized(sprite, 18);
          groups.drawing.add(sprite);
        });
      }
    }
    if (previous?.editable !== next.editable || previous?.assessment !== next.assessment) {
      disposeGroup(groups.handles);
      const item = next.editable && groups.assessment.children.find((node) => node.userData.id === next.editable!.id);
      if (item && next.editable) {
        const box = new THREE.Box3().setFromObject(item);
        const top = new THREE.Vector3((box.min.x + box.max.x) / 2, next.editable.base + next.editable.height, (box.min.z + box.max.z) / 2);
        const grip = new THREE.Sprite(new THREE.SpriteMaterial({ map: extrudeTexture, depthTest: false, toneMapped: false, sizeAttenuation: false }));
        screenSized(grip, 26);
        grip.position.copy(top);
        grip.renderOrder = 14;
        grip.userData.extrude = next.editable.id;
        const tag = label(next.editable.label, "#3730a3");
        tag.position.copy(top);
        tag.center.set(-0.18, 0.5);
        groups.handles.add(grip, tag);
      }
    }
    // Run after context/image rebuilds so newly loaded geography inherits the current focus.
    if (previous?.assessment !== next.assessment || previous?.assessmentFocus !== next.assessmentFocus
      || previous?.assessmentCutaway !== next.assessmentCutaway || previous?.surroundingsOpacity !== next.surroundingsOpacity
      || previous?.context !== next.context || previous?.site.aerial.near !== next.site.aerial.near
      || previous?.site.aerial.far !== next.site.aerial.far || previous?.treeStyle !== next.treeStyle) {
      cancelAnimationFrame(fade);
      const transitions = new Map<THREE.Material, { from: number; to: number; transparent: boolean }>();
      const sections: Array<{ mesh: THREE.Mesh; from: number; to: number }> = [];
      const ghostCaps = next.assessment?.some(item => item.roof);
      const visibility: Array<{ group: THREE.Object3D; visible: boolean }> = [];
      for (const group of groups.assessment.children) {
        const inactive = !!next.assessmentFocus && group.userData.floor !== next.assessmentFocus;
        group.visible = true;
        // Retain floor silhouettes after the fade, not thousands of translucent
        // beds and internal faces that obscure the room being inspected.
        visibility.push({ group, visible: !inactive || !ghostCaps || !!group.userData.roof });
        const cutaway = !inactive && next.assessmentFocus && next.assessmentCutaway != null;
        group.traverse(node => {
          if (!(node instanceof THREE.Mesh || node instanceof THREE.LineSegments)) return;
          const sectionHeight = cutaway && group.userData.section && node instanceof THREE.Mesh
            ? Math.max(0, next.assessmentCutaway! - node.position.y) : Infinity;
          const hidden = !!(cutaway && group.userData.roof) || sectionHeight === 0;
          if (node instanceof THREE.Mesh) {
            // Animate capped extrusions, not hollow clipping planes.
            sections.push({ mesh: node, from: node.scale.y, to: Math.min(1, sectionHeight / node.userData.height) });
            node.castShadow = !inactive && !hidden && node.userData.castShadow;
          }
          node.userData.inactive = inactive || hidden;
          const material = node.material as THREE.Material;
          material.depthWrite = !node.userData.inactive && material.userData.depthWrite;
          const to = material.userData.opacity * (hidden ? 0 : inactive ? .035 : 1);
          const transparent = material.userData.transparent || material.opacity !== to || to < 1;
          if (material.transparent !== transparent) { material.transparent = transparent; material.needsUpdate = true; }
          transitions.set(material, { from: material.opacity, to, transparent: material.userData.transparent || to < 1 });
        });
      }
      for (const group of [groups.buildings, groups.trees, groups.detectedTrees, groups.aerial, groups.roads]) group.traverse(node => {
        if (!(node instanceof THREE.Mesh || node instanceof THREE.Line || node instanceof THREE.Sprite)) return;
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
          material.userData.contextOpacity ??= material.opacity;
          material.userData.contextDepthWrite ??= material.depthWrite;
          material.userData.contextTransparent ??= material.transparent;
          const opacity = next.surroundingsOpacity ?? 1;
          const to = material.userData.contextOpacity * opacity;
          const transparent = material.userData.contextTransparent || material.opacity !== to || to < 1;
          if (material.transparent !== transparent) { material.transparent = transparent; material.needsUpdate = true; }
          material.depthWrite = opacity === 1 && material.userData.contextDepthWrite;
          transitions.set(material, { from: material.opacity, to, transparent: material.userData.contextTransparent || to < 1 });
        }
        node.userData.contextCastShadow ??= node.castShadow;
        node.castShadow = (next.surroundingsOpacity ?? 1) === 1 && node.userData.contextCastShadow;
      });
      // Shader compilation during update must not consume the transition's duration.
      let start: number | undefined;
      const step = (now: number) => {
        start ??= now;
        const k = reducedMotion || !previous ? 1 : Math.min(1, (now - start) / 1200), eased = k * k * (3 - 2 * k);
        for (const [material, { from, to, transparent }] of transitions) {
          material.opacity = THREE.MathUtils.lerp(from, to, eased);
          if (k === 1 && material.transparent !== transparent) { material.transparent = transparent; material.needsUpdate = true; }
        }
        if (k === 1) for (const { group, visible } of visibility) group.visible = visible;
        for (const { mesh, from, to } of sections) mesh.scale.y = THREE.MathUtils.lerp(from, to, eased);
        // Keep a camera flight cheap; refresh the static shadow map at the
        // endpoints instead of redrawing every wall into it on every frame.
        if (k === 0 || k === 1) renderer.shadowMap.needsUpdate = true;
        if (!flight) render();
        if (k < 1) fade = requestAnimationFrame(step);
      };
      if (reducedMotion || !previous) step(performance.now());
      else fade = requestAnimationFrame(step);
    }
    renderer.domElement.style.cursor = cursorFor(next);
    render();
  }
  const raycaster = new THREE.Raycaster();
  raycaster.params.Points!.threshold = 0.22;
  let pointer = [0, 0];
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const aim = (e: { clientX: number; clientY: number }) => {
    const bounds = host.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((e.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((e.clientY - bounds.top) / bounds.height) * 2 + 1,
      ),
      camera,
    );
  };
  const groundPoint = () => raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3());
  const surfaceHit = () => {
    const targets = [
      ...((current?.surroundingsOpacity ?? 1) === 1 ? [groups.buildings, groups.trees, groups.detectedTrees] : []),
      groups.objects,
      groups.assessment,
      ...(current?.tool === "measure" ? [groups.lidar] : []),
    ].filter((g) => g.visible);
    return raycaster
      .intersectObjects(targets, true)
      .find(
        (h) =>
          !(h.object instanceof THREE.LineSegments) &&
          !h.object.userData.inactive &&
          (!(h.object instanceof THREE.Points) ||
            h.point.y <= current!.clipHeight),
      );
  };
  /** A visible surface under the pointer, else the flat ground reference; snapped like a click. */
  const measurePoint = (): SceneVector | null => {
    const point = surfaceHit()?.point ?? groundPoint();
    if (!point) return null;
    const raw = point.toArray() as SceneVector;
    return callbacks.snap ? callbacks.snap(raw) : raw;
  };
  /** What a press on the editable item would grab: its top grip extrudes, its body moves. */
  const grabTarget = (): "move" | "extrude" | null => {
    const editable = current?.editable;
    if (!editable || current?.tool !== "select" || !callbacks.drag) return null;
    if (raycaster.intersectObjects(groups.handles.children.filter((node) => node.userData.extrude), false).length) return "extrude";
    const item = groups.assessment.children.find((node) => node.userData.id === editable.id);
    return item && raycaster.intersectObject(item, true).length ? "move" : null;
  };
  // Dragging the editable item takes the press away from the map controls.
  let drag: { id: string; kind: "move" | "extrude"; start: THREE.Vector3; plane: THREE.Plane; base: number } | null = null;
  let dragFrame = 0;
  const dragMove = (e: PointerEvent) => {
    if (!drag) return;
    cancelAnimationFrame(dragFrame);
    dragFrame = requestAnimationFrame(() => {
      if (!drag) return;
      aim(e);
      const point = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
      if (!point) return;
      if (drag.kind === "move") callbacks.drag?.move(drag.id, "move", [point.x - drag.start.x, point.z - drag.start.z]);
      else callbacks.drag?.move(drag.id, "extrude", Math.max(0, point.y - drag.base));
    });
  };
  const dragEnd = () => {
    drag = null;
    controls.enabled = true;
    window.removeEventListener("pointermove", dragMove);
    window.removeEventListener("pointerup", dragEnd);
    window.removeEventListener("pointercancel", dragEnd);
    renderer.domElement.style.cursor = cursorFor(current);
  };
  /** Runs before the map controls (capture on the host): picks the orbit modifier and starts item drags. */
  const press = (e: PointerEvent) => {
    if (e.button !== 0) return;
    // Option/Alt orbits; Ctrl/⌘/Shift are swapped to orbit by OrbitControls itself.
    controls.mouseButtons.LEFT = e.altKey && !(e.ctrlKey || e.metaKey || e.shiftKey) ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !current?.editable) return;
    aim(e);
    const kind = grabTarget();
    if (!kind) return;
    const editable = current.editable;
    let plane: THREE.Plane, start: THREE.Vector3 | null;
    if (kind === "move") {
      plane = groundPlane.clone();
      start = groundPoint();
    } else {
      // A vertical plane through the grip that faces the camera turns pointer height into building height.
      const grip = groups.handles.children.find((node) => node.userData.extrude)!.position;
      const facing = camera.position.clone().sub(grip).setY(0);
      if (facing.lengthSq() < 1e-6) facing.set(0, 0, 1);
      plane = new THREE.Plane().setFromNormalAndCoplanarPoint(facing.normalize(), grip);
      start = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    }
    if (!start) return;
    drag = { id: editable.id, kind, start, plane, base: editable.base };
    controls.enabled = false;
    callbacks.drag!.begin(editable.id, kind);
    renderer.domElement.style.cursor = kind === "move" ? "move" : "ns-resize";
    window.addEventListener("pointermove", dragMove);
    window.addEventListener("pointerup", dragEnd);
    window.addEventListener("pointercancel", dragEnd);
  };
  const down = (e: PointerEvent) => {
    pointer = [e.clientX, e.clientY];
  };
  // After the first point the line follows the pointer and measures live; drawing and grab cursors follow it too.
  let moveFrame = 0;
  const move = (e: PointerEvent) => {
    if (!current || e.buttons || drag) return;
    const tool = current.tool;
    if (!(tool === "measure" && current.measurement.length === 1) && tool !== "draw" && !(tool === "select" && current.editable)) return;
    cancelAnimationFrame(moveFrame);
    moveFrame = requestAnimationFrame(() => {
      if (!current || drag) return;
      aim(e);
      if (current.tool === "draw") {
        const point = groundPoint();
        callbacks.hover?.(point ? [point.x, point.z] : null);
        return;
      }
      if (current.tool === "select") {
        const kind = grabTarget();
        renderer.domElement.style.cursor = kind === "move" ? "move" : kind === "extrude" ? "ns-resize" : cursorFor(current);
        return;
      }
      if (current.tool !== "measure" || current.measurement.length !== 1) return;
      preview = measurePoint();
      drawMeasure(current.measurement);
      render();
    });
  };
  const leave = () => {
    if (current?.tool === "draw") callbacks.hover?.(null);
  };
  const up = (e: PointerEvent) => {
    if (
      !current ||
      e.button !== 0 ||
      Math.hypot(e.clientX - pointer[0], e.clientY - pointer[1]) > 4
    )
      return;
    aim(e);
    if (current.tool === "pan") return;
    if (current.tool === "align") {
      const point = groundPoint();
      if (point) callbacks.align([point.x, point.z]);
      return;
    }
    if (current.tool === "place") {
      const point = groundPoint();
      if (point) callbacks.place(point.toArray() as SceneVector);
      return;
    }
    if (current.tool === "draw") {
      const point = groundPoint();
      if (point) callbacks.ground?.([point.x, point.z]);
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
      const ground = groundPoint();
      callbacks.select(node?.userData.id ?? null, ground ? [ground.x, ground.z] : undefined);
    }
  };
  host.addEventListener("pointerdown", press, true);
  renderer.domElement.addEventListener("pointerdown", down);
  renderer.domElement.addEventListener("pointerup", up);
  renderer.domElement.addEventListener("pointermove", move);
  renderer.domElement.addEventListener("pointerleave", leave);
  return {
    update,
    view(mode: "perspective" | "top" | "street" | "area") {
      if (mode === "area") {
        // The 2 × 2 km surroundings window from above, centred on the site.
        fly(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 2400, 2.4), 600);
        return;
      }
      const target = controls.target.clone();
      const distance = camera.position.distanceTo(target);
      const position =
        mode === "street"
          ? target.clone().add(new THREE.Vector3(25, 4, 35))
          : target.clone().addScaledVector(mode === "top" ? topDirection : homeDirection, distance);
      fly(target, position);
    },
    /** Zooms towards the view centre by `factor` (> 1 closer). */
    zoom(factor: number) {
      const target = controls.target.clone();
      const offset = camera.position.clone().sub(target);
      const distance = THREE.MathUtils.clamp(offset.length() / factor, controls.minDistance, controls.maxDistance);
      fly(target, target.clone().addScaledVector(offset.normalize(), distance), 250);
    },
    /** Frames local X/Z points from above ("top"), at the oblique 3D angle, or along the current view; `ms` 0 jumps. */
    fit(points: Point2[], mode?: "top" | "perspective", ms = 450, height = 0, base = 0, padding = 1.15) {
      const direction = mode === "top" ? topDirection : mode === "perspective" ? homeDirection : viewDirection();
      if (!points.length) return frame(undefined, direction, ms);
      const box = new THREE.Box3();
      for (const [x, z] of points) box.expandByPoint(new THREE.Vector3(x, base, z)).expandByPoint(new THREE.Vector3(x, base + height, z));
      frame(box, direction, ms, padding);
    },
    focus(id?: string | null) {
      const node = id ? Object.values(groups)
        .flatMap((group) => group.children)
        .find((node) => node.userData.id === id) : undefined;
      frame(node ? new THREE.Box3().setFromObject(node) : undefined);
    },
    fitConstruction() {
      frame(constructionBounds.isEmpty() ? undefined : constructionBounds);
    },
    dispose() {
      resize.disconnect();
      cancelAnimationFrame(flight);
      cancelAnimationFrame(fade);
      cancelAnimationFrame(coast);
      cancelAnimationFrame(dragFrame);
      dragEnd();
      controls.dispose();
      host.removeEventListener("pointerdown", press, true);
      renderer.domElement.removeEventListener("pointerleave", leave);
      renderer.domElement.removeEventListener("pointerdown", down);
      renderer.domElement.removeEventListener("pointerup", up);
      renderer.domElement.removeEventListener("pointermove", move);
      cancelAnimationFrame(moveFrame);
      pointTexture.dispose();
      extrudeTexture.dispose();
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
