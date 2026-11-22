"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const context = {module: {exports: {}}};
vm.runInNewContext(fs.readFileSync(require("node:path").join(__dirname, "spectrum.js"), "utf8"), context);
const {settings, decode} = context.module.exports;
const config = settings("2412", "0", "256", "1000");
const data = {frequency_mhz: 2412, sample_rate_hz: 80000000, bins: 256,
  power: Array.from({length: 256}, (_, n) => n), gain: 1, flags: 8};
const rfOrder = Array.from(decode(data, config).power);
assert.deepEqual(rfOrder, Array.from({length: 256}, (_, i) => (128 - i + 256) % 256));
assert.equal(rfOrder[127], 1);   // Positive FFT frequency is below the LO.
assert.equal(rfOrder[129], 255); // Negative FFT frequency is above the LO.
for (const args of [["99", "0", "256", "1000"], ["6001", "0", "256", "1000"],
  ["2412.5", "0", "256", "1000"], ["2412", "2", "256", "1000"],
  ["2412", "0", "4096", "1000"], ["2412", "0", "256", "0"]]) {
  assert.throws(() => settings(...args));
}
for (const bad of [{...data, power: [0]}, {...data, power: data.power.map(() => 256)},
  {...data, frequency_mhz: 2413}, {...data, sample_rate_hz: 40000000},
  {...data, gain: -1}, {...data, flags: null}]) {
  assert.throws(() => decode(bad, config));
}
console.log("Spectrum validation tests passed");
