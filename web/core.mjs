export const PROFILE = 'esp32lilygo';
const SECTOR = 4096;

function bytesForSize(value) {
  const match = /^(\d+)(KB|MB)$/.exec(value ?? '');
  if (!match) return NaN;
  return Number(match[1]) * (match[2] === 'MB' ? 1048576 : 1024);
}

export function validateManifest(manifest) {
  if (manifest?.schema_version !== 1 || !manifest.variants?.[PROFILE]) {
    throw new Error(`Manifest must contain schema version 1 and the ${PROFILE} variant.`);
  }
  const v = manifest.variants[PROFILE];
  if (v.target !== 'esp32' || v.chip !== 'ESP32' || v.esptool_args?.chip !== 'esp32' ||
      (v.revision !== undefined && v.revision !== PROFILE)) {
    throw new Error('The LilyGO variant must target ESP32 and match its profile ID.');
  }
  if (v.esptool_args.stub === false) throw new Error('This installer does not support no-stub artifacts.');
  const size = bytesForSize(v.flash_size);
  if (!['1MB', '2MB', '4MB', '8MB', '16MB'].includes(v.flash_size) ||
      !['exact', 'minimum'].includes(v.flash_size_policy ?? 'exact')) {
    throw new Error('Unsupported artifact flash size or size policy.');
  }
  const settings = v.flash_settings;
  if (!settings || settings.flash_size !== v.flash_size ||
      !['qio', 'qout', 'dio', 'dout'].includes(settings.flash_mode) ||
      !['20m', '26m', '40m', '80m'].includes(settings.flash_freq)) {
    throw new Error('Unsupported or inconsistent ESP32 flash settings.');
  }
  if (!Array.isArray(v.parts) || !v.parts.length) throw new Error('The artifact has no flash images.');
  const names = new Set();
  const parts = [...v.parts].sort((a, b) => (a?.offset ?? 0) - (b?.offset ?? 0));
  let end = 0;
  for (const p of parts) {
    if (!p || typeof p.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.bin$/.test(p.name) || names.has(p.name) ||
        !Number.isSafeInteger(p.offset) || p.offset < 0 || p.offset % SECTOR ||
        !Number.isSafeInteger(p.size) || p.size <= 0 || p.offset < end ||
        p.offset + p.size > size || !/^[0-9a-f]{64}$/.test(p.sha256 ?? '')) {
      throw new Error('Invalid, overlapping, unaligned, or out-of-range flash image in manifest.');
    }
    names.add(p.name);
    end = Math.ceil((p.offset + p.size) / SECTOR) * SECTOR;
  }
  return { ...v, parts };
}

export async function loadArtifact(base, fetcher = fetch, cryptoApi = crypto) {
  const manifestUrl = new URL('manifest.json', base);
  const response = await fetcher(manifestUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Cannot load manifest (${response.status}): ${manifestUrl}`);
  const variant = validateManifest(await response.json());
  const images = [];
  for (const part of variant.parts) {
    const url = new URL(`${PROFILE}/${part.name}`, base);
    const response = await fetcher(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Cannot load ${part.name} (HTTP ${response.status}).`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length !== part.size) throw new Error(`Incorrect size for ${part.name}.`);
    const digest = new Uint8Array(await cryptoApi.subtle.digest('SHA-256', data));
    const hash = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== part.sha256) throw new Error(`SHA-256 mismatch for ${part.name}; do not flash this artifact.`);
    images.push({ data, address: part.offset });
  }
  return { variant, images };
}

export function checkDevice(variant, chip, detectedSize) {
  if (chip !== 'ESP32') throw new Error(`Wrong chip: detected ${chip || 'unknown'}, expected ESP32.`);
  const detected = bytesForSize(detectedSize);
  const required = bytesForSize(variant.flash_size);
  if (!Number.isFinite(detected) || (variant.flash_size_policy === 'minimum' ? detected < required : detected !== required)) {
    throw new Error(`Flash size ${detectedSize || 'unknown'} is incompatible with ${variant.flash_size} (${variant.flash_size_policy || 'exact'} required).`);
  }
}

export async function flashArtifact(loader, artifact, progress) {
  await loader.main();
  if (loader.secureDownloadMode) throw new Error('Secure download mode is not supported by this installer.');
  if (loader.chip?.CHIP_NAME !== 'ESP32') checkDevice(artifact.variant, loader.chip?.CHIP_NAME, null);
  checkDevice(artifact.variant, loader.chip?.CHIP_NAME, await loader.detectFlashSize());
  const settings = artifact.variant.flash_settings;
  await loader.writeFlash({
    fileArray: artifact.images,
    flashMode: settings.flash_mode, flashFreq: settings.flash_freq, flashSize: settings.flash_size,
    eraseAll: false, compress: true, reportProgress: progress,
  });
}
