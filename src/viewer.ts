import * as THREE from 'three';
import JSZip from 'jszip';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CLICKER } from './dimensions';
import { type Point, pointsToMillimeters, weightedVisualCenter } from './geometry';
import { traceCanvasToSvg } from './imageTrace';

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

export async function showClickerPreview(outline: Point[], imageCanvas?: HTMLCanvasElement) {
  clearGroup(modelGroup);

  const capPoints = pointsToMillimeters(
  outline,
  CLICKER.capInnerCavityDiameter + CLICKER.capEdgeGap * 2,
);

const basePoints = pointsToMillimeters(
  outline,
  CLICKER.switchTopSquareSize + CLICKER.baseEdgeGap * 2,
);

  const capBaseColor = imageCanvas ? estimateCapBaseColor(imageCanvas) : new THREE.Color(0x2563eb);
  const topCap = makeTopCapPreview(capPoints, capBaseColor);
  topCap.userData.export3mf = true;

  const colorSticker = imageCanvas
    ? await makeColorStickerPreview(capPoints, imageCanvas, outline)
    : new THREE.Group();
  colorSticker.userData.export3mf = true;

  const bottomBase = makeBottomBasePreview(basePoints, capPoints);
  bottomBase.userData.export3mf = true;

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

async function makeColorStickerPreview(
  capPoints: Point[],
  imageCanvas: HTMLCanvasElement,
  sourceOutline: Point[],
) {
  const group = new THREE.Group();
  const trace = await traceCanvasToSvg(imageCanvas);
  const traceScale = trace.traceScale ?? 1;
  const loader = new SVGLoader();
  const parsed = loader.parse(trace.svg);
  const sourceToCap = makeSourceToCapTransform(sourceOutline);

  const ctx = imageCanvas.getContext('2d', { willReadFrequently: true });
  const imageData = ctx
    ? ctx.getImageData(0, 0, imageCanvas.width, imageCanvas.height)
    : null;
  const background = imageData
    ? estimateCanvasBackground(imageData.data, imageCanvas.width, imageCanvas.height)
    : { r: 255, g: 255, b: 255 };

  const topSkin = extrudeShape(makeShape(capPoints), 0.18, new THREE.MeshStandardMaterial({
    color: estimateCapBaseColor(imageCanvas),
    roughness: 0.5,
    metalness: 0.02,
    side: THREE.DoubleSide,
  }));
  topSkin.position.z = -0.02;
  topSkin.userData.skip3mf = true;
  group.add(topSkin);

  for (const svgPath of parsed.paths as Array<any>) {
    const color = svgPath.color instanceof THREE.Color
      ? svgPath.color.clone()
      : new THREE.Color(0x111111);

    const rgb = {
      r: Math.round(color.r * 255),
      g: Math.round(color.g * 255),
      b: Math.round(color.b * 255),
    };

    const style = svgPath.userData?.style ?? {};
    const fill = String(style.fill ?? '').toLowerCase();
    const opacity = Number(style.fillOpacity ?? style.opacity ?? 1);

    if (fill === 'none' || opacity <= 0.05) continue;
    if (colorDistance(rgb, background) < 18) continue;

    const shapes = SVGLoader.createShapes(svgPath);

    for (const shape of shapes) {
      const rawPoints = shape.getPoints(96);

      if (rawPoints.length < 3 || Math.abs(shapePixelArea(rawPoints)) < 45) {
        continue;
      }

      const rawCenter = averagePoint(rawPoints.map((p) => ({
        x: p.x / traceScale,
        y: p.y / traceScale,
      })));
      const capCenter = sourceToCap.point(rawCenter);

      if (!pointInPolygon(capCenter, capPoints)) continue;

      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: colorLayerHeight(rgb),
        steps: 1,
        curveSegments: 96,
        bevelEnabled: true,
        bevelThickness: 0.018,
        bevelSize: 0.018,
        bevelSegments: 4,
      });

      geometry.scale(1 / traceScale, 1 / traceScale, 1);
      sourceToCap.applyToGeometry(geometry);
      geometry.translate(0, 0, 0.16);
      geometry.computeVertexNormals();

      const material = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.5,
        metalness: 0.02,
        side: THREE.DoubleSide,
      });

      const colorMesh = new THREE.Mesh(geometry, material);
      colorMesh.userData.artworkColor = `#${color.getHexString().toUpperCase()}`;
      group.add(colorMesh);
    }
  }

  return group;
}

function colorLayerHeight(color: { r: number; g: number; b: number }) {
  const brightness = (color.r + color.g + color.b) / 3;

  // Dark outlines should stand proud, lighter fills can stay lower.
  if (brightness < 80) return 0.85;
  if (brightness < 145) return 0.68;

  return 0.52;
}

function makeSourceToCapTransform(sourceOutline: Point[]) {
  const minX = Math.min(...sourceOutline.map((p) => p.x));
  const maxX = Math.max(...sourceOutline.map((p) => p.x));
  const minY = Math.min(...sourceOutline.map((p) => p.y));
  const maxY = Math.max(...sourceOutline.map((p) => p.y));

  const width = maxX - minX;
  const height = maxY - minY;
  const shortSide = Math.max(0.0001, Math.min(width, height));
  const scale = (CLICKER.capInnerCavityDiameter + CLICKER.capEdgeGap * 2) / shortSide;

  const center = weightedVisualCenter(sourceOutline);

  return {
    point(point: Point) {
      return {
        x: (point.x - center.x) * scale,
        y: -(point.y - center.y) * scale,
      };
    },

    applyToGeometry(geometry: THREE.BufferGeometry) {
      geometry.translate(-center.x, -center.y, 0);
      geometry.scale(scale, -scale, 1);
    },
  };
}

function makeTopCapPreview(capPoints: Point[], capColor: THREE.ColorRepresentation) {
  const group = new THREE.Group();
  const capMaterial = makeMaterial(capColor);

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

  const capShortSide = CLICKER.capInnerCavityDiameter + CLICKER.capEdgeGap * 2;
const indentScale =
  (capShortSide + CLICKER.baseTopIndentClearance) / capShortSide;

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

function makeCircleShape(radius: number, segments = 192) {
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

function makeMaterial(color: THREE.ColorRepresentation) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.55,
    metalness: 0.03,
    side: THREE.DoubleSide,
  });
}

function estimateCapBaseColor(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  if (!ctx) {
    return new THREE.Color(0x9ca3af);
  }

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const background = estimateCanvasBackground(data, canvas.width, canvas.height);

  const colors: Array<{ r: number; g: number; b: number }> = [];

  for (let i = 0; i < data.length; i += 4) {
    const color = {
      r: data[i],
      g: data[i + 1],
      b: data[i + 2],
    };

    if (data[i + 3] < 40) continue;
    if (colorDistance(color, background) < 30) continue;

    colors.push(color);
  }

  if (colors.length === 0) {
    return new THREE.Color(0x9ca3af);
  }

  colors.sort((a, b) => brightness(b) - brightness(a));
  const color = colors[Math.floor(colors.length * 0.35)];

  return new THREE.Color(color.r / 255, color.g / 255, color.b / 255);
}

function brightness(color: { r: number; g: number; b: number }) {
  return color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
}

function shapePixelArea(points: Array<{ x: number; y: number }>) {
  let area = 0;

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];

    area += a.x * b.y - b.x * a.y;
  }

  return area / 2;
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


export async function exportCurrentPreviewAs3MF() {
  if (!modelGroup || modelGroup.children.length < 3) {
    alert('Generate a clicker preview first.');
    return;
  }

  modelGroup.updateWorldMatrix(true, true);

  const [topCapGroup, artworkGroup, bottomBaseGroup] = modelGroup.children;
  const artworkObjects = makeArtworkColorObjects(artworkGroup, 3);

  const exportObjects = [
    make3mfObjectFromGroup(topCapGroup, 2, 'Top cap', '#A8A29E', 0),
    ...artworkObjects,
    make3mfObjectFromGroup(bottomBaseGroup, 1000, 'Bottom base', '#9CA3AF', artworkObjects.length + 1),
  ].filter((object): object is ThreeMfObject => object !== null);

  if (exportObjects.length === 0) {
    alert('No printable objects found.');
    return;
  }

  const artworkMaterials = artworkObjects.map((object) => object.color);
  const materialColors = ['#A8A29E', ...artworkMaterials, '#9CA3AF'];

  const modelConfigXml = makeSlic3rModelConfig(exportObjects);

  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">
  <metadata name="Application">PrusaSlicer</metadata>
  <metadata name="slic3rpe:Version3mf">1</metadata>
  <resources>
    <basematerials id="1">
      ${materialColors.map((color, index) => `<base name="Material ${index + 1}" displaycolor="${color}" />`).join('\n')}
    </basematerials>
    ${exportObjects.map((object) => object.xml).join('\n')}
  </resources>
  <build>
    ${exportObjects.map((object) => `<item objectid="${object.id}" />`).join('\n')}
  </build>
</model>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>`;

  const relationshipsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypesXml);
  zip.folder('_rels')?.file('.rels', relationshipsXml);
  zip.folder('3D')?.file('3dmodel.model', modelXml);
  zip.folder('Metadata')?.file('Slic3r_PE_model.config', modelConfigXml);

  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, 'image-clicker-multicolor.3mf');
}

type ThreeMfObject = {
  id: number;
  xml: string;
  color: string;
  materialIndex: number;
  triangleCount: number;
};

function makeArtworkColorObjects(group: THREE.Object3D, firstObjectId: number) {
  const byColor = new Map<string, THREE.Mesh[]>();

  group.updateWorldMatrix(true, true);

  group.traverse((child) => {
    if (
      !(child instanceof THREE.Mesh) ||
      !(child.geometry instanceof THREE.BufferGeometry) ||
      child.userData.skip3mf ||
      !isPrintableArtworkMesh(child)
    ) {
      return;
    }

    const color = typeof child.userData.artworkColor === 'string'
      ? child.userData.artworkColor
      : getMeshDisplayColor(child);

    const meshes = byColor.get(color) ?? [];
    meshes.push(child);
    byColor.set(color, meshes);
  });

  const objects: ThreeMfObject[] = [];
  let objectId = firstObjectId;
  let materialIndex = 1;

  for (const [color, meshes] of byColor) {
    const object = make3mfObjectFromMeshes(
      meshes,
      objectId,
      `Artwork color ${materialIndex}`,
      color,
      materialIndex,
    );

    if (object) {
      objects.push(object);
      objectId++;
      materialIndex++;
    }
  }

  return objects;
}

function isPrintableArtworkMesh(mesh: THREE.Mesh) {
  const box = new THREE.Box3().setFromObject(mesh);
  const size = new THREE.Vector3();

  box.getSize(size);

  const width = Math.max(size.x, size.y);
  const height = Math.min(size.x, size.y);

  // Tiny traced highlights often create bad slicer parts. Keep only printable details.
  if (width < 0.8 || height < 0.25) return false;

  return true;
}

function make3mfObjectFromGroup(
  group: THREE.Object3D,
  objectId: number,
  name: string,
  color: string,
  materialIndex: number,
): ThreeMfObject | null {
  const meshes: THREE.Mesh[] = [];

  group.updateWorldMatrix(true, true);

  group.traverse((child) => {
    if (
      child instanceof THREE.Mesh &&
      child.geometry instanceof THREE.BufferGeometry &&
      !child.userData.skip3mf
    ) {
      meshes.push(child);
    }
  });

  return make3mfObjectFromMeshes(meshes, objectId, name, color, materialIndex);
}

function make3mfObjectFromMeshes(
  meshes: THREE.Mesh[],
  objectId: number,
  name: string,
  color: string,
  materialIndex: number,
): ThreeMfObject | null {
  const positions: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;

  for (const mesh of meshes) {
    const rawGeometry = mesh.geometry.clone();
    rawGeometry.applyMatrix4(mesh.matrixWorld);
    rawGeometry.deleteAttribute('normal');
    rawGeometry.deleteAttribute('uv');

    const geometry = mergeVertices(rawGeometry, 0.00001);
    rawGeometry.dispose();

    const position = geometry.getAttribute('position');

    if (!position || position.count < 3) {
      geometry.dispose();
      continue;
    }

    for (let i = 0; i < position.count; i++) {
      positions.push(position.getX(i), position.getY(i), position.getZ(i));
    }

    const index = geometry.getIndex();

    if (index) {
      for (let i = 0; i < index.count; i++) {
        indices.push(index.getX(i) + vertexOffset);
      }
    } else {
      for (let i = 0; i < position.count; i++) {
        indices.push(i + vertexOffset);
      }
    }

    vertexOffset += position.count;
    geometry.dispose();
  }

  if (positions.length === 0 || indices.length === 0) {
    return null;
  }

  const vertices: string[] = [];
  const triangles: string[] = [];

  for (let i = 0; i < positions.length; i += 3) {
    vertices.push(
      `<vertex x="${format3mfNumber(positions[i])}" y="${format3mfNumber(positions[i + 1])}" z="${format3mfNumber(positions[i + 2])}" />`,
    );
  }

  for (let i = 0; i < indices.length; i += 3) {
    triangles.push(
      `<triangle v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}" />`,
    );
  }

  return {
    id: objectId,
    color,
    materialIndex,
    triangleCount: triangles.length,
    xml: `
      <object id="${objectId}" type="model" name="${escapeXml(name)}" pid="1" pindex="${materialIndex}">
        <metadata name="Name">${escapeXml(name)}</metadata>
        <mesh>
          <vertices>
            ${vertices.join('\n')}
          </vertices>
          <triangles>
            ${triangles.join('\n')}
          </triangles>
        </mesh>
      </object>
    `,
  };
}

function getMeshDisplayColor(mesh: THREE.Mesh) {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const color = material && 'color' in material && material.color instanceof THREE.Color
    ? material.color
    : new THREE.Color(0x999999);

  return `#${color.getHexString().toUpperCase()}`;
}

function makeSlic3rModelConfig(objects: ThreeMfObject[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  ${objects.map((object) => {
    const extruder = object.materialIndex + 1;
    const lastTriangle = Math.max(0, object.triangleCount - 1);

    return `<object id="${object.id}">
    <metadata type="object" key="name" value="Object ${object.id}" />
    <volume firstid="0" lastid="${lastTriangle}">
      <metadata type="volume" key="volume_type" value="ModelPart" />
      <metadata type="volume" key="extruder" value="${extruder}" />
    </volume>
  </object>`;
  }).join('\n')}
</config>`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(url);
}

function format3mfNumber(value: number) {
  return Number.isFinite(value) ? value.toFixed(5).replace(/\.?0+$/, '') : '0';
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}