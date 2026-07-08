import * as THREE from 'three';
import { contours } from 'd3-contour';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { CLICKER } from './dimensions';
import { pointsToMillimeters } from './geometry';
import type { Point } from './geometry';

type RGB = {
  r: number;
  g: number;
  b: number;
};

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let controls: OrbitControls;
let modelGroup: THREE.Group;

export function createViewer(container: HTMLElement) {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe5e7eb);

  camera = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight,
    0.1,
    1000,
  );

  camera.position.set(75, -95, 70);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 8);
  controls.update();

  scene.add(new THREE.AmbientLight(0xffffff, 0.75));

  const light = new THREE.DirectionalLight(0xffffff, 0.8);
  light.position.set(70, -90, 110);
  scene.add(light);

  modelGroup = new THREE.Group();
  scene.add(modelGroup);

  window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });

  animate();
}

export function showClickerPreview(outline: Point[], imageCanvas?: HTMLCanvasElement) {
  clearGroup(modelGroup);

  const capPoints = pointsToMillimeters(
    outline,
    CLICKER.capMaxSize,
    CLICKER.capMinShortSide,
  );

  const basePoints = pointsToMillimeters(
    outline,
    CLICKER.baseMaxSize,
    CLICKER.baseMinShortSide,
  );

  const topCap = makeTopCapPreview(capPoints);
  const colorSticker = imageCanvas
    ? makeColorStickerPreview(capPoints, imageCanvas)
    : new THREE.Group();

  const bottomBase = makeBottomBasePreview(basePoints, capPoints);

  // Show the cap upright now, because the image belongs on the top face.
  topCap.position.set(-42, 0, 0);
  colorSticker.position.set(-42, 0, CLICKER.capTotalHeight + 0.08);

  bottomBase.position.x = 42;

  modelGroup.add(topCap, colorSticker, bottomBase);
}

export function exportCurrentPreviewAsSTL() {
  if (!modelGroup || modelGroup.children.length === 0) {
    alert('Generate a clicker preview first.');
    return;
  }

  const exporter = new STLExporter();
  const stlText = exporter.parse(modelGroup, { binary: false });

  const blob = new Blob([stlText], {
    type: 'model/stl',
  });

  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = 'image-clicker-preview.stl';
  document.body.appendChild(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(url);
}

function makeColorStickerPreview(capPoints: Point[], imageCanvas: HTMLCanvasElement) {
  const group = new THREE.Group();

  const ctx = imageCanvas.getContext('2d', { willReadFrequently: true });

  if (!ctx) {
    return group;
  }

  const imageData = ctx.getImageData(0, 0, imageCanvas.width, imageCanvas.height);
  const data = imageData.data;

  const capBox = getPointBox(capPoints);
  const background = estimateCanvasBackground(data, imageCanvas.width, imageCanvas.height);

  const gridSize = 120;
  const maxColors = 6;

  const colorGrid = buildQuantizedColorGrid(
    data,
    imageCanvas.width,
    imageCanvas.height,
    gridSize,
    maxColors,
    background,
  );

  for (let colorIndex = 0; colorIndex < colorGrid.palette.length; colorIndex++) {
    const values = colorGrid.assignments.map((value) => (value === colorIndex ? 1 : 0));

    const contourGenerator = contours()
      .size([gridSize, gridSize])
      .thresholds([0.5]);

    const contourResults = contourGenerator(values);
    const color = colorGrid.palette[colorIndex];

    for (const contour of contourResults) {
      for (const polygon of contour.coordinates) {
        const shapes = contourPolygonToShapes(
          polygon,
          gridSize,
          capBox,
          capPoints,
        );

        for (const shape of shapes) {
          const geometry = new THREE.ExtrudeGeometry(shape, {
            depth: 0.45,
            bevelEnabled: false,
          });

          geometry.computeVertexNormals();

          const material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(color.r / 255, color.g / 255, color.b / 255),
            roughness: 0.5,
            metalness: 0.02,
            side: THREE.DoubleSide,
          });

          const mesh = new THREE.Mesh(geometry, material);
          group.add(mesh);
        }
      }
    }
  }

  return group;
}

function buildQuantizedColorGrid(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  gridSize: number,
  maxColors: number,
  background: RGB,
) {
  const samples: Array<RGB & { gx: number; gy: number }> = [];
  const assignments = new Array<number>(gridSize * gridSize).fill(-1);

  const cellW = width / gridSize;
  const cellH = height / gridSize;

  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      const px = Math.floor((gx + 0.5) * cellW);
      const py = Math.floor((gy + 0.5) * cellH);

      const i = (py * width + px) * 4;

      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      if (a < 20) continue;

      const bgDiff = colorDistance({ r, g, b }, background);

      // Skip white/transparent background, keep actual image colors.
      if (bgDiff < 18) continue;

      samples.push({ r, g, b, gx, gy });
    }
  }

  const palette = kMeansColors(samples, maxColors, 8);

  for (const sample of samples) {
    let bestIndex = 0;
    let bestDistance = Infinity;

    for (let i = 0; i < palette.length; i++) {
      const distance = colorDistance(sample, palette[i]);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }

    assignments[sample.gy * gridSize + sample.gx] = bestIndex;
  }

  return {
    palette,
    assignments,
  };
}

function contourPolygonToShapes(
  polygon: number[][][],
  gridSize: number,
  capBox: ReturnType<typeof getPointBox>,
  capPoints: Point[],
) {
  const shapes: THREE.Shape[] = [];

  if (polygon.length === 0) return shapes;

  const outerRing = polygon[0];
  const outerPoints = ringToCapPoints(outerRing, gridSize, capBox);

  if (outerPoints.length < 3) return shapes;

  const center = averagePoint(outerPoints);

  if (!pointInPolygon(center, capPoints)) {
    return shapes;
  }

  const shape = makeShape(outerPoints);

  for (let i = 1; i < polygon.length; i++) {
    const holeRing = polygon[i];
    const holePoints = ringToCapPoints(holeRing, gridSize, capBox);

    if (holePoints.length < 3) continue;

    const holePath = new THREE.Path();
    holePath.moveTo(holePoints[0].x, holePoints[0].y);

    for (let j = 1; j < holePoints.length; j++) {
      holePath.lineTo(holePoints[j].x, holePoints[j].y);
    }

    holePath.closePath();
    shape.holes.push(holePath);
  }

  shapes.push(shape);

  return shapes;
}

function ringToCapPoints(
  ring: number[][],
  gridSize: number,
  capBox: ReturnType<typeof getPointBox>,
) {
  return ring.map(([gx, gy]) => {
    const x = capBox.minX + (gx / gridSize) * capBox.width;
    const y = capBox.maxY - (gy / gridSize) * capBox.height;

    return { x, y };
  });
}

function kMeansColors(samples: RGB[], maxColors: number, iterations: number) {
  if (samples.length === 0) return [];

  const sorted = [...samples].sort((a, b) => {
    const brightnessA = (a.r + a.g + a.b) / 3;
    const brightnessB = (b.r + b.g + b.b) / 3;

    return brightnessA - brightnessB;
  });

  const centers: RGB[] = [];

  for (let i = 0; i < maxColors; i++) {
    const index = Math.floor(((i + 0.5) * sorted.length) / maxColors);
    const sample = sorted[Math.min(sorted.length - 1, index)];

    centers.push({ r: sample.r, g: sample.g, b: sample.b });
  }

  for (let iteration = 0; iteration < iterations; iteration++) {
    const groups = centers.map(() => [] as RGB[]);

    for (const sample of samples) {
      let bestIndex = 0;
      let bestDistance = Infinity;

      for (let i = 0; i < centers.length; i++) {
        const distance = colorDistance(sample, centers[i]);

        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = i;
        }
      }

      groups[bestIndex].push(sample);
    }

    for (let i = 0; i < centers.length; i++) {
      if (groups[i].length === 0) continue;

      centers[i] = {
        r: Math.round(groups[i].reduce((sum, p) => sum + p.r, 0) / groups[i].length),
        g: Math.round(groups[i].reduce((sum, p) => sum + p.g, 0) / groups[i].length),
        b: Math.round(groups[i].reduce((sum, p) => sum + p.b, 0) / groups[i].length),
      };
    }
  }

  const unique: RGB[] = [];

  for (const center of centers) {
    if (!unique.some((existing) => colorDistance(existing, center) < 16)) {
      unique.push(center);
    }
  }

  return unique;
}

function makeTopCapPreview(capPoints: Point[]) {
  const group = new THREE.Group();
  const capMaterial = makeMaterial(0x2563eb);

  const capShape = makeShape(capPoints);
  const cavityShape = makeCircleShape(CLICKER.capInnerCavityDiameter / 2);
  const postShape = makeCircleShape(CLICKER.socketPostRadius);
  const crossShape = makeCrossShape(
    CLICKER.socketCrossLength + CLICKER.socketFitClearance,
    CLICKER.socketCrossWidth + CLICKER.socketFitClearance,
  );

  const lowerShell = extrudeShapeWithHoles(
    capShape,
    [cavityShape],
    CLICKER.capInnerCavityDepth,
    capMaterial,
  );

  const upperBody = extrudeShape(
    capShape,
    CLICKER.capTotalHeight - CLICKER.capInnerCavityDepth,
    capMaterial,
  );
  upperBody.position.z = CLICKER.capInnerCavityDepth;

  const socketPost = extrudeShapeWithHoles(
    postShape,
    [crossShape],
    CLICKER.socketPostHeight,
    capMaterial,
  );

  group.add(lowerShell, upperBody, socketPost);

  return group;
}

function makeBottomBasePreview(basePoints: Point[], capPoints: Point[]) {
  const group = new THREE.Group();
  const baseMaterial = makeMaterial(0x9ca3af);

  const baseShape = makeShape(basePoints);

  const indentScale =
    (CLICKER.capMaxSize + CLICKER.baseTopIndentClearance) / CLICKER.capMaxSize;

  const indentPoints = scalePointsAroundCenter(capPoints, indentScale);
  const indentShape = makeShape(indentPoints);

  const topSquare = makeSquareShape(CLICKER.switchTopSquareSize);
  const lowerSquare = makeSquareShape(
    CLICKER.switchTopSquareSize - CLICKER.switchStepInset * 2,
  );
  const centerCircle = makeCircleShape(CLICKER.switchCenterCircleDiameter / 2);

  const midZ = CLICKER.baseHeight - CLICKER.baseTopIndentDepth;

  const zTopPocketBottom = midZ - CLICKER.switchTopSquareDepth;
  const zLowerPocketBottom =
    midZ - CLICKER.switchTopSquareDepth - CLICKER.switchLowerSquareDepth;
  const zCircleBottom = zLowerPocketBottom - CLICKER.switchCenterCircleDepth;

  const bottomSolid = extrudeShape(
    baseShape,
    Math.max(0.6, zCircleBottom),
    baseMaterial,
  );

  const centerLayer = extrudeShapeWithHoles(
    baseShape,
    [centerCircle],
    zLowerPocketBottom - Math.max(0.6, zCircleBottom),
    baseMaterial,
  );
  centerLayer.position.z = Math.max(0.6, zCircleBottom);

  const lowerPocketLayer = extrudeShapeWithHoles(
    baseShape,
    [lowerSquare],
    zTopPocketBottom - zLowerPocketBottom,
    baseMaterial,
  );
  lowerPocketLayer.position.z = zLowerPocketBottom;

  const topPocketLayer = extrudeShapeWithHoles(
    baseShape,
    [topSquare],
    midZ - zTopPocketBottom,
    baseMaterial,
  );
  topPocketLayer.position.z = zTopPocketBottom;

  const topIndentLayer = extrudeShapeWithHoles(
    baseShape,
    [indentShape],
    CLICKER.baseHeight - midZ,
    baseMaterial,
  );
  topIndentLayer.position.z = midZ;

  group.add(
    bottomSolid,
    centerLayer,
    lowerPocketLayer,
    topPocketLayer,
    topIndentLayer,
  );

  return group;
}

function makeShape(points: Point[]) {
  const shape = new THREE.Shape();

  shape.moveTo(points[0].x, points[0].y);

  for (let i = 1; i < points.length; i++) {
    shape.lineTo(points[i].x, points[i].y);
  }

  shape.closePath();

  return shape;
}

function makeCircleShape(radius: number, segments = 80) {
  const points: Point[] = [];

  for (let i = 0; i < segments; i++) {
    const angle = (Math.PI * 2 * i) / segments;

    points.push({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    });
  }

  return makeShape(points);
}

function makeSquareShape(size: number) {
  const s = size / 2;

  return makeShape([
    { x: -s, y: -s },
    { x: s, y: -s },
    { x: s, y: s },
    { x: -s, y: s },
  ]);
}

function makeCrossShape(length: number, width: number) {
  const l = length / 2;
  const w = width / 2;

  return makeShape([
    { x: -w, y: -l },
    { x: w, y: -l },
    { x: w, y: -w },
    { x: l, y: -w },
    { x: l, y: w },
    { x: w, y: w },
    { x: w, y: l },
    { x: -w, y: l },
    { x: -w, y: w },
    { x: -l, y: w },
    { x: -l, y: -w },
    { x: -w, y: -w },
  ]);
}

function extrudeShape(shape: THREE.Shape, depth: number, material: THREE.Material) {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
  });

  geometry.computeVertexNormals();

  return new THREE.Mesh(geometry, material);
}

function extrudeShapeWithHoles(
  shape: THREE.Shape,
  holes: THREE.Shape[],
  depth: number,
  material: THREE.Material,
) {
  const shapeWithHoles = shape.clone();

  shapeWithHoles.holes = holes.map((hole) => {
    const path = new THREE.Path();
    const points = hole.getPoints(80);

    path.moveTo(points[0].x, points[0].y);

    for (let i = 1; i < points.length; i++) {
      path.lineTo(points[i].x, points[i].y);
    }

    path.closePath();

    return path;
  });

  return extrudeShape(shapeWithHoles, depth, material);
}

function scalePointsAroundCenter(points: Point[], scale: number) {
  const center = averagePoint(points);

  return points.map((p) => ({
    x: center.x + (p.x - center.x) * scale,
    y: center.y + (p.y - center.y) * scale,
  }));
}

function averagePoint(points: Point[]) {
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
}

function getPointBox(points: Point[]) {
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function estimateCanvasBackground(
  data: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const samples = [
    [5, 5],
    [width - 6, 5],
    [5, height - 6],
    [width - 6, height - 6],
    [width / 2, 5],
    [width / 2, height - 6],
    [5, height / 2],
    [width - 6, height / 2],
  ].map(([rawX, rawY]) => {
    const x = Math.floor(rawX);
    const y = Math.floor(rawY);
    const i = (y * width + x) * 4;

    return {
      r: data[i],
      g: data[i + 1],
      b: data[i + 2],
    };
  });

  return {
    r: Math.round(samples.reduce((sum, p) => sum + p.r, 0) / samples.length),
    g: Math.round(samples.reduce((sum, p) => sum + p.g, 0) / samples.length),
    b: Math.round(samples.reduce((sum, p) => sum + p.b, 0) / samples.length),
  };
}

function pointInPolygon(point: Point, polygon: Point[]) {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + 0.000001) + xi;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function colorDistance(a: RGB, b: RGB) {
  return Math.sqrt(
    (a.r - b.r) ** 2 +
    (a.g - b.g) ** 2 +
    (a.b - b.b) ** 2,
  );
}

function makeMaterial(color: number) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.55,
    metalness: 0.03,
    side: THREE.DoubleSide,
  });
}

function clearGroup(group: THREE.Group) {
  while (group.children.length > 0) {
    const child = group.children.pop();

    if (!child) continue;

    if ('geometry' in child && child.geometry instanceof THREE.BufferGeometry) {
      child.geometry.dispose();
    }

    if ('material' in child) {
      const material = child.material;

      if (Array.isArray(material)) {
        material.forEach((m) => m.dispose());
      } else if (material instanceof THREE.Material) {
        material.dispose();
      }
    }
  }
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}