import ImageTracer from 'imagetracerjs';

export type ArtworkBox = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
};

export type TracedSvg = {
  svg: string;
  width: number;
  height: number;
  artworkBox: ArtworkBox;
  traceScale?: number;
};

type RGB = {
  r: number;
  g: number;
  b: number;
};

type ColorSample = RGB & {
  x: number;
  y: number;
};

export async function traceCanvasToSvg(canvas: HTMLCanvasElement, requestedColorCount = 7): Promise<TracedSvg> {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  if (!ctx) {
    return emptySvg(canvas);
  }

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const cleaned = removeEdgeBackground(imageData);

  try {
    const masks = buildColorMasks(cleaned.imageData, requestedColorCount);

    const response = await fetch('/api/potrace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        width: canvas.width,
        height: canvas.height,
        masks,
      }),
    });

    if (!response.ok) {
      throw new Error(`Potrace failed: ${response.status}`);
    }

    const result = await response.json();

    return {
      svg: String(result.svg),
      width: canvas.width,
      height: canvas.height,
      artworkBox: cleaned.artworkBox,
      traceScale: 1,
    };
  } catch (error) {
    console.warn('Potrace color masks failed, falling back to ImageTracer.', error);
    return fallbackTraceCanvasToSvg(canvas, cleaned);
  }
}

function buildColorMasks(imageData: ImageData, requestedColorCount: number) {
  const { width, height, data } = imageData;
  const colorCount = Math.max(4, Math.min(16, Math.round(requestedColorCount || 10)));
  const samples: ColorSample[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];

      if (a < 40) continue;

      samples.push({
        r: data[i],
        g: data[i + 1],
        b: data[i + 2],
        x,
        y,
      });
    }
  }

  if (samples.length === 0) {
    return [];
  }

  function maskToDataUrl(imageData: ImageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  if (!ctx) {
    throw new Error('Could not create mask canvas.');
  }

  ctx.putImageData(imageData, 0, 0);

  return canvas.toDataURL('image/png');
}
  const palette = kMeansColors(samples, colorCount, 10);
  const maskImages = palette.map(() => {
    const mask = new ImageData(width, height);

    for (let i = 0; i < mask.data.length; i += 4) {
      mask.data[i] = 255;
      mask.data[i + 1] = 255;
      mask.data[i + 2] = 255;
      mask.data[i + 3] = 255;
    }

    return {
      imageData: mask,
      count: 0,
    };
  });

  for (const sample of samples) {
    const paletteIndex = nearestColorIndex(sample, palette);
    const mask = maskImages[paletteIndex];
    const i = (sample.y * width + sample.x) * 4;

    mask.imageData.data[i] = 0;
    mask.imageData.data[i + 1] = 0;
    mask.imageData.data[i + 2] = 0;
    mask.imageData.data[i + 3] = 255;
    mask.count++;
  }

  return maskImages
    .map((mask, index) => ({
      color: rgbToHex(palette[index]),
      image: maskToDataUrl(mask.imageData),
      count: mask.count,
    }))
    .filter((mask) => mask.count >= 20)
    .sort((a, b) => b.count - a.count)
    .map(({ color, image }) => ({ color, image }));
}


function kMeansColors(samples: ColorSample[], colorCount: number, iterations: number) {
  const palette: RGB[] = [];

  palette.push(samples[0]);

  while (palette.length < colorCount && palette.length < samples.length) {
    let bestSample = samples[0];
    let bestDistance = -1;

    for (const sample of samples) {
      const nearestDistance = Math.min(...palette.map((color) => colorDistance(sample, color)));

      if (nearestDistance > bestDistance) {
        bestDistance = nearestDistance;
        bestSample = sample;
      }
    }

    palette.push({ r: bestSample.r, g: bestSample.g, b: bestSample.b });
  }

  for (let iteration = 0; iteration < iterations; iteration++) {
    const totals = palette.map(() => ({ r: 0, g: 0, b: 0, count: 0 }));

    for (const sample of samples) {
      const index = nearestColorIndex(sample, palette);
      totals[index].r += sample.r;
      totals[index].g += sample.g;
      totals[index].b += sample.b;
      totals[index].count++;
    }

    for (let index = 0; index < palette.length; index++) {
      const total = totals[index];

      if (total.count === 0) continue;

      palette[index] = {
        r: Math.round(total.r / total.count),
        g: Math.round(total.g / total.count),
        b: Math.round(total.b / total.count),
      };
    }
  }

  return palette;
}

function nearestColorIndex(color: RGB, palette: RGB[]) {
  let bestIndex = 0;
  let bestDistance = Infinity;

  for (let index = 0; index < palette.length; index++) {
    const distance = colorDistance(color, palette[index]);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function fallbackTraceCanvasToSvg(
  canvas: HTMLCanvasElement,
  cleaned: { imageData: ImageData; artworkBox: ArtworkBox },
): TracedSvg {
  const svg = ImageTracer.imagedataToSVG(cleaned.imageData, {
    ltres: 0.05,
    qtres: 0.05,
    pathomit: 2,
    rightangleenhance: false,
    colorsampling: 0,
    numberofcolors: 7,
    mincolorratio: 0.01,
    colorquantcycles: 4,
    blurradius: 0,
    blurdelta: 0,
    layering: 0,
    strokewidth: 0,
    linefilter: true,
    scale: 1,
    roundcoords: 4,
    viewbox: true,
    desc: false,
  });

  return {
    svg,
    width: canvas.width,
    height: canvas.height,
    artworkBox: cleaned.artworkBox,
    traceScale: 1,
  };
}

function removeEdgeBackground(imageData: ImageData) {
  const { width, height } = imageData;
  const data = new Uint8ClampedArray(imageData.data);
  const background = estimateBackground(data, width, height);
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];

  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;

    const index = y * width + x;

    if (visited[index]) return;

    const i = index * 4;
    const color = {
      r: data[i],
      g: data[i + 1],
      b: data[i + 2],
    };

    const alpha = data[i + 3];

    if (alpha < 20 || colorDistance(color, background) < 58 || isAlmostWhite(color)) {
      visited[index] = 1;
      queue.push(index);
    }
  };

  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }

  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }

  while (queue.length > 0) {
    const index = queue.shift()!;
    const x = index % width;
    const y = Math.floor(index / width);
    const i = index * 4;

    data[i + 3] = 0;

    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  return {
    imageData: new ImageData(data, width, height),
    artworkBox: findVisibleArtworkBox(data, width, height),
  };
}

function findVisibleArtworkBox(data: Uint8ClampedArray, width: number, height: number): ArtworkBox {
  let minX = width;
  let maxX = 0;
  let minY = height;
  let maxY = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];

      if (alpha < 40) continue;

      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  if (minX > maxX || minY > maxY) {
    return {
      minX: 0,
      maxX: width,
      minY: 0,
      maxY: height,
      width,
      height,
    };
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: Math.max(1, maxX - minX + 1),
    height: Math.max(1, maxY - minY + 1),
  };
}

function estimateBackground(data: Uint8ClampedArray, width: number, height: number): RGB {
  const points = [
    [4, 4],
    [width - 5, 4],
    [4, height - 5],
    [width - 5, height - 5],
    [Math.floor(width / 2), 4],
    [Math.floor(width / 2), height - 5],
    [4, Math.floor(height / 2)],
    [width - 5, Math.floor(height / 2)],
  ];

  const colors = points.map(([x, y]) => {
    const i = (Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))) * 4;

    return {
      r: data[i],
      g: data[i + 1],
      b: data[i + 2],
    };
  });

  return {
    r: Math.round(colors.reduce((sum, color) => sum + color.r, 0) / colors.length),
    g: Math.round(colors.reduce((sum, color) => sum + color.g, 0) / colors.length),
    b: Math.round(colors.reduce((sum, color) => sum + color.b, 0) / colors.length),
  };
}

function emptySvg(canvas: HTMLCanvasElement): TracedSvg {
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}"></svg>`,
    width: canvas.width,
    height: canvas.height,
    artworkBox: {
      minX: 0,
      maxX: canvas.width,
      minY: 0,
      maxY: canvas.height,
      width: canvas.width,
      height: canvas.height,
    },
    traceScale: 1,
  };
}

function rgbToHex(color: RGB) {
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function toHex(value: number) {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0').toUpperCase();
}

function isAlmostWhite(color: RGB) {
  return color.r > 238 && color.g > 238 && color.b > 238;
}

function colorDistance(a: RGB, b: RGB) {
  return Math.sqrt(
    (a.r - b.r) ** 2 +
    (a.g - b.g) ** 2 +
    (a.b - b.b) ** 2,
  );
}
