import { ESPLoader, Transport } from './node_modules/esptool-js/lib/index.js';
import { loadArtifact, flashArtifact } from './core.mjs';

const button = document.querySelector('#flash');
const status = document.querySelector('#status');
const artifactLabel = document.querySelector('#artifact');
const progress = document.querySelector('#progress');
const log = document.querySelector('#log');
let artifact;
const append = text => { log.textContent += text; log.scrollTop = log.scrollHeight; };
const terminal = { clean() { log.textContent = ''; }, write: append, writeLine: text => append(`${text}\n`) };

async function prepare() {
  if (!window.isSecureContext || !navigator.serial || !crypto.subtle) {
    throw new Error('Web Serial and Web Crypto require a supported browser on localhost or HTTPS.');
  }
  artifact = await loadArtifact(new URL('firmware/', document.baseURI));
  const v = artifact.variant;
  artifactLabel.textContent = `${v.label || 'LilyGO T-Internet-COM'} · ${v.version || 'unknown version'} · ${v.flash_size} ${v.flash_size_policy || 'exact'} · ${v.parts.length} image(s)`;
  status.textContent = 'Firmware verified and ready. Choose your serial port.';
  button.disabled = false;
}

button.addEventListener('click', async () => {
  button.disabled = true;
  progress.value = 0;
  log.textContent = '';
  let port, transport, written = false;
  try {
    // requestPort must be called directly from the user gesture.
    port = await navigator.serial.requestPort();
    status.textContent = 'Connecting and checking the chip and flash size…';
    transport = new Transport(port, false);
    const loader = new ESPLoader({ transport, baudrate: 115200, terminal });
    await flashArtifact(loader, artifact, (index, done, total) => {
      progress.value = total ? (done / total) * 100 : 0;
      status.textContent = `Writing image ${index + 1} of ${artifact.images.length}: ${Math.round(progress.value)}%`;
    });
    written = true;
    try {
      await loader.after('hard_reset');
      status.textContent = 'Flash complete. The board has been reset.';
    } catch (error) {
      status.textContent = `Flash complete, but reset failed: ${error.message}. Reset the board manually.`;
    }
  } catch (error) {
    status.textContent = error.name === 'NotFoundError' ? 'No serial port selected. Try again.' :
      `Flash failed: ${error.message || error}. Check the log, cable, BOOT mode, and serial permissions.`;
  } finally {
    if (transport && (port.readable || port.writable)) {
      try { await transport.disconnect(); }
      catch (error) { append(`\nCould not close the port: ${error.message}\n`); }
    }
    if (written) progress.value = 100;
    button.disabled = false;
  }
});
prepare().catch(error => { status.textContent = `Not ready: ${error.message}`; artifactLabel.textContent = 'Firmware unavailable.'; });
