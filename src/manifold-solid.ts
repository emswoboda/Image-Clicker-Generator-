import initManifold from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { CLICKER } from './dimensions';
import type { Point } from './geometry';

type ManifoldModule = Awaited<ReturnType<typeof initManifold>>;

let modulePromise: Promise<ManifoldModule> | null = null;

async function getManifoldModule() {
  if (!modulePromise) {
    modulePromise = initManifold({
      locateFile: () => wasmUrl,
    });
  }

  return modulePromise;
}

export type ManifoldMeshData = {
  vertices: number[];
  triangles: number[];
};

export async function buildManifoldTopCapMesh(capPoints: Point[]): Promise<ManifoldMeshData> {
  const module = await getManifoldModule();
  const { CrossSection } = module as any;

  const polygon = cleanPolygon(capPoints).map((point) => [point.x, point.y]);

  const capSection = new CrossSection([polygon], 'NonZero').simplify(0.02);
  const capSolid = capSection.extrude(CLICKER.capTotalHeight, 1);
  const mesh = capSolid.getMesh();

  return manifoldMeshToData(mesh);
}

function manifoldMeshToData(mesh: {
  vertProperties: ArrayLike<number>;
  triVerts: ArrayLike<number>;
  numProp?: number;
}): ManifoldMeshData {
  const vertices: number[] = [];
  const stride = mesh.numProp ?? 3;

  for (let i = 0; i < mesh.vertProperties.length; i += stride) {
    vertices.push(
      mesh.vertProperties[i],
      mesh.vertProperties[i + 1],
      mesh.vertProperties[i + 2],
    );
  }

  return {
    vertices,
    triangles: Array.from(mesh.triVerts),
  };
}

function cleanPolygon(points: Point[]) {
  const output: Point[] = [];

  for (const point of points) {
    const previous = output[output.length - 1];

    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > 0.03) {
      output.push(point);
    }
  }

  if (output.length > 2) {
    const first = output[0];
    const last = output[output.length - 1];

    if (Math.hypot(first.x - last.x, first.y - last.y) < 0.03) {
      output.pop();
    }
  }

  return output;
}
