"use strict";
const $ = id => document.getElementById(id);
const form = $("controls"), status = $("status"), start = $("start"), stop = $("stop");
const plot = $("spectrum"), waterfall = $("waterfall");
const plotContext = plot.getContext("2d"), waterContext = waterfall.getContext("2d");
let running = false, generation = 0, controller = null, timer = null;

function message(text, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}
function setRunning(value) {
  running = value;
  for (const element of form.querySelectorAll("input, select")) element.disabled = value;
  start.disabled = value;
  stop.disabled = !value;
}
function resetView() {
  plotContext.clearRect(0, 0, plot.width, plot.height);
  waterContext.fillStyle = "#000";
  waterContext.fillRect(0, 0, waterfall.width, waterfall.height);
}
function draw(snapshot, config) {
  const power = snapshot.power, w = plot.width, h = plot.height;
  plotContext.fillStyle = "#08121a";
  plotContext.fillRect(0, 0, w, h);
  plotContext.strokeStyle = "#30404a";
  for (let i = 0; i <= 4; i++) {
    const y = i * (h - 1) / 4;
    plotContext.beginPath(); plotContext.moveTo(0, y); plotContext.lineTo(w, y); plotContext.stroke();
  }
  plotContext.strokeStyle = "#70dcff";
  plotContext.beginPath();
  power.forEach((value, i) => {
    const x = i * (w - 1) / (power.length - 1), y = (255 - value) * (h - 1) / 255;
    if (i === 0) plotContext.moveTo(x, y); else plotContext.lineTo(x, y);
  });
  plotContext.stroke();
  plotContext.fillStyle = "#e7eef4";
  plotContext.font = "14px sans-serif";
  plotContext.fillText("127.5", 4, 15);
  plotContext.fillText("0 dB (relative)", 4, h - 5);
  const halfMHz = snapshot.sampleRate / 2000000;
  $("low").textContent = `${(config.frequency - halfMHz).toFixed(3)} MHz`;
  $("center").textContent = `${config.frequency.toFixed(3)} MHz`;
  $("high").textContent = `${(config.frequency + halfMHz).toFixed(3)} MHz`;
  waterContext.drawImage(waterfall, 0, 4);
  const row = waterContext.createImageData(waterfall.width, 3);
  for (let x = 0; x < waterfall.width; x++) {
    const v = power[Math.floor(x * power.length / waterfall.width)] / 255;
    for (let y = 0; y < 3; y++) {
      const p = (y * waterfall.width + x) * 4;
      row.data[p] = Math.round(255 * Math.max(0, 2 * v - 1));
      row.data[p + 1] = Math.round(255 * Math.max(0, 1 - Math.abs(2 * v - 1)));
      row.data[p + 2] = Math.round(255 * Math.min(1, 2 * v));
      row.data[p + 3] = 255;
    }
  }
  waterContext.fillStyle = "#000";
  waterContext.fillRect(0, 0, waterfall.width, 4);
  waterContext.putImageData(row, 0, 0);
}
async function acquire(config, token) {
  if (!running || token !== generation) return;
  controller = new AbortController();
  const timeout = setTimeout(() => controller?.abort(), 15000);
  try {
    const query = new URLSearchParams({freq: config.frequency, rate: config.rate, bins: config.bins});
    const response = await fetch(`/api/spectrum?${query}`, {
      headers: {"X-ESP-SDR": "1"}, cache: "no-store", signal: controller.signal
    });
    if (!response.ok) {
      const descriptions = {400: "Device rejected settings", 403: "Request rejected by device or proxy", 409: "Receiver busy", 503: "Device unavailable"};
      throw new Error(`${descriptions[response.status] || "Snapshot request failed"} (HTTP ${response.status}).`);
    }
    const snapshot = SDRSpectrum.decode(await response.json(), config);
    if (!running || token !== generation) return;
    draw(snapshot, config);
    message(`Snapshot received ${new Date().toLocaleTimeString()}; gain metadata ${snapshot.gain}, flags 0x${snapshot.flags.toString(16)}. RF capture gaps are present.`);
  } catch (error) {
    if (!running || token !== generation) return;
    message(error.name === "AbortError" ? "Snapshot timed out; retrying after the pause." : `${error.message || "Network error"} Retrying after the pause.`, true);
  } finally {
    clearTimeout(timeout);
    if (token === generation) {
      controller = null;
      if (running) timer = setTimeout(() => acquire(config, token), config.interval);
    }
  }
}
form.addEventListener("submit", event => {
  event.preventDefault();
  try {
    const config = SDRSpectrum.settings($("frequency").value, $("rate").value, $("bins").value, $("interval").value);
    generation++;
    setRunning(true);
    resetView();
    message("Requesting snapshot…");
    acquire(config, generation);
  } catch (error) { message(error.message, true); }
});
stop.addEventListener("click", () => {
  generation++;
  clearTimeout(timer);
  controller?.abort();
  controller = null;
  setRunning(false);
  message("Stopped. The device may finish an in-flight snapshot before releasing its receiver.");
});
resetView();
