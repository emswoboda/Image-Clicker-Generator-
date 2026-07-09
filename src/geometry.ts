export type Point = {
  x: number;
  y: number;
};

export function polygonArea(points: Point[]) {
  let area = 0;

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];

    area += a.x * b.y - b.x * a.y;
  }

  return area / 2;
}

export function polygonCentroid(points: Point[]) {
  let area = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];

    const cross = p1.x * p2.y - p2.x * p1.y;

    area += cross;
    cx += (p1.x + p2.x) * cross;
    cy += (p1.y + p2.y) * cross;
  }

  area *= 0.5;

  if (Math.abs(area) < 0.00001) {
    return bboxCenter(points);
  }

  return {
    x: cx / (6 * area),
    y: cy / (6 * area),
  };
}

export function bboxCenter(points: Point[]) {
  return {
    x: (Math.min(...points.map((p) => p.x)) + Math.max(...points.map((p) => p.x))) / 2,
    y: (Math.min(...points.map((p) => p.y)) + Math.max(...points.map((p) => p.y))) / 2,
  };
}

export function weightedVisualCenter(points: Point[]) {
  const bbox = bboxCenter(points);
  const centroid = polygonCentroid(points);

  return {
    x: bbox.x * 0.35 + centroid.x * 0.65,
    y: bbox.y * 0.35 + centroid.y * 0.65,
  };
}

export function pointsToMillimeters(
  points: Point[],
  targetMaxSize: number,
  minShortSide = 0,
) {
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));

  const w = maxX - minX;
  const h = maxY - minY;

   const shortSide = Math.min(w, h);

  const targetShortSide = minShortSide || targetMaxSize;
  const scale = targetShortSide / shortSide;
  const center = weightedVisualCenter(points);

  const mm = points.map((p) => ({
    x: (p.x - center.x) * scale,
    y: -(p.y - center.y) * scale,
  }));

  if (polygonArea(mm) < 0) {
    mm.reverse();
  }

  return mm;
}