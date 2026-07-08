import './style.css';

type Point = {
  x: number;
  y: number;
};

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('App container not found');
}

app.innerHTML = `
  <main class="page">
    <section class="panel">
      <h1>Image Clicker Generator</h1>
      <p class="subtitle">
        Upload an image, trace the outside shape, and preview the clicker outline.
      </p>

      <div class="layout">
        <aside class="controls">
          <label class="control">
            <span>Upload image</span>
            <input id="imageInput" type="file" accept="image/*" />
          </label>

          <label class="control">
            <span>Background sensitivity: <b id="thresholdLabel">35</b></span>
            <input id="thresholdSlider" type="range" min="5" max="160" value="35" />
          </label>

          <label class="control">
            <span>Merge nearby pieces: <b id="mergeLabel">12</b></span>
            <input id="mergeSlider" type="range" min="0" max="35" value="12" />
          </label>

          <label class="control">
            <span>Outline smoothing: <b id="smoothLabel">4</b></span>
            <input id="smoothSlider" type="range" min="0" max="20" value="4" />
          </label>

          <button id="traceButton">Trace / Update Preview</button>

          <p id="statusText" class="status">Waiting for image...</p>
        </aside>

        <section class="previewGrid">
          <div class="card">
            <h2>Original</h2>
            <canvas id="sourceCanvas" width="420" height="420"></canvas>
          </div>

          <div class="card">
            <h2>Detected clicker shape</h2>
            <canvas id="outlineCanvas" width="420" height="420"></canvas>
          </div>
        </section>
      </div>
    </section>
  </main>
`;

const imageInput = document.querySelector<HTMLInputElement>('#imageInput')!;
const traceButton = document.querySelector<HTMLButtonElement>('#traceButton')!;

const thresholdSlider = document.querySelector<HTMLInputElement>('#thresholdSlider')!;
const mergeSlider = document.querySelector<HTMLInputElement>('#mergeSlider')!;
const smoothSlider = document.querySelector<HTMLInputElement>('#smoothSlider')!;

const thresholdLabel = document.querySelector<HTMLElement>('#thresholdLabel')!;
const mergeLabel = document.querySelector<HTMLElement>('#mergeLabel')!;
const smoothLabel = document.querySelector<HTMLElement>('#smoothLabel')!;
const statusText = document.querySelector<HTMLElement>('#statusText')!;

const sourceCanvas = document.querySelector<HTMLCanvasElement>('#sourceCanvas')!;
const outlineCanvas = document.querySelector<HTMLCanvasElement>('#outlineCanvas')!;

const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true })!;
const outlineCtx = outlineCanvas.getContext('2d')!;

let loadedImage: HTMLImageElement | null = null;
let currentOutline: Point[] | null = null;

clearCanvases();

imageInput.addEventListener('change', () => {
  const file = imageInput.files?.[0];

  if (!file) {
    return;
  }

  const img = new Image();

  img.onload = () => {
    loadedImage = img;
    traceImage();
  };

  img.src = URL.createObjectURL(file);
});

traceButton.addEventListener('click', traceImage);

thresholdSlider.addEventListener('input', () => {
  thresholdLabel.textContent = thresholdSlider.value;
  traceImage();
});

mergeSlider.addEventListener('input', () => {
  mergeLabel.textContent = mergeSlider.value;
  traceImage();
});

smoothSlider.addEventListener('input', () => {
  smoothLabel.textContent = smoothSlider.value;
  traceImage();
});

function traceImage() {
  if (!loadedImage) {
    return;
  }

  statusText.textContent = 'Tracing image...';

  drawImageToCanvas();

  const mask = createForegroundMask();
  const mergedMask = closeMask(mask, Number(mergeSlider.value));
  const component = getLargestComponent(mergedMask.data, mergedMask.width, mergedMask.height);

  if (!component || component.pixels.length < 50) {
    currentOutline = null;
    clearOutlineCanvas();
    statusText.textContent = 'No clear object found.';
    return;
  }

  const boundary = traceComponentBoundary(component, mergedMask.width);
  const simplified = simplifyRadialOutline(boundary, 240);
  const smoothed = smoothOutline(simplified, Number(smoothSlider.value));

  currentOutline = smoothed;

  drawOutline(smoothed);
  statusText.textContent = `Outline ready: ${smoothed.length} points`;
}

function drawImageToCanvas() {
  if (!loadedImage) return;

  sourceCtx.fillStyle = 'white';
  sourceCtx.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);

  const padding = 32;
  const maxW = sourceCanvas.width - padding * 2;
  const maxH = sourceCanvas.height - padding * 2;

  const scale = Math.min(maxW / loadedImage.width, maxH / loadedImage.height);

  const w = loadedImage.width * scale;
  const h = loadedImage.height * scale;
  const x = (sourceCanvas.width - w) / 2;
  const y = (sourceCanvas.height - h) / 2;

  sourceCtx.drawImage(loadedImage, x, y, w, h);
}

function clearCanvases() {
  sourceCtx.fillStyle = 'white';
  sourceCtx.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);

  clearOutlineCanvas();
}

function clearOutlineCanvas() {
  outlineCtx.fillStyle = 'white';
  outlineCtx.fillRect(0, 0, outlineCanvas.width, outlineCanvas.height);
}

function createForegroundMask() {
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  const imageData = sourceCtx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const threshold = Number(thresholdSlider.value);

  const bg = estimateBackgroundColor(data, width, height);
  const mask = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;

      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      const diff = Math.sqrt(
        (r - bg.r) ** 2 +
        (g - bg.g) ** 2 +
        (b - bg.b) ** 2
      );

      mask[y * width + x] = a >= 20 && diff > threshold ? 1 : 0;
    }
  }

  return { data: mask, width, height };
}

function estimateBackgroundColor(data: Uint8ClampedArray, width: number, height: number) {
  const points = [
    [5, 5],
    [width - 6, 5],
    [5, height - 6],
    [width - 6, height - 6],
    [width / 2, 5],
    [width / 2, height - 6],
    [5, height / 2],
    [width - 6, height / 2],
  ];

  const samples = points.map(([rawX, rawY]) => {
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

function closeMask(mask: { data: Uint8Array; width: number; height: number }, radius: number) {
  if (radius <= 0) return mask;

  const dilated = dilate(mask, radius);
  return erode(dilated, Math.max(1, Math.floor(radius * 0.55)));
}

function dilate(mask: { data: Uint8Array; width: number; height: number }, radius: number) {
  const { data, width, height } = mask;
  const output = new Uint8Array(width * height);
  const r2 = radius * radius;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let found = false;

      for (let dy = -radius; dy <= radius && !found; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > r2) continue;

          const nx = x + dx;
          const ny = y + dy;

          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

          if (data[ny * width + nx]) {
            found = true;
            break;
          }
        }
      }

      output[y * width + x] = found ? 1 : 0;
    }
  }

  return { data: output, width, height };
}

function erode(mask: { data: Uint8Array; width: number; height: number }, radius: number) {
  const { data, width, height } = mask;
  const output = new Uint8Array(width * height);
  const r2 = radius * radius;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let all = true;

      for (let dy = -radius; dy <= radius && all; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > r2) continue;

          const nx = x + dx;
          const ny = y + dy;

          if (nx < 0 || nx >= width || ny < 0 || ny >= height || !data[ny * width + nx]) {
            all = false;
            break;
          }
        }
      }

      output[y * width + x] = all ? 1 : 0;
    }
  }

  return { data: output, width, height };
}

function getLargestComponent(data: Uint8Array, width: number, height: number) {
  const visited = new Uint8Array(width * height);
  let bestPixels: number[] = [];

  const directions = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const startIndex = y * width + x;

      if (visited[startIndex] || data[startIndex] === 0) continue;

      const queue = [startIndex];
      const pixels: number[] = [];

      visited[startIndex] = 1;

      while (queue.length > 0) {
        const index = queue.pop()!;
        pixels.push(index);

        const px = index % width;
        const py = Math.floor(index / width);

        for (const [dx, dy] of directions) {
          const nx = px + dx;
          const ny = py + dy;
          const nIndex = ny * width + nx;

          if (
            nx <= 0 ||
            nx >= width - 1 ||
            ny <= 0 ||
            ny >= height - 1 ||
            visited[nIndex] ||
            data[nIndex] === 0
          ) {
            continue;
          }

          visited[nIndex] = 1;
          queue.push(nIndex);
        }
      }

      if (pixels.length > bestPixels.length) {
        bestPixels = pixels;
      }
    }
  }

  return {
    pixels: bestPixels,
    set: new Set(bestPixels),
  };
}

function traceComponentBoundary(component: { pixels: number[]; set: Set<number> }, width: number) {
  const boundary: Point[] = [];

  for (const index of component.pixels) {
    const x = index % width;
    const y = Math.floor(index / width);

    const hasBackgroundNeighbor =
      !component.set.has(index - 1) ||
      !component.set.has(index + 1) ||
      !component.set.has(index - width) ||
      !component.set.has(index + width);

    if (hasBackgroundNeighbor) {
      boundary.push({ x, y });
    }
  }

  return boundary;
}

function simplifyRadialOutline(points: Point[], binCount: number) {
  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  const bins: Array<(Point & { distance: number }) | null> = new Array(binCount).fill(null);

  for (const p of points) {
    const angle = Math.atan2(p.y - cy, p.x - cx);
    const normalized = angle < 0 ? angle + Math.PI * 2 : angle;
    const bin = Math.floor((normalized / (Math.PI * 2)) * binCount);
    const distance = Math.hypot(p.x - cx, p.y - cy);

    if (!bins[bin] || distance > bins[bin]!.distance) {
      bins[bin] = { x: p.x, y: p.y, distance };
    }
  }

  return bins.filter(Boolean).map((p) => ({ x: p!.x, y: p!.y }));
}

function smoothOutline(points: Point[], amount: number) {
  if (points.length < 3 || amount <= 0) return points;

  let smoothed = points.map((p) => ({ ...p }));

  for (let pass = 0; pass < amount; pass++) {
    smoothed = smoothed.map((point, i) => {
      const prev = smoothed[(i - 1 + smoothed.length) % smoothed.length];
      const next = smoothed[(i + 1) % smoothed.length];

      return {
        x: (prev.x + point.x * 2 + next.x) / 4,
        y: (prev.y + point.y * 2 + next.y) / 4,
      };
    });
  }

  return smoothed;
}

function drawOutline(points: Point[]) {
  clearOutlineCanvas();

  const fitted = fitPointsToCanvas(points, outlineCanvas.width, outlineCanvas.height, 36);

  outlineCtx.beginPath();
  outlineCtx.moveTo(fitted[0].x, fitted[0].y);

  for (let i = 1; i < fitted.length; i++) {
    outlineCtx.lineTo(fitted[i].x, fitted[i].y);
  }

  outlineCtx.closePath();

  outlineCtx.fillStyle = '#2563eb';
  outlineCtx.strokeStyle = '#111827';
  outlineCtx.lineWidth = 5;
  outlineCtx.fill();
  outlineCtx.stroke();
}

function fitPointsToCanvas(points: Point[], width: number, height: number, padding: number) {
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));

  const shapeW = maxX - minX;
  const shapeH = maxY - minY;

  const scale = Math.min(
    (width - padding * 2) / shapeW,
    (height - padding * 2) / shapeH
  );

  return points.map((p) => ({
    x: (p.x - minX - shapeW / 2) * scale + width / 2,
    y: (p.y - minY - shapeH / 2) * scale + height / 2,
  }));
}