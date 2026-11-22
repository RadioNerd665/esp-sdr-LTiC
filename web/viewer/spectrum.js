(function (root) {
  "use strict";
  const rates = {0: 80000000, 1: 40000000, 6: 16000000};

  function settings(frequency, rate, bins, interval) {
    const f = Number(frequency), r = Number(rate), b = Number(bins), i = Number(interval);
    if (!Number.isInteger(f) || f < 100 || f > 6000 ||
        !Object.hasOwn(rates, r) || ![256, 512, 1024, 2048].includes(b) ||
        !Number.isInteger(i) || i < 500 || i > 5000 || i % 100 !== 0) {
      throw new Error("Choose a whole MHz from 100–6000, a supported rate and FFT size, and a 500–5000 ms pause in 100 ms steps.");
    }
    return {frequency: f, rate: r, bins: b, interval: i};
  }

  function decode(data, config) {
    if (!data || typeof data !== "object" || data.frequency_mhz !== config.frequency ||
        data.sample_rate_hz !== rates[config.rate] || data.bins !== config.bins ||
        !Array.isArray(data.power) || data.power.length !== config.bins ||
        !data.power.every(v => Number.isInteger(v) && v >= 0 && v <= 255) ||
        !Number.isInteger(data.gain) || data.gain < 0 || data.gain > 255 ||
        !Number.isInteger(data.flags) || data.flags < 0 || data.flags > 255) {
      throw new Error("Invalid or mismatched snapshot response; check firmware compatibility.");
    }
    const half = config.bins / 2;
    // Raw hardware Q is inverted: increasing RF maps to decreasing FFT bin.
    const power = Array.from({length: config.bins},
      (_, index) => data.power[(half - index + config.bins) % config.bins]);
    return {power,
      gain: data.gain, flags: data.flags, sampleRate: data.sample_rate_hz};
  }

  const api = {settings, decode, rates};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SDRSpectrum = api;
})(globalThis);
