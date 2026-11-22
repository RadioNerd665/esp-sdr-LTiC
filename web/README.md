# LilyGO T-Internet-COM web flasher

This experimental standalone static site flashes only the `esp32lilygo` variant for the original ESP32. Flashing and board functionality require validation on real T-Internet-COM hardware. It requires a recent Chromium-based desktop browser with Web Serial and JSON module import attributes (Chrome/Edge 123 or later), a USB-to-serial connection and a secure context: HTTPS, or `http://localhost`. No firmware or remote service is bundled. Install the pinned dependencies with `npm ci --prefix web --ignore-scripts`, then run `python3 -m http.server 8000 --directory web` from the repository root and open <http://localhost:8000/>. No bundling step is required. Publish the contents of `web/`, **including `node_modules/`**, together with the artifact directory below on any HTTPS static host. Serve `.js`/`.mjs` as JavaScript and `.json` as JSON. Do not open the page via `file://`.

## Artifact contract

Place a complete export or collected artifact under `web/firmware/`:

```text
web/firmware/manifest.json
web/firmware/esp32lilygo/<part.name>
```

The manifest is schema 1 from `tools/export_web_firmware.py` (or `tools/collect_firmware.py`). It must contain variant `esp32lilygo`, with `target`/`esptool_args.chip` = `esp32` and `chip` = `ESP32`. With the catalog-pinned ESP-IDF environment activated, build the catalog profile and copy its export:

```sh
python3 tools/build_firmware.py --profile esp32lilygo --version VERSION --output artifacts
cp -r artifacts/esp32lilygo web/firmware
```

The catalog specifies a minimum flash size; the exporter refuses an embedded profile mismatch. The installer uses each part's exact numeric offset, size and SHA-256 and the exported `flash_mode`, `flash_freq`, and concrete `flash_size`; it refuses malformed, overlapping sector or out-of-range parts, wrong chips, and unknown or incompatible detected flash sizes. SHA-256 checks ensure the downloaded images match the manifest, not that the manifest is authentic; publish the manifest and binaries together over HTTPS from a trusted source. The tool does not verify flash readback. It writes only the image sectors but these sectors are erased; backups are the user's responsibility. Devices using Secure Boot or flash encryption are unsupported; do not use this installer on them. If flashing is interrupted, reconnect and retry. Automatic reset may require manually holding BOOT or pressing RESET.

## Third-party code

The site uses `esptool-js` 0.7.1 (Apache-2.0), Espressif's npm-distributed readable `lib/` files, with `pako` 2.1.0 (MIT AND Zlib), its readable browser ESM distribution, and an equivalent browser adapter for `atob-lite` 2.0.0 (MIT). Their licenses are included in their installed packages in `node_modules/` and must be retained when deploying. Source: https://github.com/espressif/esptool-js, https://github.com/nodeca/pako and https://github.com/beatgammit/atob. `package-lock.json` pins package integrity; no CDN is required. The esptool stub data is distributed by esptool-js. Dependency advisory checks were run for all three pinned versions before integration.

Run the dependency-free tests with `npm test --prefix web`. Actual flashing requires a compatible board; these tests use a mocked serial loader.
