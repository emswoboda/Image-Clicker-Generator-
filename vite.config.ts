import { defineConfig, type Plugin } from 'vite';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const potrace = require('potrace') as any;

type TraceMask = {
  color: string;
  image: string;
};

function traceMask(file: string, color: string) {
  return new Promise<string>((resolve, reject) => {
    potrace.trace(
      file,
      {
        color,
        background: 'transparent',
        threshold: 128,
        turdSize: 4,
        alphaMax: 1.35,
        optCurve: true,
        optTolerance: 0.16,
        blackOnWhite: true,
      },
      (error: Error | null, svg: string) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(svg);
      },
    );
  });
}

function extractSvgBody(svg: string) {
  return svg
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/g, '')
    .replace(/<svg[^>]*>/i, '')
    .replace(/<\/svg>/i, '')
    .trim();
}

function smoothPotraceApi(): Plugin {
  return {
    name: 'smooth-potrace-api',
    configureServer(server) {
      server.middlewares.use('/api/potrace', (req, res, next) => {
        if (req.method !== 'POST') {
          next();
          return;
        }

        const chunks: Buffer[] = [];

        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

        req.on('end', async () => {
          let tempDir = '';

          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const width = Math.max(1, Number(body.width ?? 1));
            const height = Math.max(1, Number(body.height ?? 1));
            const masks = Array.isArray(body.masks) ? body.masks as TraceMask[] : [];

            tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clicker-potrace-'));

            const parts: string[] = [];

            for (let index = 0; index < masks.length; index++) {
              const mask = masks[index];
              const base64 = String(mask.image ?? '').replace(/^data:image\/png;base64,/, '');
              const file = path.join(tempDir, `mask-${index}.png`);

              await fs.writeFile(file, Buffer.from(base64, 'base64'));

              const svg = await traceMask(file, mask.color);
              parts.push(extractSvgBody(svg));
            }

            await fs.rm(tempDir, { recursive: true, force: true });

            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('\n')}</svg>`;

            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ svg }));
          } catch (error) {
            if (tempDir) {
              try {
                await fs.rm(tempDir, { recursive: true, force: true });
              } catch {}
            }

            res.statusCode = 500;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [smoothPotraceApi()],
});
