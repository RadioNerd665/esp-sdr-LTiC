# T-Internet-COM Ethernet profile (experimental)

`esp32lilygo` is an opt-in profile for the **original ESP32** LilyGO
T-Internet-COM with LAN8720, not other LilyGO Ethernet boards. It retains
UART0 at 2 Mbaud and adds DHCP Ethernet, TCP burst protocol on port 7355,
and an HTTP snapshot viewer on port 80. Generic ESP32 builds are unchanged.
After DHCP, query `NET?` over the normal UART burst connection: it returns
`NET <IPv4> TCP 7355 HTTP 80`, or `NET unavailable`. Alternatively look
up the device in the router's DHCP leases. Open `http://<IPv4>/`.
No unsolicited IP-address text is written into the UART protocol.

The [official LilyGO Ethernet example](https://github.com/Xinyuan-LilyGO/T-Internet-COM/blob/main/example/Arduino/ETHDemo/config.h)
specifies LAN8720 PHY address 0, MDC GPIO23, MDIO GPIO18, PHY power GPIO4,
reset GPIO5 and ESP32-generated RMII clock on GPIO0. RMII data uses the
ESP32's fixed GPIO19/21/22/25/26/27. The
[factory test](https://github.com/Xinyuan-LilyGO/T-Internet-COM/blob/main/example/PlatformIO/FactoryTest/src/main.cpp)
also identifies the SD, LED and modem pins; these board functions and the
Ethernet pins are excluded from `GPIO` control. UART pins and flash pins
remain excluded. GPIO0 is a boot strapping pin; a connected PHY/clock can
affect flashing or boot.

**Hardware validation is required.** Espressif erratum CLK-3.22 warns that ESP32-generated
RMII clock can be unstable when Wi-Fi or Bluetooth is used
([erratum](https://docs.espressif.com/projects/esp-chip-errata/en/latest/esp32/03-errata-description/esp32/clock-rmii-clock-when-using-ethernet-and-wifi.html)).
This receiver starts the Wi-Fi driver and uses its PHY in promiscuous mode
for SDR even though it does not join a Wi-Fi network; therefore the warning
may apply. Do not assume Ethernet remains stable while capturing or tuning.
The experimental profile has not been validated on this board. An external
50 MHz clock on GPIO0 may require board modification and a different firmware
clock configuration; do not connect one while this firmware drives GPIO0.

## Trust and access

The HTTP and TCP services have **no authentication or encryption**. Use
only on a trusted isolated network; do not expose them to the Internet.
Any network client can tune the radio and the TCP protocol includes
GPIO controls. The device serves the viewer and API from the same HTTP origin.
HTTPS websites cannot fetch this HTTP device directly due to mixed-content
rules.

The HTTP API requires `X-ESP-SDR: 1`, including for non-browser clients,
and rejects an `Origin` header unless it equals `http://` plus the request
Host. It does not emit CORS permission headers or authorize preflight.
These browser protections are not authentication: non-browser clients can
spoof headers, and network isolation is still essential.

## HTTP snapshots

`GET /api/spectrum?freq=2412&rate=6&bins=512` with the required header
requests one mean-detector snapshot. `freq` is integer MHz in 100–6000;
`rate` is 0, 1, or 6 (80, 40, or 16 MS/s); `bins` is 256, 512, 1024, or
2048. Successful JSON:

```json
{"frequency_mhz":2412,"sample_rate_hz":16000000,"bins":512,"gain":40,"flags":8,"power":[0,1,2]}
```

The abbreviated `power` array actually contains exactly `bins` unsigned
codes, in natural FFT order, as in the serial `SPC1` frame. Each code has
two units per dB and is uncalibrated. Flag bit 3 indicates snapshot gaps.
Each request is independent; there is no continuous timeline or sequence
number. Invalid arguments produce HTTP 400 `{"error":"invalid_args"}`;
an active UART/TCP lease produces 409 `{"error":"busy"}`; an expired,
failed or unavailable capture produces 503 `{"error":"unavailable"}`.
Missing required header or mismatched Origin produces 403
`{"error":"forbidden"}`. At most one request is queued; requests time out
after three seconds. A queued request that expires is not executed.

## TCP burst protocol

Port 7355 carries the existing [burst protocol](protocol.md) unchanged:
send newline-terminated commands and read the complete text reply and any
binary payload before sending another. `TRANSPORT?` returns
`TRANSPORT TCP 0`; `BAUD` is UART-only. One TCP connection is accepted at a
time. Disconnect releases its lease; a second connection is closed. UART,
TCP and HTTP share the same receiver task and lease: UART/TCP ownership lasts
through a full transaction and until `RELEASE`, disconnect (TCP), or five
seconds of silence. HTTP snapshots run only when no other lease is active
and release ownership immediately. A continuous `SPEC 0` ends on a stop
byte or TCP disconnect; sending another command before the end of a capture
can be interpreted as a stop request.
