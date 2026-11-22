import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { validateManifest, loadArtifact, checkDevice, flashArtifact } from './core.mjs';

const data = new TextEncoder().encode('test image');
const part = { name: '0-app.bin', offset: 0x10000, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
const variant = () => ({ revision: 'esp32lilygo', target: 'esp32', chip: 'ESP32', version: 'v1',
  flash_size: '2MB', flash_size_policy: 'minimum', flash_settings: { flash_size: '2MB', flash_mode: 'dio', flash_freq: '40m' },
  esptool_args: { chip: 'esp32' }, parts: [{ ...part }] });
const manifest = () => ({ schema_version: 1, variants: { esp32lilygo: variant() } });

test('loads export layout and validates SHA-256', async () => {
  const urls = [];
  const result = await loadArtifact(new URL('https://example.test/firmware/'), async url => {
    urls.push(url.href);
    return url.pathname.endsWith('manifest.json') ? { ok: true, json: async () => manifest() } :
      { ok: true, arrayBuffer: async () => data.buffer };
  }, webcrypto);
  assert.deepEqual(urls, ['https://example.test/firmware/manifest.json', 'https://example.test/firmware/esp32lilygo/0-app.bin']);
  assert.equal(result.images[0].address, 0x10000);
  await assert.rejects(loadArtifact(new URL('https://example.test/'), async url =>
    url.pathname.endsWith('manifest.json') ? { ok: true, json: async () => manifest() } :
      { ok: true, arrayBuffer: async () => new Uint8Array(data.length).buffer }, webcrypto), /SHA-256 mismatch/);
});

test('rejects invalid variants, paths, sector overlap, and settings', () => {
  const bad = manifest(); delete bad.variants.esp32lilygo;
  assert.throws(() => validateManifest(bad), /esp32lilygo/);
  for (const change of [
    v => { v.target = 'esp32s3'; }, v => { v.esptool_args.stub = false; },
    v => { v.parts[0].name = '../bad.bin'; }, v => { v.parts[0].offset = 0x10001; },
    v => { v.parts[0].offset = 0x200000; }, v => { v.flash_settings.flash_size = '4MB'; },
    v => { v.parts.push({ ...part, name: '1.bin', offset: 0x10000 }); },
    v => { v.parts[0].size = 4097; v.parts.push({ ...part, name: '1.bin', offset: 0x11000 }); },
  ]) {
    const m = manifest(); change(m.variants.esp32lilygo);
    assert.throws(() => validateManifest(m));
  }
});

test('checks chip and exact/minimum flash policy', () => {
  const v = variant();
  checkDevice(v, 'ESP32', '4MB');
  assert.throws(() => checkDevice(v, 'ESP32-S3', '4MB'), /Wrong chip/);
  assert.throws(() => checkDevice(v, 'ESP32', undefined), /incompatible/);
  assert.throws(() => checkDevice(v, 'ESP32', '1MB'), /incompatible/);
  v.flash_size_policy = 'exact';
  assert.throws(() => checkDevice(v, 'ESP32', '4MB'), /incompatible/);
  checkDevice(v, 'ESP32', '2MB');
});

test('flashes manifest offsets and settings only after checks', async () => {
  const calls = [];
  const loader = { chip: { CHIP_NAME: 'ESP32' }, main: async () => calls.push('connect'),
    detectFlashSize: async () => '4MB', writeFlash: async opts => calls.push(opts) };
  const artifact = { variant: variant(), images: [{ data, address: part.offset }] };
  await flashArtifact(loader, artifact, () => {});
  assert.equal(calls[1].fileArray[0].address, 0x10000);
  assert.equal(calls[1].flashMode, 'dio'); assert.equal(calls[1].flashFreq, '40m');
  assert.equal(calls[1].flashSize, '2MB'); assert.equal(calls[1].eraseAll, false);
  calls.length = 0; loader.chip.CHIP_NAME = 'ESP32-S3';
  await assert.rejects(flashArtifact(loader, artifact, () => {}), /Wrong chip/);
  assert.deepEqual(calls, ['connect']);
  loader.chip.CHIP_NAME = 'ESP32'; loader.secureDownloadMode = true;
  await assert.rejects(flashArtifact(loader, artifact, () => {}), /Secure download/);
});
