/**
 * #2687 — the connected app's web app manifest, held to what makes it
 * installable and to the app it describes: its icons exist at the sizes it
 * claims, its shortcuts open real pages, the page links it, and the service
 * worker's shell list names exactly the files it uses.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHELL_FILES } from './swPolicy';

const appDir = resolve(__dirname, '..', '..');
const publicDir = resolve(appDir, 'public');
const manifest = JSON.parse(readFileSync(resolve(publicDir, 'manifest.webmanifest'), 'utf8')) as {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
  shortcuts: { name: string; url: string; description: string }[];
};
const indexHtml = readFileSync(resolve(appDir, 'index.html'), 'utf8');
const appRoutes = readFileSync(resolve(appDir, 'src', 'App.tsx'), 'utf8');

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): [number, number] {
  const buf = readFileSync(file);
  expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe('manifest.webmanifest', () => {
  it('describes a standalone app over the whole origin', () => {
    expect(manifest.name).toBe('Vaipakam');
    expect(manifest.short_name).toBe('Vaipakam');
    expect(manifest.id).toBe('/');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
  });

  it('carries the same browser colour the page declares', () => {
    const meta = indexHtml.match(/<meta\s+name="theme-color"\s+content="([^"]+)"/);
    expect(meta?.[1]).toBe(manifest.theme_color);
  });

  it('has every icon it names, at the size it claims', () => {
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(pngSize(resolve(publicDir, `.${icon.src}`))).toEqual([w, h]);
    }
  });

  it('offers the icons browsers install from: 192 and 512 any, and a maskable one', () => {
    const any = manifest.icons.filter((i) => i.purpose === 'any').map((i) => i.sizes);
    expect(any).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('points every shortcut at a page the app renders, not a redirect', () => {
    expect(manifest.shortcuts.length).toBeGreaterThan(0);
    for (const s of manifest.shortcuts) {
      const route = new RegExp(`<Route path="${s.url}" element={<(\\w+)`);
      const element = appRoutes.match(route)?.[1];
      expect(element, `${s.name} → ${s.url}`).toBeDefined();
      expect(element).not.toBe('Navigate');
    }
  });

  it('has no purchase shortcut: there is no protocol VPFI purchase surface', () => {
    for (const s of manifest.shortcuts) {
      expect(`${s.name} ${s.url} ${s.description}`).not.toMatch(/\b(buy|purchase)\b/i);
    }
  });
});

describe('index.html', () => {
  it('links the manifest and the Apple touch icon, and both exist', () => {
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    const touch = indexHtml.match(/<link rel="apple-touch-icon" href="([^"]+)"/)?.[1];
    expect(touch).toBeDefined();
    expect(pngSize(resolve(publicDir, `.${touch}`))).toEqual([180, 180]);
  });
});

describe("the service worker's shell list", () => {
  it('names exactly the manifest, its icons, the touch icon and the logo, all present', () => {
    const touch = indexHtml.match(/<link rel="apple-touch-icon" href="([^"]+)"/)?.[1];
    const used = new Set(['/manifest.webmanifest', '/logo.svg', touch, ...manifest.icons.map((i) => i.src)]);
    expect(new Set(SHELL_FILES)).toEqual(used);
    for (const f of SHELL_FILES) expect(existsSync(resolve(publicDir, `.${f}`)), f).toBe(true);
  });
});
