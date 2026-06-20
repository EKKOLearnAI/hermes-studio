# ESP32-C3 Wi-Fi Setup Firmware

PlatformIO source project for the ESP32-C3 Wi-Fi setup firmware.

This firmware is intentionally minimal: it manages Wi-Fi provisioning, keeps the
I2C OLED status/animation UI, and shows a device tab that can discover Hermes Web
UI and desktop endpoints on the LAN. Voice, pairing, relay, webhook, OTA, and
audio codec flows are currently removed.

## Hardware

- Chip: ESP32-C3, 4MB flash
- I2C OLED: SDA GPIO3, SCL GPIO4, address `0x3C`

## Commands

```bash
cd packages/esp32-c3
pio run
pio run -t upload
pio device monitor
```

The current macOS serial port is configured as:

```text
/dev/cu.usbmodem11101
```

If upload fails, hold `BOOT`, start upload, then release it after flashing
begins.

## First Boot

1. The device tries the saved Wi-Fi credentials first.
2. If Wi-Fi is missing or connection fails, it starts the open `HStudio-WIFI`
   setup hotspot.
3. Join `HStudio-WIFI` and open `http://192.168.4.1/`.
4. Select the target Wi-Fi SSID from the scanned list, or enter it manually,
   then enter the password and save.
5. The setup page connects once, shows the router-assigned IP, opens that IP,
   and the device restarts into normal Wi-Fi station mode.

Use `/clear` from the device page to clear saved Wi-Fi and return to setup mode.

## LAN Device Discovery

After Wi-Fi is connected, open the device page and use the `设备` tab. The
firmware sends a UDP `hermes.discover` probe to the fixed Hermes discovery port
`48640`. Hermes Web UI and desktop responders return `hermes.announce` payloads
with their `endpoint_kind` (`web`, `desktop`, or `custom`) and HTTP port, so Web
and desktop endpoints are listed separately.

The device tab also includes an MCU login flow. Select a discovered or manually
added endpoint, enter the Hermes account and password, and the firmware posts to
`/api/auth/mcu-login`. On success it shows the returned profile list, stores the
selected profile locally, and connects to the selected Web UI `/global-agent`
Socket.IO namespace with the returned login token.
