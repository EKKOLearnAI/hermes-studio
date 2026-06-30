#include <Arduino.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <Update.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiUdp.h>
#include <Wire.h>
#include <math.h>
#include <memory>
#include "driver/i2s.h"
#include "esp_system.h"
#include "esp_rom_sys.h"
#include "mbedtls/base64.h"

namespace {
constexpr char kApName[] = "HStudio-WIFI";
constexpr uint32_t kConnectTimeoutMs = 18000;
constexpr uint32_t kMcuOtaFirstCheckMs = 30000;
constexpr uint32_t kMcuOtaIntervalMs = 6UL * 60UL * 60UL * 1000UL;
constexpr uint32_t kMcuOtaRetryMs = 5UL * 60UL * 1000UL;
constexpr bool kForceSetupAp = false;
const IPAddress kApIp(192, 168, 4, 1);
const IPAddress kApGateway(192, 168, 4, 1);
const IPAddress kApSubnet(255, 255, 255, 0);
constexpr char kMissingSttPromptPcmUrl[] =
    "/api/hermes/mcu/audio/missing-stt-24k.s16le.pcm";
constexpr char kNoDevicePromptPcmUrl[] =
    "/api/hermes/mcu/audio/no-device-24k.s16le.pcm";
constexpr int kPinI2cSda = 0;
constexpr int kPinI2cScl = 1;
constexpr int kPinI2sDout = 4;
constexpr int kPinI2sWs = 5;
constexpr int kPinI2sDin = 6;
constexpr int kPinI2sBck = 7;
constexpr int kPinBoot = 9;
constexpr int kPinI2sMck = 8;
constexpr int kPinPaEn = 10;
constexpr uint8_t kEs8311Addr = 0x18;
constexpr uint8_t kDefaultOledAddr = 0x3C;
constexpr uint8_t kAltOledAddr = 0x3D;
constexpr int kOledWidth = 128;
constexpr int kOledHeight = 64;
constexpr uint32_t kOledRefreshIntervalMs = 160;
constexpr uint32_t kProvisionRestartDelayMs = 2500;
constexpr uint32_t kProvisionRedirectDelayMs = 6500;
constexpr int kMaxScannedNetworks = 20;
constexpr uint16_t kLanDiscoveryLocalPort = 48630;
constexpr uint16_t kHermesDiscoveryPort = 48640;
constexpr uint32_t kLanDiscoveryTimeoutMs = 1200;
constexpr uint32_t kLanDiscoveryStaleMs = 30000;
constexpr int kMaxLanDevices = 8;
constexpr int kMaxManualDevices = 8;
constexpr uint32_t kMcuLoginTimeoutMs = 8000;
constexpr uint32_t kMcuSocketReconnectMs = 3000;
constexpr int kMaxProfiles = 8;
constexpr int kMaxMcuAudioQueue = 4;
constexpr uint32_t kMcuInteractionIdleDelayMs = 3500;
constexpr uint32_t kMcuFailureIdleDelayMs = 20000;
constexpr uint32_t kMcuAudioDefaultDurationMs = 1800;
constexpr uint32_t kMcuAudioMaxDurationMs = 9000;
constexpr uint32_t kMcuAudioHttpTimeoutMs = 30000;
constexpr uint32_t kBootDebounceMs = 80;
constexpr uint32_t kBootInputArmDelayMs = 2500;
constexpr uint32_t kBootLongPressMs = 360;
constexpr uint32_t kBootDoubleClickMs = 320;
constexpr uint32_t kWifiDisconnectGraceMs = 8000;
constexpr bool kAutoOtaEnabled = false;
constexpr uint32_t kVoiceRecordMs = 4000;
constexpr uint32_t kVoiceStreamRecordMs = 10000;
constexpr uint32_t kVoiceRecordMinMs = 300;
constexpr uint32_t kVoiceRecordHardTimeoutMs = 12000;
constexpr uint32_t kVoiceVadRmsStart = 190;
constexpr uint32_t kVoiceVadPeakStart = 480;
constexpr uint32_t kVoiceVadActiveThreshold = 260;
constexpr uint32_t kVoiceVadMinActiveSamples = 16;
constexpr int kVoiceInputGainPermille = 2800;
constexpr int kAudioSampleRate = 24000;
constexpr int kMcuAudioDefaultSampleRate = 24000;
constexpr size_t kVoiceRecordMaxFrames = (kAudioSampleRate * kVoiceRecordMs) / 1000UL;
constexpr size_t kVoiceRecordBufferBytes = 44 + kVoiceRecordMaxFrames * sizeof(int16_t);
constexpr uint8_t kDefaultOutputVolumePercent = 70;
constexpr int16_t kVoiceOutputLimit = 24000;
constexpr uint8_t kEs8311DacVolume = 0xC0;
constexpr i2s_port_t kI2sPort = I2S_NUM_0;

Preferences prefs;
WebServer server(80);
WiFiUDP lanUdp;
WiFiClient mcuWsClient;
bool wifiReady = false;
bool setupApMode = false;
bool oledFound = false;
bool oledReady = false;
bool oledDirty = true;
bool lanUdpReady = false;
bool wsReady = false;
bool mcuSocketConnected = false;
bool mcuSocketNamespaceReady = false;
bool restartPending = false;
bool audioBusy = false;
bool paEnabled = false;
bool i2sReady = false;
bool es8311Found = false;
bool es8311Ready = false;
bool bootWasPressed = false;
bool bootLongPressHandled = false;
bool bootClickPending = false;
bool bootSecondClickStarted = false;
bool bootInputArmed = false;
uint32_t lastOledAtMs = 0;
uint32_t restartAtMs = 0;
uint32_t lastLanDiscoveryAtMs = 0;
uint32_t lastMcuLoginAtMs = 0;
uint32_t lastMcuSocketConnectAtMs = 0;
uint32_t lastBootButtonAtMs = 0;
uint32_t bootPressedAtMs = 0;
uint32_t bootClickPendingAtMs = 0;
uint32_t bootReleaseStartedAtMs = 0;
uint32_t audioInterruptPressStartedAtMs = 0;
uint32_t wifiDisconnectedSinceMs = 0;
uint8_t oledProgress = 0;
uint8_t oledAddress = kDefaultOledAddr;
String oledTitle = "BOOT";
String oledHint = "starting";
int lastMcuLoginCode = 0;
String lastMcuLoginDetail;
String selectedProfile;
String pendingProfileDeviceKey;
String activeDeviceKey;
String activeDeviceUrl;
String mcuAuthToken;
String mcuSocketTargetKey;
String mcuInteractionId;
String mcuInteractionStatus = "idle";
String mcuInteractionText;
String mcuToolName;
String mcuToolPreview;
String mcuToolStatus;
String lastAudioDetail = "not started";
uint32_t lastAudioAtMs = 0;
uint8_t oledBuffer[(kOledWidth * kOledHeight) / 8] = {};
int scannedNetworkCount = 0;
String scannedSsids[kMaxScannedNetworks];
int32_t scannedRssi[kMaxScannedNetworks] = {};
bool scannedEncrypted[kMaxScannedNetworks] = {};
String loginProfiles[kMaxProfiles];
int loginProfileCount = 0;
bool mcuInteractionActive = false;
bool mcuAudioPlaying = false;
bool mcuVoiceAfterAudioInterrupt = false;
bool mcuAudioStopOnlyAfterInterrupt = false;
bool mcuSessionClearAfterAudioInterrupt = false;
bool voiceRecordHeardSpeech = false;
uint32_t mcuInteractionUpdatedAtMs = 0;
uint32_t mcuAudioStartedAtMs = 0;
uint32_t mcuAudioDurationMs = 0;
uint32_t nextMcuOtaCheckAtMs = kMcuOtaFirstCheckMs;
uint32_t voiceRecordRms = 0;
uint32_t voiceRecordPeak = 0;
uint32_t voiceRecordActiveSamples = 0;
uint8_t outputVolumePercent = kDefaultOutputVolumePercent;

struct McuAudioSegment {
  String interactionId;
  String segmentId;
  String text;
  String url;
  String mimeType;
  uint8_t channels = 2;
  uint32_t sampleRate = kMcuAudioDefaultSampleRate;
  uint32_t durationMs = 0;
  bool completionManagedByServer = false;
};

McuAudioSegment mcuAudioQueue[kMaxMcuAudioQueue];
int mcuAudioHead = 0;
int mcuAudioCount = 0;
McuAudioSegment mcuCurrentAudio;
uint8_t voiceWavBuffer[kVoiceRecordBufferBytes];

void markMcuInteraction(const String &interactionId, const String &status, const String &text);
void triggerBootVoiceTurn();
bool broadcastMcuInterrupt(const String &interactionId, const String &reason);
void clearMcuAudioQueue();
void finishMcuAudio(bool interrupted);
void clearMcuSessionByButton();
void disconnectMcuSocketClient();
void connectMcuSocketClient();
void mcuSocketLoop();
bool waitForMcuSocketReady(uint32_t timeoutMs);
void enqueueNoDevicePrompt(const String &interactionId);
String activeDeviceEndpoint(const __FlashStringHelper *path);
bool downloadAndApplyMcuFirmware(const String &url, const String &md5, int expectedSize);

enum class McuOtaResult : uint8_t {
  Failed,
  NoUpdate,
  UpdateAvailable,
  Updated,
};

McuOtaResult checkMcuFirmwareUpdate(bool force, bool applyUpdate = true, String *outFirmwareUrl = nullptr, String *outMd5 = nullptr, int *outSize = nullptr);

struct LanDevice {
  String id;
  String name;
  String ip;
  String url;
  String endpointKind;
  String webVersion;
  String agentVersion;
  String profile;
  uint16_t httpPort = 0;
  uint32_t responseMs = 0;
  uint32_t lastSeenMs = 0;
  bool loggedIn = false;
};

LanDevice lanDevices[kMaxLanDevices];
int lanDeviceCount = 0;

enum class OledMode : uint8_t {
  Boot,
  Ready,
  Think,
  Error,
};

OledMode oledMode = OledMode::Boot;

String fitOledText(String value, size_t maxLen) {
  value.trim();
  value.toUpperCase();
  if (value.length() <= maxLen) return value;
  if (maxLen <= 1) return value.substring(0, maxLen);
  return value.substring(0, maxLen - 1) + F(".");
}

uint8_t clampUiValue(uint32_t value, uint8_t ceiling) {
  return value > ceiling ? ceiling : static_cast<uint8_t>(value);
}

bool i2cProbe(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission() == 0;
}

String hexByte(uint8_t value) {
  char buf[5];
  snprintf(buf, sizeof(buf), "0x%02X", value);
  return String(buf);
}

void setPowerAmp(bool enable) {
  pinMode(kPinPaEn, OUTPUT);
  digitalWrite(kPinPaEn, enable ? HIGH : LOW);
  paEnabled = enable;
  delay(35);
}

bool oledCommand(uint8_t command) {
  Wire.beginTransmission(oledAddress);
  Wire.write(0x00);
  Wire.write(command);
  return Wire.endTransmission() == 0;
}

bool oledData(const uint8_t *data, size_t len) {
  size_t offset = 0;
  while (offset < len) {
    size_t chunk = min(static_cast<size_t>(16), len - offset);
    Wire.beginTransmission(oledAddress);
    Wire.write(0x40);
    for (size_t i = 0; i < chunk; ++i) {
      Wire.write(data[offset + i]);
    }
    if (Wire.endTransmission() != 0) return false;
    offset += chunk;
  }
  return true;
}

void oledClearBuffer() {
  memset(oledBuffer, 0, sizeof(oledBuffer));
}

void oledSetPixel(int x, int y, bool on = true) {
  if (x < 0 || x >= kOledWidth || y < 0 || y >= kOledHeight) return;
  uint16_t index = x + (y / 8) * kOledWidth;
  uint8_t mask = 1 << (y & 7);
  if (on) {
    oledBuffer[index] |= mask;
  } else {
    oledBuffer[index] &= ~mask;
  }
}

void oledDrawBox(int x, int y, int w, int h, bool on = true) {
  for (int yy = y; yy < y + h; ++yy) {
    for (int xx = x; xx < x + w; ++xx) {
      oledSetPixel(xx, yy, on);
    }
  }
}

void oledDrawHLine(int x, int y, int w) {
  oledDrawBox(x, y, w, 1);
}

void oledDrawFrame(int x, int y, int w, int h) {
  oledDrawHLine(x, y, w);
  oledDrawHLine(x, y + h - 1, w);
  oledDrawBox(x, y, 1, h);
  oledDrawBox(x + w - 1, y, 1, h);
}

void oledDrawSoftBox(int x, int y, int w, int h, int radius, bool on = true) {
  radius = max(0, min(radius, min(w, h) / 2));
  for (int yy = 0; yy < h; ++yy) {
    int inset = 0;
    if (yy < radius) {
      inset = radius - yy - 1;
    } else if (yy >= h - radius) {
      inset = yy - (h - radius);
    }
    inset = min(inset, w / 2);
    oledDrawBox(x + inset, y + yy, max(0, w - inset * 2), 1, on);
  }
}

const uint8_t *glyph5x7(char c) {
  static const uint8_t blank[5] = {0, 0, 0, 0, 0};
  static const uint8_t dash[5] = {0x08, 0x08, 0x08, 0x08, 0x08};
  static const uint8_t dot[5] = {0x00, 0x60, 0x60, 0x00, 0x00};
  static const uint8_t slash[5] = {0x20, 0x10, 0x08, 0x04, 0x02};
  static const uint8_t colon[5] = {0x00, 0x36, 0x36, 0x00, 0x00};
  static const uint8_t digits[10][5] = {
      {0x3E, 0x51, 0x49, 0x45, 0x3E}, {0x00, 0x42, 0x7F, 0x40, 0x00},
      {0x42, 0x61, 0x51, 0x49, 0x46}, {0x21, 0x41, 0x45, 0x4B, 0x31},
      {0x18, 0x14, 0x12, 0x7F, 0x10}, {0x27, 0x45, 0x45, 0x45, 0x39},
      {0x3C, 0x4A, 0x49, 0x49, 0x30}, {0x01, 0x71, 0x09, 0x05, 0x03},
      {0x36, 0x49, 0x49, 0x49, 0x36}, {0x06, 0x49, 0x49, 0x29, 0x1E},
  };
  static const uint8_t letters[26][5] = {
      {0x7E, 0x11, 0x11, 0x11, 0x7E}, {0x7F, 0x49, 0x49, 0x49, 0x36},
      {0x3E, 0x41, 0x41, 0x41, 0x22}, {0x7F, 0x41, 0x41, 0x22, 0x1C},
      {0x7F, 0x49, 0x49, 0x49, 0x41}, {0x7F, 0x09, 0x09, 0x09, 0x01},
      {0x3E, 0x41, 0x49, 0x49, 0x7A}, {0x7F, 0x08, 0x08, 0x08, 0x7F},
      {0x00, 0x41, 0x7F, 0x41, 0x00}, {0x20, 0x40, 0x41, 0x3F, 0x01},
      {0x7F, 0x08, 0x14, 0x22, 0x41}, {0x7F, 0x40, 0x40, 0x40, 0x40},
      {0x7F, 0x02, 0x0C, 0x02, 0x7F}, {0x7F, 0x04, 0x08, 0x10, 0x7F},
      {0x3E, 0x41, 0x41, 0x41, 0x3E}, {0x7F, 0x09, 0x09, 0x09, 0x06},
      {0x3E, 0x41, 0x51, 0x21, 0x5E}, {0x7F, 0x09, 0x19, 0x29, 0x46},
      {0x46, 0x49, 0x49, 0x49, 0x31}, {0x01, 0x01, 0x7F, 0x01, 0x01},
      {0x3F, 0x40, 0x40, 0x40, 0x3F}, {0x1F, 0x20, 0x40, 0x20, 0x1F},
      {0x3F, 0x40, 0x38, 0x40, 0x3F}, {0x63, 0x14, 0x08, 0x14, 0x63},
      {0x07, 0x08, 0x70, 0x08, 0x07}, {0x61, 0x51, 0x49, 0x45, 0x43},
  };
  if (c >= 'a' && c <= 'z') c -= 32;
  if (c >= '0' && c <= '9') return digits[c - '0'];
  if (c >= 'A' && c <= 'Z') return letters[c - 'A'];
  if (c == '-') return dash;
  if (c == '.') return dot;
  if (c == '/') return slash;
  if (c == ':') return colon;
  return blank;
}

void oledDrawChar(int x, int y, char c, uint8_t scale = 1) {
  const uint8_t *glyph = glyph5x7(c);
  for (uint8_t col = 0; col < 5; ++col) {
    for (uint8_t row = 0; row < 7; ++row) {
      if (glyph[col] & (1 << row)) {
        oledDrawBox(x + col * scale, y + row * scale, scale, scale);
      }
    }
  }
}

void oledDrawText(int x, int y, const String &text, uint8_t scale = 1) {
  for (size_t i = 0; i < text.length(); ++i) {
    oledDrawChar(x + i * 6 * scale, y, text[i], scale);
  }
}

int oledTextWidth(const String &text, uint8_t scale) {
  return text.length() == 0 ? 0 : static_cast<int>(text.length()) * 6 * scale - scale;
}

void oledDrawCenteredText(int y, const String &text, uint8_t scale = 1) {
  int x = (kOledWidth - oledTextWidth(text, scale)) / 2;
  oledDrawText(max(0, x), y, text, scale);
}

void oledDrawScrollingText(int y, String text, uint8_t scale = 1) {
  text.trim();
  text.toUpperCase();
  if (text.length() == 0) return;

  int width = oledTextWidth(text, scale);
  if (width <= kOledWidth) {
    oledDrawCenteredText(y, text, scale);
    return;
  }

  int gap = 18 * scale;
  int cycle = width + gap;
  int offset = static_cast<int>((millis() / 80UL) % cycle);
  oledDrawText(-offset, y, text, scale);
  oledDrawText(width + gap - offset, y, text, scale);
}

uint8_t wifiBars() {
  if (!wifiReady || WiFi.status() != WL_CONNECTED) return 0;
  int rssi = WiFi.RSSI();
  if (rssi >= -55) return 4;
  if (rssi >= -66) return 3;
  if (rssi >= -76) return 2;
  return 1;
}

void drawWifiGlyph(uint8_t x, uint8_t y) {
  uint8_t bars = wifiBars();
  for (uint8_t i = 0; i < 4; ++i) {
    uint8_t h = 2 + i * 2;
    uint8_t bx = x + i * 5;
    uint8_t by = y + 8 - h;
    if (i < bars) {
      oledDrawBox(bx, by, 3, h);
    } else {
      oledDrawFrame(bx, by, 3, h);
    }
  }
}

void drawBatteryGlyph(uint8_t x, uint8_t y) {
  oledDrawFrame(x, y + 2, 15, 7);
  oledDrawBox(x + 15, y + 4, 2, 3);
  oledDrawBox(x + 2, y + 4, 3, 3);
  oledDrawBox(x + 6, y + 4, 3, 3);
  oledDrawBox(x + 10, y + 4, 3, 3);
}

void drawTopStatusBar() {
  drawWifiGlyph(2, 1);
  oledDrawCenteredText(1, F("HSTUDIO"), 1);
  drawBatteryGlyph(108, 1);
  oledDrawHLine(0, 10, 128);
}

void drawEye(int x, int y, bool blink, bool thinking, bool error) {
  if (error) {
    oledDrawHLine(x + 8, y + 9, 22);
    oledDrawHLine(x + 13, y + 14, 12);
    return;
  }
  if (blink) {
    oledDrawSoftBox(x + 2, y + 11, 36, 5, 2);
    return;
  }
  oledDrawSoftBox(x, y, 40, thinking ? 18 : 24, 7);
  int phase = static_cast<int>((millis() / 1400UL) % 5);
  int lookX = thinking ? 0 : (phase == 1 ? -3 : (phase == 3 ? 3 : 0));
  oledDrawSoftBox(x + 16 + lookX, y + 7, 8, 10, 2, false);
}

String interactionStatusLabel() {
  if (mcuInteractionStatus == F("transcribing")) return F("STT");
  if (mcuInteractionStatus == F("thinking")) return F("THINK");
  if (mcuInteractionStatus == F("tool")) return F("TOOL");
  if (mcuInteractionStatus == F("speaking")) return F("SPEAK");
  if (mcuInteractionStatus == F("completed")) return F("DONE");
  if (mcuInteractionStatus == F("failed")) return F("FAILED");
  if (mcuInteractionStatus == F("aborted")) return F("ABORT");
  if (mcuInteractionStatus == F("listening")) return F("LISTEN");
  return F("MCU");
}

void drawInteractionFrame() {
  drawTopStatusBar();

  String title = interactionStatusLabel();
  oledDrawCenteredText(17, fitOledText(title, 12), 2);

  String detail = mcuInteractionText;
  if (mcuInteractionStatus == F("tool")) {
    detail = mcuToolName;
    if (mcuToolStatus.length() > 0) {
      detail += F(" ");
      detail += mcuToolStatus;
    }
  }
  if (detail.length() > 20 || mcuInteractionStatus == F("failed")) {
    oledDrawScrollingText(39, detail, 1);
  } else {
    oledDrawCenteredText(39, fitOledText(detail, 20), 1);
  }

  if (mcuAudioPlaying && mcuAudioDurationMs > 0) {
    uint32_t elapsed = millis() - mcuAudioStartedAtMs;
    uint8_t progress = clampUiValue((elapsed * 100UL) / mcuAudioDurationMs, 100);
    oledDrawFrame(20, 52, 88, 4);
    uint8_t filled = static_cast<uint8_t>((progress * 84) / 100);
    if (filled > 0) oledDrawBox(22, 53, filled, 2);
  } else {
    String queue = String(F("QUEUE ")) + mcuAudioCount;
    oledDrawCenteredText(55, queue, 1);
  }
}

bool oledFlush() {
  for (uint8_t page = 0; page < 8; ++page) {
    if (!oledCommand(0xB0 + page) || !oledCommand(0x00) || !oledCommand(0x10)) return false;
    if (!oledData(oledBuffer + page * kOledWidth, kOledWidth)) return false;
  }
  return true;
}

void drawOledFrame() {
  if (mcuInteractionActive) {
    drawInteractionFrame();
    return;
  }

  bool thinking = oledMode == OledMode::Think;
  bool error = oledMode == OledMode::Error;
  bool blink = !thinking && !error && (millis() % 4300UL) > 4100UL;
  drawTopStatusBar();
  drawEye(19, 22, blink, thinking, error);
  drawEye(69, 22, blink, thinking, error);
  if (thinking) {
    uint8_t phase = static_cast<uint8_t>((millis() / 180) % 4);
    for (uint8_t i = 0; i < 3; ++i) {
      uint8_t h = 2 + ((phase + i) % 3) * 2;
      oledDrawBox(58 + i * 6, 54 - h, 3, h);
    }
  } else if (oledProgress > 0) {
    oledDrawFrame(20, 52, 88, 4);
    uint8_t filled = static_cast<uint8_t>((oledProgress * 84) / 100);
    if (filled > 0) oledDrawBox(22, 53, filled, 2);
  }
  String status = oledTitle;
  if (oledHint.length() > 0 && oledHint != oledTitle) {
    status += F(" ");
    status += oledHint;
  }
  oledDrawScrollingText(57, status, 1);
}

void refreshOled(bool force = false) {
  if (!oledReady) return;
  uint32_t now = millis();
  if (!force && !oledDirty && now - lastOledAtMs < kOledRefreshIntervalMs) return;
  oledDirty = false;
  lastOledAtMs = now;
  oledClearBuffer();
  drawOledFrame();
  oledReady = oledFlush();
}

void setOledStatus(OledMode mode, const String &title, const String &hint, uint8_t progress = 0) {
  String nextTitle = fitOledText(title, 10);
  String nextHint = fitOledText(hint, 20);
  oledMode = mode;
  oledTitle = nextTitle;
  oledHint = nextHint;
  oledProgress = progress > 100 ? 100 : progress;
  oledDirty = true;
  refreshOled(true);
}

void initOledDisplay() {
  Wire.begin(kPinI2cSda, kPinI2cScl);
  Wire.setClock(100000);
  delay(40);
  if (i2cProbe(kDefaultOledAddr)) {
    oledAddress = kDefaultOledAddr;
    oledFound = true;
  } else if (i2cProbe(kAltOledAddr)) {
    oledAddress = kAltOledAddr;
    oledFound = true;
  } else {
    oledReady = false;
    Serial.printf("OLED not found sda=%d scl=%d addr=%s/%s\n", kPinI2cSda, kPinI2cScl,
                  hexByte(kDefaultOledAddr).c_str(), hexByte(kAltOledAddr).c_str());
    return;
  }
  Serial.printf("OLED found sda=%d scl=%d addr=%s\n", kPinI2cSda, kPinI2cScl, hexByte(oledAddress).c_str());
  static const uint8_t initCommands[] = {
      0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40, 0x8D, 0x14,
      0x20, 0x00, 0xA1, 0xC8, 0xDA, 0x12, 0x81, 0xCF, 0xD9, 0xF1,
      0xDB, 0x40, 0xA4, 0xA6, 0x2E, 0xAF,
  };
  oledReady = true;
  for (uint8_t command : initCommands) {
    if (!oledCommand(command)) {
      oledReady = false;
      return;
    }
  }
  oledClearBuffer();
  oledReady = oledFlush();
  if (oledReady) setOledStatus(OledMode::Boot, F("BOOT"), F("OLED ONLINE"), 10);
}

String escapeHtml(const String &value) {
  String out;
  out.reserve(value.length());
  for (size_t i = 0; i < value.length(); ++i) {
    switch (value[i]) {
      case '&':
        out += F("&amp;");
        break;
      case '<':
        out += F("&lt;");
        break;
      case '>':
        out += F("&gt;");
        break;
      case '"':
        out += F("&quot;");
        break;
      case '\'':
        out += F("&#39;");
        break;
      default:
        out += value[i];
        break;
    }
  }
  return out;
}

String prefString(const char *key) {
  prefs.begin("net", true);
  String value = prefs.getString(key, "");
  prefs.end();
  return value;
}

void loadAudioPreferences() {
  prefs.begin("mcu", true);
  outputVolumePercent = clampUiValue(static_cast<uint32_t>(prefs.getUChar("volume", kDefaultOutputVolumePercent)), 100);
  prefs.end();
}

void saveOutputVolume(uint8_t volume) {
  outputVolumePercent = clampUiValue(volume, 100);
  prefs.begin("mcu", false);
  prefs.putUChar("volume", outputVolumePercent);
  prefs.end();
}

String currentIp() {
  return wifiReady ? WiFi.localIP().toString() : WiFi.softAPIP().toString();
}

String deviceUrl(const IPAddress &ip) {
  return String(F("http://")) + ip.toString() + F("/");
}

String deviceId() {
  String mac = WiFi.macAddress();
  mac.replace(":", "");
  mac.toLowerCase();
  return String(F("hstudio_esp32c3_")) + mac;
}

String mcuDeviceCode() {
  prefs.begin("mcu", true);
  String code = prefs.getString("device_code", "");
  prefs.end();
  code.trim();
  if (code.length() > 0) return code;

  code = F("hstudio_mcu_");
  for (uint8_t i = 0; i < 16; ++i) {
    uint8_t value = static_cast<uint8_t>(esp_random() & 0xFF);
    if (value < 16) code += F("0");
    code += String(value, HEX);
  }

  prefs.begin("mcu", false);
  prefs.putString("device_code", code);
  prefs.end();
  return code;
}

String mcuSocketStateLabel() {
  if (mcuSocketNamespaceReady) return F("已连接");
  if (mcuSocketConnected) return F("握手中");
  if (wsReady) return F("重连中");
  return F("未连接");
}

String escapeJson(const String &value) {
  String out;
  out.reserve(value.length() + 8);
  for (size_t i = 0; i < value.length(); ++i) {
    char c = value[i];
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (c == '\n') {
      out += F("\\n");
    } else if (c == '\r') {
      out += F("\\r");
    } else if (c == '\t') {
      out += F("\\t");
    } else {
      out += c;
    }
  }
  return out;
}

String compactDetail(String value) {
  value.replace("\r", " ");
  value.replace("\n", " ");
  value.trim();
  if (value.length() > 180) value = value.substring(0, 180);
  return value;
}

void rememberMcuLoginResult(int code, const String &detail) {
  lastMcuLoginCode = code;
  lastMcuLoginAtMs = millis();
  lastMcuLoginDetail = compactDetail(detail);
}

void clearLoginProfiles() {
  loginProfileCount = 0;
  for (int i = 0; i < kMaxProfiles; ++i) {
    loginProfiles[i] = "";
  }
}

void parseLoginProfiles(const String &json) {
  clearLoginProfiles();
  int keyAt = json.indexOf(F("\"profiles\""));
  if (keyAt < 0) return;
  int openAt = json.indexOf('[', keyAt);
  int closeAt = json.indexOf(']', openAt + 1);
  if (openAt < 0 || closeAt < 0) return;

  bool inString = false;
  bool escaped = false;
  String value;
  for (int i = openAt + 1; i < closeAt && loginProfileCount < kMaxProfiles; ++i) {
    char c = json[i];
    if (!inString) {
      if (c == '"') {
        inString = true;
        value = "";
      }
      continue;
    }
    if (escaped) {
      value += c;
      escaped = false;
      continue;
    }
    if (c == '\\') {
      escaped = true;
      continue;
    }
    if (c == '"') {
      loginProfiles[loginProfileCount++] = value;
      inString = false;
      continue;
    }
    value += c;
  }
}

String uptimeText() {
  uint32_t seconds = millis() / 1000UL;
  uint32_t days = seconds / 86400UL;
  seconds %= 86400UL;
  uint8_t hours = seconds / 3600UL;
  seconds %= 3600UL;
  uint8_t minutes = seconds / 60UL;
  seconds %= 60UL;

  String value;
  if (days > 0) {
    value += days;
    value += F("天 ");
  }
  if (hours < 10) value += F("0");
  value += hours;
  value += F(":");
  if (minutes < 10) value += F("0");
  value += minutes;
  value += F(":");
  if (seconds < 10) value += F("0");
  value += seconds;
  return value;
}

void appendInfoRow(String &html, const __FlashStringHelper *label, const String &value) {
  html += F("<div class='info-row'><span>");
  html += label;
  html += F("</span><strong>");
  html += escapeHtml(value);
  html += F("</strong></div>");
}

String jsonStringValue(const String &json, const __FlashStringHelper *key) {
  String pattern = String(F("\"")) + key + F("\"");
  int keyAt = json.indexOf(pattern);
  if (keyAt < 0) return "";
  int colonAt = json.indexOf(':', keyAt + pattern.length());
  if (colonAt < 0) return "";
  int quoteAt = json.indexOf('"', colonAt + 1);
  if (quoteAt < 0) return "";

  String value;
  bool escaped = false;
  for (int i = quoteAt + 1; i < static_cast<int>(json.length()); ++i) {
    char c = json[i];
    if (escaped) {
      value += c;
      escaped = false;
      continue;
    }
    if (c == '\\') {
      escaped = true;
      continue;
    }
    if (c == '"') break;
    value += c;
  }
  return value;
}

String jsonObjectValue(const String &json, const __FlashStringHelper *key) {
  String pattern = String(F("\"")) + key + F("\"");
  int keyAt = json.indexOf(pattern);
  if (keyAt < 0) return "";
  int colonAt = json.indexOf(':', keyAt + pattern.length());
  if (colonAt < 0) return "";
  int openAt = json.indexOf('{', colonAt + 1);
  if (openAt < 0) return "";

  bool inString = false;
  bool escaped = false;
  int depth = 0;
  for (int i = openAt; i < static_cast<int>(json.length()); ++i) {
    char c = json[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c == '\\') {
      escaped = inString;
      continue;
    }
    if (c == '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c == '{') ++depth;
    if (c == '}') {
      --depth;
      if (depth == 0) return json.substring(openAt, i + 1);
    }
  }
  return "";
}

int jsonIntValue(const String &json, const __FlashStringHelper *key) {
  String pattern = String(F("\"")) + key + F("\"");
  int keyAt = json.indexOf(pattern);
  if (keyAt < 0) return 0;
  int colonAt = json.indexOf(':', keyAt + pattern.length());
  if (colonAt < 0) return 0;
  int startAt = colonAt + 1;
  while (startAt < static_cast<int>(json.length()) && json[startAt] == ' ') ++startAt;
  return json.substring(startAt).toInt();
}

bool jsonBoolValue(const String &json, const __FlashStringHelper *key) {
  String pattern = String(F("\"")) + key + F("\"");
  int keyAt = json.indexOf(pattern);
  if (keyAt < 0) return false;
  int colonAt = json.indexOf(':', keyAt + pattern.length());
  if (colonAt < 0) return false;
  int startAt = colonAt + 1;
  while (startAt < static_cast<int>(json.length()) && json[startAt] == ' ') ++startAt;
  return json.startsWith(F("true"), startAt);
}

void putLe16(uint8_t *dst, uint16_t value) {
  dst[0] = static_cast<uint8_t>(value & 0xFF);
  dst[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
}

void putLe32(uint8_t *dst, uint32_t value) {
  dst[0] = static_cast<uint8_t>(value & 0xFF);
  dst[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
  dst[2] = static_cast<uint8_t>((value >> 16) & 0xFF);
  dst[3] = static_cast<uint8_t>((value >> 24) & 0xFF);
}

void writeWavHeader(uint8_t *wav, uint32_t dataBytes) {
  memcpy(wav, "RIFF", 4);
  putLe32(wav + 4, 36 + dataBytes);
  memcpy(wav + 8, "WAVEfmt ", 8);
  putLe32(wav + 16, 16);
  putLe16(wav + 20, 1);
  putLe16(wav + 22, 1);
  putLe32(wav + 24, kAudioSampleRate);
  putLe32(wav + 28, kAudioSampleRate * 2);
  putLe16(wav + 32, 2);
  putLe16(wav + 34, 16);
  memcpy(wav + 36, "data", 4);
  putLe32(wav + 40, dataBytes);
}

bool parseAudioUrl(const String &url, String *scheme, String *host, uint16_t *port, String *path) {
  if (!scheme || !host || !port || !path) return false;
  if (url.startsWith(F("/"))) {
    String baseScheme;
    String baseHost;
    String basePath;
    uint16_t basePort = 0;
    if (!parseAudioUrl(activeDeviceUrl, &baseScheme, &baseHost, &basePort, &basePath)) return false;
    *scheme = baseScheme;
    *host = baseHost;
    *port = basePort;
    *path = url;
    return true;
  }
  int schemeEnd = url.indexOf(F("://"));
  if (schemeEnd <= 0) return false;
  String parsedScheme = url.substring(0, schemeEnd);
  parsedScheme.toLowerCase();
  if (parsedScheme != F("http") && parsedScheme != F("https")) return false;

  String rest = url.substring(schemeEnd + 3);
  int pathStart = rest.indexOf('/');
  String authority = pathStart >= 0 ? rest.substring(0, pathStart) : rest;
  String parsedPath = pathStart >= 0 ? rest.substring(pathStart) : String(F("/"));
  authority.trim();
  parsedPath.trim();
  if (authority.length() == 0) return false;

  uint16_t parsedPort = parsedScheme == F("https") ? 443 : 80;
  String parsedHost = authority;
  int colon = authority.lastIndexOf(':');
  if (colon > 0) {
    int portValue = authority.substring(colon + 1).toInt();
    if (portValue <= 0 || portValue > 65535) return false;
    parsedPort = static_cast<uint16_t>(portValue);
    parsedHost = authority.substring(0, colon);
    parsedHost.trim();
  }
  if (parsedHost.length() == 0) return false;
  if (parsedPath.length() == 0) parsedPath = F("/");
  *scheme = parsedScheme;
  *host = parsedHost;
  *port = parsedPort;
  *path = parsedPath;
  return true;
}

String readHttpLine(WiFiClient &client, uint32_t timeoutMs) {
  String line;
  uint32_t started = millis();
  while (millis() - started < timeoutMs) {
    while (client.available() > 0) {
      char c = static_cast<char>(client.read());
      if (c == '\r') continue;
      if (c == '\n') return line;
      if (line.length() < 240) line += c;
    }
    if (!client.connected()) break;
    delay(5);
    yield();
  }
  return line;
}

bool readHttpResponseHeaders(WiFiClient &client, int *statusCode, int *contentLength, String *contentType) {
  if (!statusCode || !contentLength || !contentType) return false;
  String status = readHttpLine(client, kMcuAudioHttpTimeoutMs);
  status.trim();
  if (!status.startsWith(F("HTTP/"))) {
    lastAudioDetail = String(F("bad HTTP response: ")) + compactDetail(status);
    return false;
  }
  int firstSpace = status.indexOf(' ');
  if (firstSpace < 0) return false;
  *statusCode = status.substring(firstSpace + 1, firstSpace + 4).toInt();
  *contentLength = -1;
  *contentType = "";

  while (true) {
    String line = readHttpLine(client, kMcuAudioHttpTimeoutMs);
    if (line.length() == 0) break;
    int colon = line.indexOf(':');
    if (colon <= 0) continue;
    String name = line.substring(0, colon);
    String value = line.substring(colon + 1);
    name.toLowerCase();
    value.trim();
    if (name == F("content-length")) {
      *contentLength = value.toInt();
    } else if (name == F("content-type")) {
      *contentType = value;
      contentType->toLowerCase();
    }
  }
  return *statusCode > 0;
}

bool es8311Write(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(kEs8311Addr);
  Wire.write(reg);
  Wire.write(value);
  uint8_t err = Wire.endTransmission();
  if (err != 0) {
    lastAudioDetail = String(F("ES8311 write ")) + hexByte(reg) + F(" failed err=") + String(err);
    return false;
  }
  return true;
}

bool es8311Read(uint8_t reg, uint8_t &value) {
  Wire.beginTransmission(kEs8311Addr);
  Wire.write(reg);
  uint8_t err = Wire.endTransmission(false);
  if (err != 0) {
    lastAudioDetail = String(F("ES8311 read-select ")) + hexByte(reg) + F(" failed err=") + String(err);
    return false;
  }
  if (Wire.requestFrom(static_cast<int>(kEs8311Addr), 1) != 1) {
    lastAudioDetail = String(F("ES8311 read ")) + hexByte(reg) + F(" returned no data");
    return false;
  }
  value = Wire.read();
  return true;
}

bool es8311UpdateBits(uint8_t reg, uint8_t clearMask, uint8_t setMask) {
  uint8_t value = 0;
  if (!es8311Read(reg, value)) return false;
  value &= ~clearMask;
  value |= setMask;
  return es8311Write(reg, value);
}

bool configureEs8311Codec() {
  if (!es8311Found) {
    lastAudioDetail = F("ES8311 not found on I2C");
    return false;
  }

  bool ok = true;
  ok &= es8311Write(0x00, 0x1F);
  delay(20);
  ok &= es8311Write(0x00, 0x00);
  ok &= es8311Write(0x00, 0x80);
  ok &= es8311Write(0x01, 0x3F);
  ok &= es8311Write(0x02, 0x00);
  ok &= es8311Write(0x03, 0x10);
  ok &= es8311Write(0x04, 0x10);
  ok &= es8311Write(0x05, 0x00);
  ok &= es8311Write(0x06, 0x03);
  ok &= es8311Write(0x07, 0x00);
  ok &= es8311Write(0x08, 0xFF);
  ok &= es8311UpdateBits(0x00, 0x40, 0x00);
  ok &= es8311Write(0x09, 0x0C);
  ok &= es8311Write(0x0A, 0x0C);
  ok &= es8311Write(0x0D, 0x01);
  ok &= es8311Write(0x0E, 0x02);
  ok &= es8311Write(0x12, 0x00);
  ok &= es8311Write(0x13, 0x10);
  ok &= es8311Write(0x1C, 0x6A);
  ok &= es8311Write(0x37, 0x08);
  ok &= es8311Write(0x17, 0xC8);
  ok &= es8311Write(0x14, 0x1A);
  ok &= es8311Write(0x16, 0x03);
  ok &= es8311Write(0x32, kEs8311DacVolume);
  ok &= es8311UpdateBits(0x31, 0x60, 0x00);
  if (ok) lastAudioDetail = F("ES8311 configured");
  return ok;
}

bool configureI2sBus() {
  i2s_driver_uninstall(kI2sPort);
  i2s_config_t config = {};
  config.mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_TX | I2S_MODE_RX);
  config.sample_rate = kAudioSampleRate;
  config.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  config.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;
  config.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  config.intr_alloc_flags = 0;
  config.dma_buf_count = 6;
  config.dma_buf_len = 256;
  config.use_apll = false;
  config.tx_desc_auto_clear = true;
  config.fixed_mclk = 0;
  config.mclk_multiple = I2S_MCLK_MULTIPLE_256;
  config.bits_per_chan = I2S_BITS_PER_CHAN_16BIT;

  esp_err_t err = i2s_driver_install(kI2sPort, &config, 0, nullptr);
  if (err != ESP_OK) {
    lastAudioDetail = String(F("I2S install failed err=")) + String(static_cast<int>(err));
    return false;
  }

  i2s_pin_config_t pins = {};
  pins.mck_io_num = kPinI2sMck;
  pins.bck_io_num = kPinI2sBck;
  pins.ws_io_num = kPinI2sWs;
  pins.data_out_num = kPinI2sDout;
  pins.data_in_num = kPinI2sDin;
  err = i2s_set_pin(kI2sPort, &pins);
  if (err != ESP_OK) {
    lastAudioDetail = String(F("I2S pin setup failed err=")) + String(static_cast<int>(err));
    i2s_driver_uninstall(kI2sPort);
    return false;
  }
  i2s_zero_dma_buffer(kI2sPort);
  return true;
}

bool setI2sSampleRate(uint32_t sampleRate) {
  if (!i2sReady || sampleRate == 0) return false;
  esp_err_t err = i2s_set_sample_rates(kI2sPort, sampleRate);
  if (err != ESP_OK) {
    lastAudioDetail = String(F("I2S sample rate failed rate=")) + String(sampleRate) +
                      F(" err=") + String(static_cast<int>(err));
    return false;
  }
  i2s_zero_dma_buffer(kI2sPort);
  return true;
}

int16_t shapeOutputSample(int16_t sample) {
  int32_t value = (static_cast<int32_t>(sample) * static_cast<int32_t>(outputVolumePercent) * 10) / 1000;
  if (value > kVoiceOutputLimit) value = kVoiceOutputLimit;
  if (value < -kVoiceOutputLimit) value = -kVoiceOutputLimit;
  return static_cast<int16_t>(value);
}

int16_t shapeVoiceInputSample(int16_t sample) {
  int32_t value = (static_cast<int32_t>(sample) * kVoiceInputGainPermille) / 1000;
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return static_cast<int16_t>(value);
}

uint16_t sampleMagnitude(int16_t sample) {
  return sample == INT16_MIN ? 32768 : static_cast<uint16_t>(sample < 0 ? -sample : sample);
}

int16_t voiceInputMonoSample(int16_t left, int16_t right) {
  uint16_t leftMag = sampleMagnitude(left);
  uint16_t rightMag = sampleMagnitude(right);
  if (leftMag > rightMag * 2U) return shapeVoiceInputSample(left);
  if (rightMag > leftMag * 2U) return shapeVoiceInputSample(right);
  int32_t mixed = (static_cast<int32_t>(left) + static_cast<int32_t>(right)) / 2;
  return shapeVoiceInputSample(static_cast<int16_t>(mixed));
}

void shapePcmBuffer(uint8_t *buffer, size_t length) {
  for (size_t i = 0; i + 1 < length; i += 2) {
    int16_t sample = static_cast<int16_t>(static_cast<uint16_t>(buffer[i]) |
                                          (static_cast<uint16_t>(buffer[i + 1]) << 8));
    int16_t shaped = shapeOutputSample(sample);
    buffer[i] = static_cast<uint8_t>(shaped & 0xFF);
    buffer[i + 1] = static_cast<uint8_t>((static_cast<uint16_t>(shaped) >> 8) & 0xFF);
  }
}

bool shouldInterruptAudioForVoice() {
  bool pressed = digitalRead(kPinBoot) == LOW;
  uint32_t now = millis();
  if (!bootInputArmed) return false;

  if (pressed) {
    if (audioInterruptPressStartedAtMs == 0) {
      if (bootClickPending && now - bootClickPendingAtMs <= kBootDoubleClickMs) {
        bootSecondClickStarted = true;
      }
      audioInterruptPressStartedAtMs = now;
      return false;
    }
    if (now - audioInterruptPressStartedAtMs < kBootLongPressMs) return false;

    bootClickPending = false;
    bootSecondClickStarted = false;
    mcuVoiceAfterAudioInterrupt = true;
    mcuAudioStopOnlyAfterInterrupt = false;
    mcuSessionClearAfterAudioInterrupt = false;
    lastBootButtonAtMs = now;
    audioInterruptPressStartedAtMs = 0;
    return true;
  }

  if (audioInterruptPressStartedAtMs != 0) {
    uint32_t heldMs = now - audioInterruptPressStartedAtMs;
    audioInterruptPressStartedAtMs = 0;
    if (heldMs >= kBootDebounceMs && heldMs < kBootLongPressMs) {
      if (bootClickPending && (bootSecondClickStarted || now - bootClickPendingAtMs <= kBootDoubleClickMs)) {
        bootClickPending = false;
        bootSecondClickStarted = false;
        mcuAudioStopOnlyAfterInterrupt = false;
        mcuSessionClearAfterAudioInterrupt = true;
        lastBootButtonAtMs = now;
        return true;
      }
      bootClickPending = true;
      bootSecondClickStarted = false;
      bootClickPendingAtMs = now;
    }
  }

  if (bootClickPending && !bootSecondClickStarted && now - bootClickPendingAtMs > kBootDoubleClickMs) {
    bootClickPending = false;
    mcuAudioStopOnlyAfterInterrupt = true;
    mcuSessionClearAfterAudioInterrupt = false;
    lastBootButtonAtMs = now;
    return true;
  }

  if (!bootClickPending) {
    bootSecondClickStarted = false;
  }

  return false;
}

void initAudioHardware() {
  pinMode(kPinBoot, INPUT_PULLUP);
  setPowerAmp(true);
  es8311Found = i2cProbe(kEs8311Addr);
  i2sReady = configureI2sBus();
  es8311Ready = configureEs8311Codec();
  if (i2sReady && es8311Ready) {
    lastAudioDetail = F("audio ready: ES8311 + I2S");
  } else if (lastAudioDetail.length() == 0) {
    lastAudioDetail = F("audio init failed");
  }
  Serial.printf("Audio init es8311=%d i2s=%d detail=%s\n", es8311Ready ? 1 : 0, i2sReady ? 1 : 0,
                lastAudioDetail.c_str());
}

bool recordVoiceWav(uint8_t **outWav, size_t *outLen) {
  if (!outWav || !outLen) return false;
  *outWav = nullptr;
  *outLen = 0;
  if (audioBusy) {
    setOledStatus(OledMode::Think, F("BUSY"), F("AUDIO"), 50);
    return false;
  }
  if (!i2sReady || !es8311Ready) {
    lastAudioDetail = F("audio input is not ready");
    setOledStatus(OledMode::Error, F("AUDIO"), F("INPUT OFF"), 0);
    return false;
  }

  const uint32_t maxFrames = kVoiceRecordMaxFrames;
  uint8_t *wav = voiceWavBuffer;
  memset(wav, 0, 44);

  audioBusy = true;
  setPowerAmp(false);
  es8311UpdateBits(0x31, 0x60, 0x60);
  setI2sSampleRate(kAudioSampleRate);
  i2s_zero_dma_buffer(kI2sPort);
  setOledStatus(OledMode::Think, F("LISTEN"), F("SAY NOW"), 0);

  constexpr size_t kReadBytes = 512;
  uint8_t readBuffer[kReadBytes];
  uint32_t framesDone = 0;
  uint32_t emptyReads = 0;
  uint16_t leftPeak = 0;
  uint16_t rightPeak = 0;
  uint16_t monoPeak = 0;
  uint64_t monoSquares = 0;
  uint32_t activeSamples = 0;
  const char *stopReason = "max";
  voiceRecordHeardSpeech = false;
  voiceRecordRms = 0;
  voiceRecordPeak = 0;
  voiceRecordActiveSamples = 0;
  const uint32_t startedAt = millis();
  uint32_t releaseStartedAt = 0;
  uint32_t lastRecordOledAtMs = startedAt;
  uint8_t lastRecordProgress = 0;
  while (framesDone < maxFrames) {
    uint32_t loopNow = millis();
    if (loopNow - startedAt > kVoiceRecordHardTimeoutMs) {
      stopReason = "timeout";
      lastAudioDetail = String(F("voice record timeout frames=")) + String(framesDone) +
                        F(", empty=") + String(emptyReads);
      break;
    }
    if (framesDone > 0 && loopNow - startedAt > kVoiceRecordMinMs) {
      if (digitalRead(kPinBoot) != LOW) {
        if (releaseStartedAt == 0) releaseStartedAt = loopNow;
        if (loopNow - releaseStartedAt >= kBootDebounceMs) {
          stopReason = "release";
          break;
        }
      } else {
        releaseStartedAt = 0;
      }
    }
    size_t bytesRead = 0;
    esp_err_t err = i2s_read(kI2sPort, readBuffer, sizeof(readBuffer), &bytesRead, pdMS_TO_TICKS(40));
    if (err != ESP_OK) {
      audioBusy = false;
      lastAudioDetail = String(F("I2S read failed err=")) + String(static_cast<int>(err));
      setOledStatus(OledMode::Error, F("I2S"), F("READ FAIL"), 0);
      return false;
    }
    if (bytesRead == 0) {
      ++emptyReads;
      setOledStatus(OledMode::Think, F("LISTEN"), F("WAIT I2S"), 5);
      yield();
      continue;
    }

    int16_t *samples = reinterpret_cast<int16_t *>(readBuffer);
    size_t count = bytesRead / sizeof(int16_t);
    for (size_t i = 0; i + 1 < count && framesDone < maxFrames; i += 2) {
      int16_t left = samples[i];
      int16_t right = samples[i + 1];
      uint16_t leftMag = sampleMagnitude(left);
      uint16_t rightMag = sampleMagnitude(right);
      if (leftMag > leftPeak) leftPeak = leftMag;
      if (rightMag > rightPeak) rightPeak = rightMag;

      int16_t mono = voiceInputMonoSample(left, right);
      uint16_t monoMag = sampleMagnitude(mono);
      if (monoMag > monoPeak) monoPeak = monoMag;
      monoSquares += static_cast<uint64_t>(monoMag) * static_cast<uint64_t>(monoMag);
      if (monoMag >= kVoiceVadActiveThreshold) ++activeSamples;
      putLe16(wav + 44 + framesDone * 2, static_cast<uint16_t>(mono));
      ++framesDone;
    }

    uint8_t progress = static_cast<uint8_t>(min<uint32_t>((framesDone * 100UL) / maxFrames, 100));
    uint32_t now = millis();
    if (progress != lastRecordProgress && now - lastRecordOledAtMs >= 250) {
      lastRecordProgress = progress;
      lastRecordOledAtMs = now;
      setOledStatus(OledMode::Think, F("LISTEN"), F("RECORDING"), progress);
    }
    yield();
  }

  const uint32_t dataBytes = framesDone * sizeof(int16_t);
  if (dataBytes == 0) {
    audioBusy = false;
    lastAudioDetail = String(F("voice record empty, i2s empty reads=")) + String(emptyReads);
    setOledStatus(OledMode::Error, F("MIC"), F("NO DATA"), 0);
    return false;
  }

  writeWavHeader(wav, dataBytes);
  audioBusy = false;
  voiceRecordPeak = monoPeak;
  voiceRecordRms = framesDone > 0 ? static_cast<uint32_t>(sqrt(static_cast<double>(monoSquares) / framesDone)) : 0;
  voiceRecordActiveSamples = activeSamples;
  voiceRecordHeardSpeech = voiceRecordRms >= kVoiceVadRmsStart &&
                            voiceRecordPeak >= kVoiceVadPeakStart &&
                            voiceRecordActiveSamples >= kVoiceVadMinActiveSamples;
  lastAudioDetail = String(F("voice wav bytes=")) + String(44 + dataBytes) +
                    F(", stop=") + stopReason +
                    F(", peak L/R/M=") + String(leftPeak) + F("/") + String(rightPeak) +
                    F("/") + String(monoPeak) +
                    F(", rms=") + String(voiceRecordRms) +
                    F(", active=") + String(voiceRecordActiveSamples) +
                    F(", vad=") + (voiceRecordHeardSpeech ? F("speech") : F("quiet"));
  Serial.printf("Voice record frames=%lu bytes=%lu stop=%s peak L/R/M=%u/%u/%u rms=%lu active=%lu vad=%s\n",
                static_cast<unsigned long>(framesDone), static_cast<unsigned long>(44 + dataBytes),
                stopReason, leftPeak, rightPeak, monoPeak, static_cast<unsigned long>(voiceRecordRms),
                static_cast<unsigned long>(voiceRecordActiveSamples), voiceRecordHeardSpeech ? "speech" : "quiet");
  *outWav = wav;
  *outLen = 44 + dataBytes;
  return framesDone > 0;
}

String httpFailureDetail(int code, const String &body) {
  String detail = String(F("HTTP ")) + code;
  if (code < 0) {
    detail += F(" ");
    detail += HTTPClient::errorToString(code);
  } else {
    String compactBody = compactDetail(jsonStringValue(body, F("error")));
    if (compactBody.length() == 0) compactBody = compactDetail(jsonStringValue(body, F("reason")));
    if (compactBody.length() == 0) compactBody = compactDetail(body);
    if (compactBody.length() > 0) {
      detail += F(" ");
      detail += compactBody;
    }
  }
  return compactDetail(detail);
}

String endpointLabel(const String &endpointKind, uint16_t httpPort) {
  if (endpointKind == F("web")) return F("Web 端");
  if (endpointKind == F("desktop")) return F("桌面端");
  return String(F("自定义端口 ")) + httpPort;
}

String lanDeviceKey(const String &id, const String &endpointKind, uint16_t httpPort) {
  return id + F("|") + endpointKind + F("|") + String(httpPort);
}

String lanDeviceKey(const LanDevice &device) {
  return lanDeviceKey(device.id, device.endpointKind, device.httpPort);
}

String lanAddressKey(const LanDevice &device) {
  return device.ip + F("|") + device.endpointKind + F("|") + String(device.httpPort);
}

uint32_t fnv1a(const String &value) {
  uint32_t hash = 2166136261UL;
  for (size_t i = 0; i < value.length(); ++i) {
    hash ^= static_cast<uint8_t>(value[i]);
    hash *= 16777619UL;
  }
  return hash;
}

String profilePrefKey(const String &deviceKey) {
  return String(F("p")) + String(fnv1a(deviceKey), HEX);
}

String accountPrefKey(const String &deviceKey) {
  return String(F("a")) + String(fnv1a(deviceKey), HEX);
}

String passwordPrefKey(const String &deviceKey) {
  return String(F("w")) + String(fnv1a(deviceKey), HEX);
}

String savedProfileForDevice(const String &deviceKey) {
  prefs.begin("mcu", true);
  String profile = prefs.getString(profilePrefKey(deviceKey).c_str(), "");
  prefs.end();
  return profile;
}

String savedAccountForDevice(const String &deviceKey) {
  prefs.begin("mcu", true);
  String account = prefs.getString(accountPrefKey(deviceKey).c_str(), "");
  prefs.end();
  return account;
}

String savedPasswordForDevice(const String &deviceKey) {
  prefs.begin("mcu", true);
  String password = prefs.getString(passwordPrefKey(deviceKey).c_str(), "");
  prefs.end();
  return password;
}

void persistCredentialsForDevice(const String &deviceKey, const String &addressKey, const String &account,
                                 const String &password) {
  prefs.begin("mcu", false);
  prefs.putString(accountPrefKey(deviceKey).c_str(), account);
  prefs.putString(passwordPrefKey(deviceKey).c_str(), password);
  prefs.putString(accountPrefKey(addressKey).c_str(), account);
  prefs.putString(passwordPrefKey(addressKey).c_str(), password);
  prefs.end();
}

void persistProfileForDevice(const String &deviceKey, const String &addressKey, const String &profile,
                             const String &url) {
  prefs.begin("mcu", false);
  prefs.putString("last_key", deviceKey);
  prefs.putString("last_addr", addressKey);
  prefs.putString("last_profile", profile);
  prefs.putString("active_key", deviceKey);
  prefs.putString("active_addr", addressKey);
  prefs.putString("active_url", url);
  prefs.putString(profilePrefKey(deviceKey).c_str(), profile);
  prefs.putString(profilePrefKey(addressKey).c_str(), profile);
  prefs.end();
  activeDeviceKey = deviceKey;
  activeDeviceUrl = url;
}

void clearProfileForDevice(const String &deviceKey, const String &addressKey) {
  prefs.begin("mcu", false);
  prefs.remove(profilePrefKey(deviceKey).c_str());
  prefs.remove(profilePrefKey(addressKey).c_str());
  prefs.remove(accountPrefKey(deviceKey).c_str());
  prefs.remove(passwordPrefKey(deviceKey).c_str());
  prefs.remove(accountPrefKey(addressKey).c_str());
  prefs.remove(passwordPrefKey(addressKey).c_str());
  String lastKey = prefs.getString("last_key", "");
  String lastAddr = prefs.getString("last_addr", "");
  if (lastKey == deviceKey || lastAddr == addressKey) {
    prefs.remove("last_key");
    prefs.remove("last_addr");
    prefs.remove("last_profile");
  }
  String activeKey = prefs.getString("active_key", "");
  String activeAddr = prefs.getString("active_addr", "");
  if (activeKey == deviceKey || activeAddr == addressKey) {
    prefs.remove("active_key");
    prefs.remove("active_addr");
    prefs.remove("active_url");
    prefs.remove("auth_token");
  }
  prefs.end();
  if (activeDeviceKey == deviceKey) {
    activeDeviceKey = "";
    activeDeviceUrl = "";
    mcuAuthToken = "";
    disconnectMcuSocketClient();
  }
}

void applySavedProfile(LanDevice &device) {
  String profile = savedProfileForDevice(lanDeviceKey(device));
  if (profile.length() == 0) profile = savedProfileForDevice(lanAddressKey(device));
  profile.trim();
  device.profile = profile;
  device.loggedIn = profile.length() > 0;
  if (activeDeviceKey.length() == 0) {
    prefs.begin("mcu", true);
    String activeAddr = prefs.getString("active_addr", "");
    prefs.end();
    if (activeAddr.length() > 0 && activeAddr == lanAddressKey(device)) {
      activeDeviceKey = lanDeviceKey(device);
    }
  }
}

String activeDeviceLabel() {
  if (activeDeviceKey.length() == 0) return "";
  for (int i = 0; i < lanDeviceCount; ++i) {
    if (lanDeviceKey(lanDevices[i]) == activeDeviceKey) {
      return endpointLabel(lanDevices[i].endpointKind, lanDevices[i].httpPort) + F(" · ") +
             lanDevices[i].name + F(" · ") + lanDevices[i].profile;
    }
  }
  return activeDeviceKey;
}

int findLanDevice(const String &id, const String &endpointKind, uint16_t httpPort) {
  for (int i = 0; i < lanDeviceCount; ++i) {
    if (lanDevices[i].id == id && lanDevices[i].endpointKind == endpointKind &&
        lanDevices[i].httpPort == httpPort) {
      return i;
    }
  }
  return -1;
}

int findLanDeviceByAddress(const String &ip, const String &endpointKind, uint16_t httpPort) {
  for (int i = 0; i < lanDeviceCount; ++i) {
    if (lanDevices[i].ip == ip && lanDevices[i].endpointKind == endpointKind &&
        lanDevices[i].httpPort == httpPort) {
      return i;
    }
  }
  return -1;
}

int oldestLanDeviceSlot() {
  int slot = 0;
  for (int i = 1; i < kMaxLanDevices; ++i) {
    if (lanDevices[i].lastSeenMs < lanDevices[slot].lastSeenMs) slot = i;
  }
  return slot;
}

void rememberLanDeviceInfo(const String &json, const String &host, const String &baseUrl, uint32_t responseMs,
                           bool requireAnnouncement) {
  if (requireAnnouncement) {
    if (jsonStringValue(json, F("type")) != F("hermes.announce")) return;
    if (jsonIntValue(json, F("version")) != 1) return;
  }
  String id = jsonStringValue(json, F("device_id"));
  String name = jsonStringValue(json, F("computer_name"));
  String endpointKind = jsonStringValue(json, F("endpoint_kind"));
  uint16_t httpPort = static_cast<uint16_t>(jsonIntValue(json, F("http_port")));
  if (id.length() == 0 || httpPort == 0) return;
  if (endpointKind.length() == 0) {
    endpointKind = httpPort == 8648 ? F("web") : (httpPort == 8748 ? F("desktop") : F("custom"));
  }

  int slot = findLanDevice(id, endpointKind, httpPort);
  if (slot < 0 && host.length() > 0) {
    slot = findLanDeviceByAddress(host, endpointKind, httpPort);
  }
  if (slot < 0) {
    slot = lanDeviceCount < kMaxLanDevices ? lanDeviceCount++ : oldestLanDeviceSlot();
  }

  LanDevice &device = lanDevices[slot];
  device.id = id;
  device.name = name.length() > 0 ? name : id;
  device.ip = host;
  device.httpPort = httpPort;
  device.endpointKind = endpointKind;
  device.url = baseUrl.length() > 0 ? baseUrl : String(F("http://")) + device.ip + F(":") + httpPort;
  device.webVersion = jsonStringValue(json, F("hermes_web_ui_version"));
  device.agentVersion = jsonStringValue(json, F("hermes_agent_version"));
  device.responseMs = responseMs;
  device.lastSeenMs = millis();
  applySavedProfile(device);
}

void rememberLanDevice(const String &json, const IPAddress &remoteIp, uint32_t responseMs) {
  rememberLanDeviceInfo(json, remoteIp.toString(), "", responseMs, true);
}

String manualDevicePrefKey(int index) {
  return String(F("manual_")) + index;
}

String normalizedManualDeviceUrl(const String &input, String *hostOut = nullptr) {
  String raw = input;
  raw.trim();
  if (raw.length() == 0) return "";
  if (raw.indexOf(F("://")) < 0) raw = String(F("http://")) + raw;

  String scheme;
  String host;
  uint16_t port = 0;
  String path;
  if (!parseAudioUrl(raw, &scheme, &host, &port, &path)) return "";
  if (hostOut) *hostOut = host;
  return scheme + F("://") + host + F(":") + String(port);
}

bool manualDeviceUrlExists(const String &url) {
  prefs.begin("mcu", true);
  int count = prefs.getInt("manual_count", 0);
  for (int i = 0; i < count && i < kMaxManualDevices; ++i) {
    if (prefs.getString(manualDevicePrefKey(i).c_str(), "") == url) {
      prefs.end();
      return true;
    }
  }
  prefs.end();
  return false;
}

void persistManualDeviceUrl(const String &url) {
  if (url.length() == 0 || manualDeviceUrlExists(url)) return;
  prefs.begin("mcu", false);
  int count = prefs.getInt("manual_count", 0);
  if (count < 0) count = 0;
  if (count >= kMaxManualDevices) count = kMaxManualDevices - 1;
  prefs.putString(manualDevicePrefKey(count).c_str(), url);
  prefs.putInt("manual_count", min(count + 1, kMaxManualDevices));
  prefs.end();
}

bool fetchManualDeviceInfo(const String &input, String *error) {
  String host;
  String baseUrl = normalizedManualDeviceUrl(input, &host);
  if (baseUrl.length() == 0) {
    if (error) *error = F("机器地址无效");
    return false;
  }

  HTTPClient http;
  http.setTimeout(kMcuLoginTimeoutMs);
  String endpoint = baseUrl + F("/api/devices/link-info");
  uint32_t started = millis();
  if (!http.begin(endpoint)) {
    if (error) *error = F("无法打开机器信息接口");
    return false;
  }
  int code = http.GET();
  String body = http.getString();
  http.end();
  if (code < 200 || code >= 300) {
    if (error) *error = httpFailureDetail(code, body);
    return false;
  }
  if (jsonStringValue(body, F("device_id")).length() == 0 ||
      jsonStringValue(body, F("device_public_key")).length() == 0) {
    if (error) *error = F("机器信息缺少设备身份");
    return false;
  }
  rememberLanDeviceInfo(body, host, baseUrl, millis() - started, false);
  persistManualDeviceUrl(baseUrl);
  return true;
}

void refreshManualDevices() {
  if (!wifiReady || WiFi.status() != WL_CONNECTED) return;
  prefs.begin("mcu", true);
  int count = prefs.getInt("manual_count", 0);
  String urls[kMaxManualDevices];
  for (int i = 0; i < count && i < kMaxManualDevices; ++i) {
    urls[i] = prefs.getString(manualDevicePrefKey(i).c_str(), "");
  }
  prefs.end();
  for (int i = 0; i < count && i < kMaxManualDevices; ++i) {
    if (urls[i].length() == 0) continue;
    String ignored;
    fetchManualDeviceInfo(urls[i], &ignored);
  }
}

IPAddress lanBroadcastIp() {
  IPAddress ip = WiFi.localIP();
  IPAddress mask = WiFi.subnetMask();
  return IPAddress(ip[0] | static_cast<uint8_t>(~mask[0]), ip[1] | static_cast<uint8_t>(~mask[1]),
                   ip[2] | static_cast<uint8_t>(~mask[2]), ip[3] | static_cast<uint8_t>(~mask[3]));
}

void sendLanDiscoveryPacket(const IPAddress &target, const String &requestId) {
  String packet = String(F("{\"type\":\"hermes.discover\",\"version\":1,\"request_id\":\"")) + requestId + F("\"}");
  lanUdp.beginPacket(target, kHermesDiscoveryPort);
  lanUdp.print(packet);
  lanUdp.endPacket();
}

void scanLanDevices() {
  if (!wifiReady || WiFi.status() != WL_CONNECTED) return;
  if (!lanUdpReady) {
    lanUdpReady = lanUdp.begin(kLanDiscoveryLocalPort);
  }
  if (!lanUdpReady) return;

  String requestId = String(millis(), HEX);
  uint32_t started = millis();
  sendLanDiscoveryPacket(IPAddress(255, 255, 255, 255), requestId);
  IPAddress broadcast = lanBroadcastIp();
  if (broadcast != IPAddress(255, 255, 255, 255)) {
    sendLanDiscoveryPacket(broadcast, requestId);
  }

  while (millis() - started < kLanDiscoveryTimeoutMs) {
    int packetSize = lanUdp.parsePacket();
    if (packetSize <= 0) {
      delay(10);
      yield();
      continue;
    }
    char buffer[1600];
    int len = lanUdp.read(buffer, sizeof(buffer) - 1);
    if (len <= 0) continue;
    buffer[len] = '\0';
    String json(buffer);
    if (jsonStringValue(json, F("request_id")) != requestId) continue;
    rememberLanDevice(json, lanUdp.remoteIP(), millis() - started);
  }
  lastLanDiscoveryAtMs = millis();
  refreshManualDevices();
}

bool ssidAlreadyScanned(const String &ssid) {
  for (int i = 0; i < scannedNetworkCount; ++i) {
    if (scannedSsids[i] == ssid) return true;
  }
  return false;
}

void scanWifiList() {
  scannedNetworkCount = 0;
  for (int i = 0; i < kMaxScannedNetworks; ++i) {
    scannedSsids[i] = "";
    scannedRssi[i] = 0;
    scannedEncrypted[i] = false;
  }

  setOledStatus(OledMode::Think, F("WIFI"), F("SCAN"), 25);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.disconnect(false, false);
  delay(120);

  int found = WiFi.scanNetworks(false, true);
  if (found <= 0) {
    WiFi.scanDelete();
    return;
  }

  for (int i = 0; i < found && scannedNetworkCount < kMaxScannedNetworks; ++i) {
    String ssid = WiFi.SSID(i);
    ssid.trim();
    if (ssid.length() == 0 || ssidAlreadyScanned(ssid)) continue;
    int target = scannedNetworkCount++;
    scannedSsids[target] = ssid;
    scannedRssi[target] = WiFi.RSSI(i);
    scannedEncrypted[target] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
  }
  WiFi.scanDelete();
}

String pageStart(const String &title) {
  String html = String(F("<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
                         "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                         "<title>")) +
                escapeHtml(title) +
                F("</title><style>"
                  ":root{--bg:#fafafa;--surface:#fff;--line:#e0e0e0;--ink:#1a1a1a;--muted:#666;--accent:#333;--warn:#b4432d;--good:#2f7d4c}"
                  "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:'Avenir Next','PingFang SC','Noto Sans CJK SC',sans-serif;letter-spacing:0}"
	                  "main{max-width:760px;margin:auto;padding:28px 18px 40px}.panel,.card{background:var(--surface);border:1px solid var(--line);border-radius:6px}.panel{padding:22px}.card{padding:16px;margin-top:12px}"
	                  "h1{font-size:clamp(28px,5vw,44px);line-height:1.05;margin:0 0 10px}h2{font-size:18px;margin:0 0 10px}.lead,.hint{color:var(--muted);line-height:1.6}.lead{font-size:15px;margin:0 0 18px}.hint{font-size:12px;margin:0}.meta{font:12px/1.4 ui-monospace,'SFMono-Regular',Consolas,monospace;color:var(--muted);word-break:break-all}"
	                  "form{display:grid;gap:12px}.field{display:grid;gap:7px}.label{font-size:12px;color:var(--muted)}input,select{width:100%;min-height:42px;border:1px solid var(--line);border-radius:6px;background:#fff;padding:10px 11px;font:14px/1.2 ui-monospace,'SFMono-Regular',Consolas,monospace;color:var(--ink)}select{appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);background-position:calc(100% - 18px) 18px,calc(100% - 13px) 18px;background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:34px}input:focus,select:focus{outline:2px solid #cfcfcf;outline-offset:1px}"
	                  ".tabs{display:flex;gap:8px;border-bottom:1px solid var(--line);margin:18px -22px 18px;padding:0 22px}.tab{border:1px solid var(--line);border-bottom:0;border-radius:6px 6px 0 0;background:#f4f4f4;min-height:38px;padding:10px 14px;font:600 13px/1 'Avenir Next','PingFang SC','Noto Sans CJK SC',sans-serif;color:inherit;text-decoration:none}.tab.active{background:var(--surface);position:relative;top:1px}.info-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.info-row{border:1px solid var(--line);border-radius:6px;padding:12px;min-width:0}.info-row span{display:block;color:var(--muted);font-size:12px;margin-bottom:7px}.info-row strong{display:block;font:600 14px/1.35 ui-monospace,'SFMono-Regular',Consolas,monospace;word-break:break-all}@media(max-width:560px){.info-grid{grid-template-columns:1fr}}"
	                  ".btn{border:1px solid var(--line);background:var(--surface);border-radius:6px;min-height:38px;padding:9px 13px;font:600 13px/1 'Avenir Next','PingFang SC','Noto Sans CJK SC',sans-serif;color:inherit;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn.warn{background:var(--warn);border-color:var(--warn);color:#fff}.btn-row{display:flex;gap:10px;flex-wrap:wrap}.ok{color:var(--good)}.bad{color:var(--warn)}"
	                  "</style></head><body><main>");
  return html;
}

String pageEnd() {
  return F("</main></body></html>");
}

void sendWifiPage() {
  String savedSsid = prefString("ssid");
  bool savedInScan = false;
  for (int i = 0; i < scannedNetworkCount; ++i) {
    if (scannedSsids[i] == savedSsid) {
      savedInScan = true;
      break;
    }
  }

  String html = pageStart(F("连接 Wi-Fi"));
  html += F("<section class='panel'><p class='meta'>HStudio ESP32-C3</p><h1>连接局域网 Wi-Fi</h1>");
  if (wifiReady) {
    html += F("<p class='lead ok'>当前已联网：");
    html += escapeHtml(WiFi.SSID());
    html += F(" · IP ");
    html += WiFi.localIP().toString();
    html += F("</p>");
  } else {
    html += F("<p class='lead'>设备当前处于配网模式。连接热点 <strong>");
    html += kApName;
    html += F("</strong> 后，在这里选择或输入家里的 Wi-Fi。</p>");
  }

  html += F("<form method='post' action='/wifi'>");
  if (scannedNetworkCount > 0) {
    html += F("<div class='field'><span class='label'>SSID</span><select name='ssid'>");
    html += F("<option value=''>选择 Wi-Fi</option>");
    for (int i = 0; i < scannedNetworkCount; ++i) {
      html += F("<option value='");
      html += escapeHtml(scannedSsids[i]);
      html += F("'");
      if (scannedSsids[i] == savedSsid) html += F(" selected");
      html += F(">");
      html += escapeHtml(scannedSsids[i]);
      html += F(" · ");
      html += scannedRssi[i];
      html += F(" dBm");
      if (!scannedEncrypted[i]) html += F(" · 开放");
      html += F("</option>");
    }
    html += F("<option value='__manual__'>手动输入 SSID</option></select></div>");
    html += F("<div class='field'><span class='label'>手动 SSID</span><input name='ssid_manual' autocomplete='off' value='");
    if (!savedInScan) html += escapeHtml(savedSsid);
    html += F("'></div>");
  } else {
    html += F("<p class='hint'>没有扫到附近 Wi-Fi，请手动输入 SSID。</p>");
    html += F("<div class='field'><span class='label'>SSID</span><input name='ssid' autocomplete='off' required value='");
    html += escapeHtml(savedSsid);
    html += F("'></div>");
  }
  html += F("<div class='field'><span class='label'>密码</span><input name='pass' type='password' autocomplete='current-password' placeholder='开放网络可留空'></div>");
  html += F("<div class='btn-row'><button class='btn primary' type='submit'>保存并连接</button></div>");
  html += F("<p class='hint'>配网热点：");
  html += kApName;
  html += F("，无需密码。当前设备地址：http://");
  html += currentIp();
  html += F("/</p></form></section>");

  if (wifiReady || savedSsid.length() > 0) {
    html += F("<form method='post' action='/clear' class='card'><button class='btn primary' type='submit'>清除 Wi-Fi 配置并回到热点模式</button></form>");
  }
  html += pageEnd();
  server.send(200, F("text/html; charset=utf-8"), html);
}

void sendStatusPage() {
  String html = pageStart(F("设备已联网"));
  html += F("<section class='panel'><p class='meta'>HStudio ESP32-C3</p><h1>设备</h1><p class='lead'>");
  html += escapeHtml(WiFi.SSID());
  html += F(" · IP ");
  html += WiFi.localIP().toString();
  html += F("</p><nav class='tabs'><a class='tab active' href='/device'>设备</a><a class='tab' href='/ota'>OTA</a></nav>");

  html += F("<h2>本机</h2><div class='info-grid'>");
  appendInfoRow(html, F("Wi-Fi"), WiFi.SSID());
  appendInfoRow(html, F("IP"), WiFi.localIP().toString());
  appendInfoRow(html, F("MAC"), WiFi.macAddress());
  appendInfoRow(html, F("设备码"), mcuDeviceCode());
  appendInfoRow(html, F("信号"), String(WiFi.RSSI()) + F(" dBm"));
  appendInfoRow(html, F("运行时间"), uptimeText());
  appendInfoRow(html, F("可用内存"), String(ESP.getFreeHeap()) + F(" bytes"));
  appendInfoRow(html, F("服务连接"), mcuSocketStateLabel());
  appendInfoRow(html, F("音频硬件"), String(es8311Ready && i2sReady ? F("就绪") : F("未就绪")) + F(" · ") + lastAudioDetail);
  appendInfoRow(html, F("音量"), String(outputVolumePercent) + F("%"));
  appendInfoRow(html, F("电量"), F("未启用"));
  if (selectedProfile.length() > 0) {
    appendInfoRow(html, F("最近 Profile"), selectedProfile);
  }
  String activeLabel = activeDeviceLabel();
  if (activeLabel.length() > 0) {
    appendInfoRow(html, F("当前交互"), activeLabel);
  }
  appendInfoRow(html, F("MCU 状态"), mcuInteractionStatus);
  appendInfoRow(html, F("音频队列"), String(mcuAudioPlaying ? F("播放中 · ") : F("")) + String(mcuAudioCount));
  html += F("</div>");

  html += F("<div class='btn-row' style='margin-top:16px'><a class='btn primary' href='/device/scan'>刷新探测</a><a class='btn' href='/wifi'>重新配置 Wi-Fi</a></div>");
  html += F("</section>");

  html += F("<section class='card'><h2>音频</h2>");
  html += F("<form method='post' action='/device/audio'><div class='field'><span class='label'>播放音量 <output id='volume-output'>");
  html += outputVolumePercent;
  html += F("%</output></span><input name='volume' type='range' min='0' max='100' step='5' value='");
  html += outputVolumePercent;
  html += F("' oninput=\"document.getElementById('volume-output').textContent=this.value+'%'\"></div>");
  html += F("<div class='btn-row'><button class='btn primary' type='submit'>保存音量</button></div>");
  html += F("<p class='hint'>只影响 MCU 播放输出，不影响麦克风录音。</p></form></section>");

  html += F("<section class='card'><h2>手动添加机器</h2>");
  html += F("<form method='post' action='/device/manual'><div class='field'><span class='label'>地址</span>");
  html += F("<input name='url' autocomplete='off' placeholder='http://192.168.1.10:8648' required></div>");
  html += F("<div class='btn-row'><button class='btn primary' type='submit'>添加</button></div>");
  html += F("<p class='hint'>会请求对端公开机器信息接口并保存，已存在的机器会自动去重。</p></form></section>");

  html += F("<section class='card'><h2>局域网设备</h2>");
  if (lastLanDiscoveryAtMs == 0) {
    html += F("<p class='hint'>还没有探测。点击“刷新探测”后，会向固定发现端口广播并等待 Web 端、桌面端回应。</p>");
  } else {
    html += F("<p class='hint'>上次探测：");
    html += String((millis() - lastLanDiscoveryAtMs) / 1000UL);
    html += F(" 秒前</p>");
  }

  if (lanDeviceCount == 0) {
    html += F("<p class='lead'>未发现设备</p>");
  } else {
    html += F("<div class='info-grid'>");
    for (int i = 0; i < lanDeviceCount; ++i) {
      LanDevice &device = lanDevices[i];
      bool online = millis() - device.lastSeenMs < kLanDiscoveryStaleMs;
      html += F("<div class='info-row'><span>");
      html += endpointLabel(device.endpointKind, device.httpPort);
      html += online ? F(" · 在线") : F(" · 可能离线");
      html += device.loggedIn ? F(" · 已登录") : F(" · 未登录");
      if (lanDeviceKey(device) == activeDeviceKey) html += F(" · 当前交互");
      html += F("</span><strong>");
      html += escapeHtml(device.name);
      html += F("</strong><p class='hint'>");
      html += escapeHtml(device.url);
      if (device.profile.length() > 0) {
        html += F("<br>Profile ");
        html += escapeHtml(device.profile);
      }
      html += F("<br>响应 ");
      html += device.responseMs;
      html += F(" ms");
      if (device.webVersion.length() > 0) {
        html += F(" · Web ");
        html += escapeHtml(device.webVersion);
      }
      if (device.agentVersion.length() > 0) {
        html += F(" · Agent ");
        html += escapeHtml(device.agentVersion);
      }
      html += F("</p><div class='btn-row'>");
      if (device.loggedIn) {
        if (lanDeviceKey(device) != activeDeviceKey) {
          html += F("<a class='btn primary' href='/device/active?i=");
          html += i;
          html += F("'>设为当前</a>");
        }
        html += F("<a class='btn' href='/device/profile?i=");
        html += i;
        html += F("'>切换 Profile</a>");
        html += F("<a class='btn primary' href='/device/logout?i=");
        html += i;
        html += F("'>退出登录</a>");
      } else {
        html += F("<a class='btn primary' href='/device/login?i=");
        html += i;
        html += F("'>登录</a>");
      }
      html += F("</div></div>");
    }
    html += F("</div>");
  }
  html += F("</section>");

  html += F("<form method='post' action='/clear' class='card'><button class='btn primary' type='submit'>清除 Wi-Fi 配置并回到热点模式</button></form>");
  html += pageEnd();
  server.send(200, F("text/html; charset=utf-8"), html);
}

String otaNextCheckText() {
  int32_t remaining = static_cast<int32_t>(nextMcuOtaCheckAtMs - millis());
  if (remaining <= 0) return F("即将检查");
  return String(static_cast<uint32_t>(remaining) / 1000UL) + F(" 秒后");
}

void sendOtaPage(const String &notice = "") {
  String html = pageStart(F("OTA"));
  html += F("<section class='panel'><p class='meta'>HStudio ESP32-C3</p><h1>OTA</h1><p class='lead'>固件在线升级</p>");
  html += F("<nav class='tabs'><a class='tab' href='/device'>设备</a><a class='tab active' href='/ota'>OTA</a></nav>");
  if (notice.length() > 0) {
    html += F("<p class='hint'>");
    html += escapeHtml(notice);
    html += F("</p>");
  }
  html += F("<h2>固件状态</h2><div class='info-grid'>");
  appendInfoRow(html, F("当前 MD5"), ESP.getSketchMD5());
  appendInfoRow(html, F("服务端"), activeDeviceUrl.length() > 0 ? activeDeviceUrl : String(F("未连接")));
  appendInfoRow(html, F("Manifest"), activeDeviceEndpoint(F("/api/hermes/mcu/firmware/manifest")));
  appendInfoRow(html, F("下次自动检查"), otaNextCheckText());
  appendInfoRow(html, F("OTA 条件"), String(wifiReady && WiFi.status() == WL_CONNECTED ? F("Wi-Fi OK") : F("Wi-Fi OFF")) +
                F(" · ") + String(mcuAuthToken.length() > 0 ? F("Token OK") : F("No Token")));
  html += F("</div>");
  html += F("<form method='post' action='/ota/check' class='btn-row' style='margin-top:16px'>");
  html += F("<button class='btn primary' type='submit'>立即检查升级</button><a class='btn' href='/device'>返回设备</a></form>");
  html += F("<p class='hint'>自动升级会在空闲时运行；如果发现新固件，设备会下载、写入 OTA 分区并自动重启。</p>");
  html += F("</section>");
  html += pageEnd();
  server.send(200, F("text/html; charset=utf-8"), html);
}

void sendOtaUpdatingPage() {
  String html = pageStart(F("OTA"));
  html += F("<section class='panel'><p class='meta'>HStudio ESP32-C3</p><h1>OTA</h1><p class='lead'>固件正在更新</p>");
  html += F("<p class='hint'>固件正在下载并写入，请勿关闭单片机或断开电源。设备会自动重启，页面检测到恢复后会弹窗提示完成。</p>");
  html += F("<div class='info-grid'>");
  appendInfoRow(html, F("当前状态"), F("正在更新，请勿关闭单片机"));
  appendInfoRow(html, F("服务端"), activeDeviceUrl.length() > 0 ? activeDeviceUrl : String(F("未连接")));
  html += F("</div><p id='ota-status' class='hint'>等待设备重启...</p>");
  html += F("<script>");
  html += F("let seenOffline=false,done=false,start=Date.now();");
  html += F("const s=document.getElementById('ota-status');");
  html += F("async function poll(){if(done)return;");
  html += F("try{const r=await fetch('/health?ota='+Date.now(),{cache:'no-store'});");
  html += F("if(r.ok&&seenOffline){done=true;s.textContent='固件更新完成，设备已恢复在线。';alert('固件更新完成，设备已重启。');location.href='/ota';return;}");
  html += F("if(r.ok){s.textContent='正在写入固件，请勿关闭单片机...';}");
  html += F("}catch(e){seenOffline=true;s.textContent='设备正在重启，请等待恢复...';}");
  html += F("if(Date.now()-start>120000&&!done){done=true;s.textContent='更新超时，请重新打开设备页面确认状态。';alert('更新状态确认超时，请重新打开设备页面确认。');return;}");
  html += F("setTimeout(poll,1500)}setTimeout(poll,3000);");
  html += F("</script>");
  html += F("</section>");
  html += pageEnd();
  server.send(200, F("text/html; charset=utf-8"), html);
}

void handleOtaCheck() {
  String firmwareUrl;
  String md5;
  int size = 0;
  McuOtaResult result = checkMcuFirmwareUpdate(true, false, &firmwareUrl, &md5, &size);
  bool ok = result != McuOtaResult::Failed;
  nextMcuOtaCheckAtMs = millis() + (ok ? kMcuOtaIntervalMs : kMcuOtaRetryMs);
  if (result == McuOtaResult::NoUpdate) {
    sendOtaPage(F("当前已经是最新固件，无需更新。"));
    return;
  }
  if (result == McuOtaResult::UpdateAvailable) {
    sendOtaUpdatingPage();
    delay(800);
    bool applied = downloadAndApplyMcuFirmware(firmwareUrl, md5, size);
    if (!applied) {
      nextMcuOtaCheckAtMs = millis() + kMcuOtaRetryMs;
      setOledStatus(OledMode::Error, F("OTA"), F("FAIL"), 0);
    }
    return;
  }
  sendOtaPage(F("检查失败，请确认已登录机器且服务端已重启。"));
}

void scanAndSendStatusPage() {
  scanLanDevices();
  sendStatusPage();
}

void handleDeviceAudio() {
  String rawVolume = server.arg(F("volume"));
  rawVolume.trim();
  if (rawVolume.length() == 0) {
    server.send(400, F("text/plain; charset=utf-8"), F("缺少音量"));
    return;
  }
  int volume = rawVolume.toInt();
  if (volume < 0) volume = 0;
  if (volume > 100) volume = 100;
  saveOutputVolume(static_cast<uint8_t>(volume));
  lastAudioDetail = String(F("output volume ")) + String(outputVolumePercent) + F("%");
  server.sendHeader(F("Location"), F("/device"), true);
  server.send(302, F("text/plain"), F(""));
}

void addManualDevice() {
  String url = server.arg(F("url"));
  String error;
  if (!fetchManualDeviceInfo(url, &error)) {
    String html = pageStart(F("添加失败"));
    html += F("<section class='panel'><p class='meta'>MANUAL DEVICE</p><h1>添加失败</h1><p class='lead bad'>");
    html += escapeHtml(error.length() > 0 ? error : String(F("无法获取机器信息")));
    html += F("</p><div class='btn-row'><a class='btn primary' href='/device'>返回设备</a></div></section>");
    html += pageEnd();
    server.send(502, F("text/html; charset=utf-8"), html);
    return;
  }
  server.sendHeader(F("Location"), F("/device"), true);
  server.send(302, F("text/plain"), F(""));
}

bool lanDeviceIndex(int index, LanDevice **device) {
  if (!device || index < 0 || index >= lanDeviceCount) return false;
  *device = &lanDevices[index];
  return true;
}

String mcuLoginPayload(const String &account, const String &password) {
  String payload;
  payload.reserve(560);
  payload += F("{\"token\":\"");
  payload += escapeJson(deviceId());
  payload += F("\",\"id\":\"");
  payload += escapeJson(deviceId());
  payload += F("\",\"device_code\":\"");
  payload += escapeJson(mcuDeviceCode());
  payload += F("\",\"device_type\":\"global_agent\",\"source\":\"global_agent");
  payload += F("\",\"account\":\"");
  payload += escapeJson(account);
  payload += F("\",\"password\":\"");
  payload += escapeJson(password);
  payload += F("\"}");
  return payload;
}

bool runMcuLogin(LanDevice &device, const String &account, const String &password) {
  String endpoint = device.url;
  while (endpoint.endsWith("/")) endpoint.remove(endpoint.length() - 1);
  endpoint += F("/api/auth/mcu-login");

  setOledStatus(OledMode::Think, F("LOGIN"), F("MCU"), 40);
  HTTPClient http;
  http.setTimeout(kMcuLoginTimeoutMs);
  if (!http.begin(endpoint)) {
    rememberMcuLoginResult(-1, F("无法打开登录接口"));
    setOledStatus(OledMode::Error, F("LOGIN"), F("OPEN"), 0);
    return false;
  }

  http.addHeader(F("Content-Type"), F("application/json"));
  http.addHeader(F("X-Hermes-Device-Id"), deviceId());
  http.addHeader(F("X-Hermes-Device-Name"), F("HStudio ESP32-C3"));
  int code = http.POST(mcuLoginPayload(account, password));
  String response = http.getString();
  http.end();

  if (response.length() == 0) response = F("empty response");
  rememberMcuLoginResult(code, response);
  bool ok = code >= 200 && code < 300;
  if (ok) {
    persistCredentialsForDevice(lanDeviceKey(device), lanAddressKey(device), account, password);
    pendingProfileDeviceKey = lanDeviceKey(device);
    activeDeviceUrl = device.url;
    mcuAuthToken = jsonStringValue(response, F("token"));
    prefs.begin("mcu", false);
    prefs.putString("active_url", activeDeviceUrl);
    if (mcuAuthToken.length() > 0) prefs.putString("auth_token", mcuAuthToken);
    prefs.end();
    parseLoginProfiles(response);
    connectMcuSocketClient();
    setOledStatus(OledMode::Ready, F("LOGIN"), F("OK"), 100);
  } else {
    clearLoginProfiles();
    setOledStatus(OledMode::Error, F("LOGIN"), F("FAILED"), 0);
  }
  return ok;
}

bool savedCredentialsForDevice(const LanDevice &device, String *account, String *password) {
  if (!account || !password) return false;
  *account = savedAccountForDevice(lanDeviceKey(device));
  *password = savedPasswordForDevice(lanDeviceKey(device));
  if (account->length() == 0 || password->length() == 0) {
    *account = savedAccountForDevice(lanAddressKey(device));
    *password = savedPasswordForDevice(lanAddressKey(device));
  }
  account->trim();
  return account->length() > 0 && password->length() > 0;
}

bool autoLoginDevice(LanDevice &device) {
  String account;
  String password;
  if (!savedCredentialsForDevice(device, &account, &password)) return false;
  Serial.printf("Auto MCU login target=%s url=%s profile=%s\n",
                lanDeviceKey(device).c_str(), device.url.c_str(), selectedProfile.c_str());
  bool ok = runMcuLogin(device, account, password);
  if (ok && selectedProfile.length() > 0) {
    String key = lanDeviceKey(device);
    String addr = lanAddressKey(device);
    persistProfileForDevice(key, addr, selectedProfile, device.url);
    device.profile = selectedProfile;
    device.loggedIn = true;
    pendingProfileDeviceKey = key;
    activeDeviceKey = key;
    activeDeviceUrl = device.url;
  }
  return ok;
}

void autoLoginSavedDevice() {
  if (!wifiReady || WiFi.status() != WL_CONNECTED) return;
  if (selectedProfile.length() == 0) return;
  scanLanDevices();

  for (int i = 0; i < lanDeviceCount; ++i) {
    if (activeDeviceKey.length() > 0 && lanDeviceKey(lanDevices[i]) == activeDeviceKey) {
      autoLoginDevice(lanDevices[i]);
      return;
    }
  }

  prefs.begin("mcu", true);
  String activeAddr = prefs.getString("active_addr", "");
  prefs.end();
  for (int i = 0; i < lanDeviceCount; ++i) {
    if (activeAddr.length() > 0 && lanAddressKey(lanDevices[i]) == activeAddr) {
      autoLoginDevice(lanDevices[i]);
      return;
    }
  }

  for (int i = 0; i < lanDeviceCount; ++i) {
    String account;
    String password;
    if (lanDevices[i].profile.length() > 0 && savedCredentialsForDevice(lanDevices[i], &account, &password)) {
      autoLoginDevice(lanDevices[i]);
      return;
    }
  }
}

void sendMcuLoginPage() {
  int index = server.arg(F("i")).toInt();
  LanDevice *device = nullptr;
  if (!lanDeviceIndex(index, &device)) {
    server.send(404, F("text/plain; charset=utf-8"), F("设备不存在，请先刷新探测"));
    return;
  }

  String html = pageStart(F("登录设备"));
  html += F("<section class='panel'><p class='meta'>MCU LOGIN</p><h1>登录 ");
  html += escapeHtml(endpointLabel(device->endpointKind, device->httpPort));
  html += F("</h1><p class='lead'>");
  html += escapeHtml(device->name);
  html += F(" · ");
  html += escapeHtml(device->url);
  html += F("</p><form method='post' action='/device/login'><input type='hidden' name='i' value='");
  html += index;
  html += F("'><div class='field'><span class='label'>账号</span><input name='account' autocomplete='username' required></div>");
  html += F("<div class='field'><span class='label'>密码</span><input name='password' type='password' autocomplete='current-password' required></div>");
  html += F("<div class='btn-row'><button class='btn primary' type='submit'>登录</button><a class='btn' href='/device'>返回</a></div>");
  html += F("<p class='hint'>登录成功后会让你选择 profile，设备会使用登录 token 连接当前机器。</p></form></section>");
  html += pageEnd();
  server.send(200, F("text/html; charset=utf-8"), html);
}

void sendProfilePage() {
  String html = pageStart(F("选择 Profile"));
  html += F("<section class='panel'><p class='meta'>MCU LOGIN</p><h1>选择 Profile</h1>");
  if (lastMcuLoginCode >= 200 && lastMcuLoginCode < 300) {
    html += F("<p class='lead ok'>登录成功</p>");
  } else {
    html += F("<p class='lead bad'>登录失败：");
    html += escapeHtml(lastMcuLoginDetail);
    html += F("</p>");
  }

  if (loginProfileCount > 0) {
    html += F("<form method='post' action='/device/profile'><div class='field'><span class='label'>Profile</span><select name='profile' required>");
    for (int i = 0; i < loginProfileCount; ++i) {
      html += F("<option value='");
      html += escapeHtml(loginProfiles[i]);
      html += F("'>");
      html += escapeHtml(loginProfiles[i]);
      html += F("</option>");
    }
    html += F("</select></div><div class='btn-row'><button class='btn primary' type='submit'>使用这个 Profile</button><a class='btn' href='/device'>返回设备</a></div></form>");
  } else {
    html += F("<p class='hint'>没有拿到可选 profile。</p><div class='btn-row'><a class='btn primary' href='/device'>返回设备</a></div>");
  }
  html += pageEnd();
  server.send(200, F("text/html; charset=utf-8"), html);
}

void switchProfilePage() {
  int index = server.arg(F("i")).toInt();
  LanDevice *device = nullptr;
  if (!lanDeviceIndex(index, &device)) {
    server.send(404, F("text/plain; charset=utf-8"), F("设备不存在，请先刷新探测"));
    return;
  }
  if (!device->loggedIn) {
    server.sendHeader(F("Location"), String(F("/device/login?i=")) + index, true);
    server.send(302, F("text/plain"), F(""));
    return;
  }
  if (loginProfileCount == 0) {
    String html = pageStart(F("需要重新登录"));
    html += F("<section class='panel'><p class='meta'>MCU LOGIN</p><h1>需要重新登录</h1><p class='lead'>Profile 列表没有缓存，请重新登录后切换。</p><div class='btn-row'><a class='btn primary' href='/device/login?i=");
    html += index;
    html += F("'>重新登录</a><a class='btn' href='/device'>返回设备</a></div></section>");
    html += pageEnd();
    server.send(200, F("text/html; charset=utf-8"), html);
    return;
  }
  pendingProfileDeviceKey = lanDeviceKey(*device);
  sendProfilePage();
}

void handleMcuLogin() {
  int index = server.arg(F("i")).toInt();
  String account = server.arg(F("account"));
  String password = server.arg(F("password"));
  account.trim();
  LanDevice *device = nullptr;
  if (!lanDeviceIndex(index, &device)) {
    server.send(404, F("text/plain; charset=utf-8"), F("设备不存在，请先刷新探测"));
    return;
  }
  if (account.length() == 0 || password.length() == 0) {
    server.send(400, F("text/plain; charset=utf-8"), F("缺少账号或密码"));
    return;
  }
  runMcuLogin(*device, account, password);
  sendProfilePage();
}

void saveProfile() {
  selectedProfile = server.arg(F("profile"));
  selectedProfile.trim();
  if (pendingProfileDeviceKey.length() > 0 && selectedProfile.length() > 0) {
    for (int i = 0; i < lanDeviceCount; ++i) {
      if (lanDeviceKey(lanDevices[i]) == pendingProfileDeviceKey) {
        persistProfileForDevice(pendingProfileDeviceKey, lanAddressKey(lanDevices[i]), selectedProfile,
                                lanDevices[i].url);
        lanDevices[i].profile = selectedProfile;
        lanDevices[i].loggedIn = true;
        connectMcuSocketClient();
        break;
      }
    }
  }
  String html = pageStart(F("Profile 已选择"));
  html += F("<section class='panel'><p class='meta'>MCU LOGIN</p><h1>Profile 已选择</h1><p class='lead ok'>");
  html += escapeHtml(selectedProfile);
  html += F("</p><div class='btn-row'><a class='btn primary' href='/device'>返回设备</a></div></section>");
  html += pageEnd();
  server.send(200, F("text/html; charset=utf-8"), html);
}

void setActiveDevice() {
  int index = server.arg(F("i")).toInt();
  LanDevice *device = nullptr;
  if (!lanDeviceIndex(index, &device)) {
    server.send(404, F("text/plain; charset=utf-8"), F("设备不存在，请先刷新探测"));
    return;
  }
  if (!device->loggedIn) {
    server.sendHeader(F("Location"), String(F("/device/login?i=")) + index, true);
    server.send(302, F("text/plain"), F(""));
    return;
  }
  String account;
  String password;
  if (!savedCredentialsForDevice(*device, &account, &password)) {
    server.sendHeader(F("Location"), String(F("/device/login?i=")) + index, true);
    server.send(302, F("text/plain"), F(""));
    return;
  }

  activeDeviceKey = lanDeviceKey(*device);
  activeDeviceUrl = device->url;
  selectedProfile = device->profile;
  mcuAuthToken = "";
  disconnectMcuSocketClient();
  prefs.begin("mcu", false);
  prefs.putString("active_key", activeDeviceKey);
  prefs.putString("active_addr", lanAddressKey(*device));
  prefs.putString("active_url", activeDeviceUrl);
  prefs.putString("last_key", activeDeviceKey);
  prefs.putString("last_profile", selectedProfile);
  prefs.remove("auth_token");
  prefs.end();

  if (!runMcuLogin(*device, account, password)) {
    sendProfilePage();
    return;
  }

  server.sendHeader(F("Location"), F("/device"), true);
  server.send(302, F("text/plain"), F(""));
}

void logoutDevice() {
  int index = server.arg(F("i")).toInt();
  LanDevice *device = nullptr;
  if (!lanDeviceIndex(index, &device)) {
    server.send(404, F("text/plain; charset=utf-8"), F("设备不存在，请先刷新探测"));
    return;
  }
  String key = lanDeviceKey(*device);
  clearProfileForDevice(key, lanAddressKey(*device));
  device->profile = "";
  device->loggedIn = false;
  if (pendingProfileDeviceKey == key) pendingProfileDeviceKey = "";
  if (activeDeviceKey == key) activeDeviceKey = "";
  String lastKey;
  prefs.begin("mcu", true);
  lastKey = prefs.getString("last_key", "");
  selectedProfile = prefs.getString("last_profile", "");
  prefs.end();
  if (lastKey.length() == 0) selectedProfile = "";
  connectMcuSocketClient();
  server.sendHeader(F("Location"), F("/device"), true);
  server.send(302, F("text/plain"), F(""));
}

String mcuStatusJson() {
  String json;
  json.reserve(260);
  json += F("{\"type\":\"mcu.status\",\"interactionId\":\"");
  json += escapeJson(mcuInteractionId);
  json += F("\",\"status\":\"");
  json += escapeJson(mcuInteractionStatus);
  json += F("\",\"audioPlaying\":");
  json += mcuAudioPlaying ? F("true") : F("false");
  json += F(",\"queueLength\":");
  json += mcuAudioCount;
  json += F(",\"socketClients\":");
  json += mcuSocketNamespaceReady ? 1 : 0;
  json += F(",\"socketConnected\":");
  json += mcuSocketNamespaceReady ? F("true") : F("false");
  json += F(",\"active_device\":\"");
  json += escapeJson(activeDeviceKey);
  json += F("\",\"profile\":\"");
  json += escapeJson(selectedProfile);
  json += F("\",\"text\":\"");
  json += escapeJson(mcuInteractionText);
  json += F("\",\"tool\":\"");
  json += escapeJson(mcuToolName);
  json += F("\",\"toolStatus\":\"");
  json += escapeJson(mcuToolStatus);
  json += F("\"}");
  return json;
}

bool sendRawWsFrame(uint8_t opcode, const uint8_t *data, size_t length) {
  if (!mcuWsClient.connected()) return false;
  uint8_t header[14];
  size_t headerLen = 0;
  header[headerLen++] = 0x80 | (opcode & 0x0F);
  if (length < 126) {
    header[headerLen++] = 0x80 | static_cast<uint8_t>(length);
  } else if (length <= 0xFFFF) {
    header[headerLen++] = 0x80 | 126;
    header[headerLen++] = static_cast<uint8_t>((length >> 8) & 0xFF);
    header[headerLen++] = static_cast<uint8_t>(length & 0xFF);
  } else {
    return false;
  }

  uint8_t mask[4];
  for (uint8_t i = 0; i < 4; ++i) mask[i] = static_cast<uint8_t>(esp_random() & 0xFF);
  for (uint8_t i = 0; i < 4; ++i) header[headerLen++] = mask[i];
  if (mcuWsClient.write(header, headerLen) != headerLen) return false;

  constexpr size_t kChunk = 256;
  uint8_t buffer[kChunk];
  size_t offset = 0;
  while (offset < length) {
    size_t n = min(kChunk, length - offset);
    for (size_t i = 0; i < n; ++i) {
      buffer[i] = data[offset + i] ^ mask[(offset + i) & 3];
    }
    if (mcuWsClient.write(buffer, n) != n) return false;
    offset += n;
  }
  return true;
}

bool sendRawWsText(const String &payload) {
  return sendRawWsFrame(0x1, reinterpret_cast<const uint8_t *>(payload.c_str()), payload.length());
}

bool sendMcuSocketEvent(const String &event, const String &json) {
  if (!wsReady || !mcuSocketNamespaceReady || event.length() == 0) return false;
  String payload;
  payload.reserve(json.length() + event.length() + 28);
  payload += F("42/global-agent,[\"");
  payload += escapeJson(event);
  payload += F("\",");
  payload += json.length() > 0 ? json : String(F("{}"));
  payload += F("]");
  return sendRawWsText(payload);
}

bool sendMcuSocketJson(const String &json) {
  String type = jsonStringValue(json, F("type"));
  if (type.length() == 0) type = F("mcu.event");
  return sendMcuSocketEvent(type, json);
}

String base64Encode(const uint8_t *data, size_t length) {
  if (!data || length == 0) return "";
  size_t outputLength = 0;
  mbedtls_base64_encode(nullptr, 0, &outputLength, data, length);
  String output;
  output.reserve(outputLength + 1);
  char *buffer = new char[outputLength + 1];
  if (!buffer) return "";
  if (mbedtls_base64_encode(reinterpret_cast<unsigned char *>(buffer), outputLength + 1, &outputLength, data, length) != 0) {
    delete[] buffer;
    return "";
  }
  buffer[outputLength] = '\0';
  output = buffer;
  delete[] buffer;
  return output;
}

void sendWsJson(uint8_t, const String &json) {
  sendMcuSocketJson(json);
}

void broadcastMcuStatus() {
  sendMcuSocketJson(mcuStatusJson());
}

uint32_t mcuAudioDurationFor(const McuAudioSegment &segment) {
  if (segment.durationMs > 0) return min(segment.durationMs, kMcuAudioMaxDurationMs);
  uint32_t estimated = kMcuAudioDefaultDurationMs + static_cast<uint32_t>(segment.text.length()) * 45UL;
  return min(max(estimated, kMcuAudioDefaultDurationMs), kMcuAudioMaxDurationMs);
}

bool playPcmStereoStream(WiFiClient *stream, int contentLength, uint32_t sampleRate) {
  if (!stream || audioBusy || !i2sReady || !es8311Ready) {
    lastAudioDetail = F("audio stream is not ready");
    markMcuInteraction(mcuInteractionId, F("failed"), lastAudioDetail);
    return false;
  }

  audioBusy = true;
  setPowerAmp(true);
  es8311UpdateBits(0x31, 0x60, 0x00);
  setI2sSampleRate(sampleRate);

  constexpr size_t kChunkBytes = 1024;
  constexpr size_t kAudioFrameBytes = 4;
  uint8_t buffer[kChunkBytes + kAudioFrameBytes];
  size_t pendingBytes = 0;
  int remaining = contentLength;
  uint32_t streamBytes = 0;
  uint32_t playedBytes = 0;
  uint32_t paddedBytes = 0;
  uint32_t idleStarted = millis();

  while (remaining != 0) {
    if (shouldInterruptAudioForVoice()) {
      lastAudioDetail = F("audio interrupted by listen");
      audioBusy = false;
      return false;
    }
    int available = stream->available();
    if (available <= 0) {
      if (!stream->connected() && remaining < 0) break;
      if (millis() - idleStarted > kMcuAudioHttpTimeoutMs) {
        lastAudioDetail = F("audio stream timed out");
        audioBusy = false;
        markMcuInteraction(mcuInteractionId, F("failed"), lastAudioDetail);
        return false;
      }
      delay(10);
      yield();
      continue;
    }
    idleStarted = millis();

    size_t toRead = min(static_cast<size_t>(available), kChunkBytes);
    if (remaining > 0) toRead = min(toRead, static_cast<size_t>(remaining));
    int bytesRead = stream->readBytes(buffer + pendingBytes, toRead);
    if (bytesRead <= 0) continue;
    streamBytes += static_cast<uint32_t>(bytesRead);

    size_t bufferedBytes = pendingBytes + static_cast<size_t>(bytesRead);
    size_t alignedBytes = bufferedBytes - (bufferedBytes % kAudioFrameBytes);
    if (remaining > 0) remaining -= bytesRead;
    if (alignedBytes == 0) {
      pendingBytes = bufferedBytes;
      continue;
    }

    shapePcmBuffer(buffer, alignedBytes);
    size_t written = 0;
    esp_err_t err = i2s_write(kI2sPort, buffer, alignedBytes, &written, pdMS_TO_TICKS(1000));
    if (err != ESP_OK || written != alignedBytes) {
      lastAudioDetail = String(F("I2S write failed err=")) + String(static_cast<int>(err));
      audioBusy = false;
      markMcuInteraction(mcuInteractionId, F("failed"), lastAudioDetail);
      return false;
    }
    playedBytes += written;

    pendingBytes = bufferedBytes - alignedBytes;
    if (pendingBytes > 0) memmove(buffer, buffer + alignedBytes, pendingBytes);
    yield();
  }

  if (pendingBytes > 0) {
    paddedBytes = static_cast<uint32_t>(kAudioFrameBytes - pendingBytes);
    memset(buffer + pendingBytes, 0, paddedBytes);
    shapePcmBuffer(buffer, kAudioFrameBytes);
    size_t written = 0;
    esp_err_t err = i2s_write(kI2sPort, buffer, kAudioFrameBytes, &written, pdMS_TO_TICKS(1000));
    if (err != ESP_OK || written != kAudioFrameBytes) {
      lastAudioDetail = String(F("I2S final write failed err=")) + String(static_cast<int>(err));
      audioBusy = false;
      markMcuInteraction(mcuInteractionId, F("failed"), lastAudioDetail);
      return false;
    }
    playedBytes += written;
  }

  i2s_zero_dma_buffer(kI2sPort);
  lastAudioAtMs = millis();
  lastAudioDetail = String(F("pcm played bytes=")) + String(playedBytes) +
                    F(", stream bytes=") + String(streamBytes) +
                    F(", rate=") + String(sampleRate) +
                    F(", padded=") + String(paddedBytes);
  audioBusy = false;
  return playedBytes > 0;
}

bool playPcmMonoStream(WiFiClient *stream, int contentLength, uint32_t sampleRate) {
  if (!stream || audioBusy || !i2sReady || !es8311Ready) {
    lastAudioDetail = F("audio stream is not ready");
    markMcuInteraction(mcuInteractionId, F("failed"), lastAudioDetail);
    return false;
  }

  audioBusy = true;
  setPowerAmp(true);
  es8311UpdateBits(0x31, 0x60, 0x00);
  setI2sSampleRate(kAudioSampleRate);

  constexpr size_t kInputChunkBytes = 512;
  constexpr size_t kMonoFrameBytes = 2;
  uint8_t input[kInputChunkBytes + kMonoFrameBytes];
  int16_t stereo[(kInputChunkBytes / kMonoFrameBytes) * 2];
  size_t pendingBytes = 0;
  int remaining = contentLength;
  uint32_t streamBytes = 0;
  uint32_t playedBytes = 0;
  uint32_t paddedBytes = 0;
  uint32_t idleStarted = millis();

  while (remaining != 0) {
    if (shouldInterruptAudioForVoice()) {
      lastAudioDetail = F("audio interrupted by listen");
      audioBusy = false;
      return false;
    }
    int available = stream->available();
    if (available <= 0) {
      if (!stream->connected() && remaining < 0) break;
      if (millis() - idleStarted > kMcuAudioHttpTimeoutMs) {
        lastAudioDetail = F("audio stream timed out");
        audioBusy = false;
        markMcuInteraction(mcuInteractionId, F("failed"), lastAudioDetail);
        return false;
      }
      delay(10);
      yield();
      continue;
    }
    idleStarted = millis();

    size_t toRead = min(static_cast<size_t>(available), kInputChunkBytes);
    if (remaining > 0) toRead = min(toRead, static_cast<size_t>(remaining));
    int bytesRead = stream->readBytes(input + pendingBytes, toRead);
    if (bytesRead <= 0) continue;
    streamBytes += static_cast<uint32_t>(bytesRead);

    size_t bufferedBytes = pendingBytes + static_cast<size_t>(bytesRead);
    size_t alignedBytes = bufferedBytes - (bufferedBytes % kMonoFrameBytes);
    if (remaining > 0) remaining -= bytesRead;
    if (alignedBytes == 0) {
      pendingBytes = bufferedBytes;
      continue;
    }

    size_t frames = alignedBytes / kMonoFrameBytes;
    size_t outputFrames = 0;
    for (size_t i = 0; i < frames; ++i) {
      int16_t mono = static_cast<int16_t>(static_cast<uint16_t>(input[i * 2]) |
                                          (static_cast<uint16_t>(input[i * 2 + 1]) << 8));
      mono = shapeOutputSample(mono);
      stereo[outputFrames * 2] = mono;
      stereo[outputFrames * 2 + 1] = mono;
      ++outputFrames;
    }

    size_t bytesToWrite = outputFrames * 2 * sizeof(int16_t);
    size_t written = 0;
    esp_err_t err = i2s_write(kI2sPort, stereo, bytesToWrite, &written, pdMS_TO_TICKS(1000));
    if (err != ESP_OK || written != bytesToWrite) {
      lastAudioDetail = String(F("I2S mono write failed err=")) + String(static_cast<int>(err));
      audioBusy = false;
      markMcuInteraction(mcuInteractionId, F("failed"), lastAudioDetail);
      return false;
    }
    playedBytes += written;

    pendingBytes = bufferedBytes - alignedBytes;
    if (pendingBytes > 0) memmove(input, input + alignedBytes, pendingBytes);
    yield();
  }

  if (pendingBytes > 0) {
    input[pendingBytes] = 0;
    paddedBytes = 1;
    int16_t mono = static_cast<int16_t>(static_cast<uint16_t>(input[0]) |
                                        (static_cast<uint16_t>(input[1]) << 8));
    mono = shapeOutputSample(mono);
    stereo[0] = mono;
    stereo[1] = mono;
    size_t written = 0;
    esp_err_t err = i2s_write(kI2sPort, stereo, 2 * sizeof(int16_t), &written, pdMS_TO_TICKS(1000));
    if (err != ESP_OK || written != 2 * sizeof(int16_t)) {
      lastAudioDetail = String(F("I2S mono final write failed err=")) + String(static_cast<int>(err));
      audioBusy = false;
      markMcuInteraction(mcuInteractionId, F("failed"), lastAudioDetail);
      return false;
    }
    playedBytes += written;
  }

  i2s_zero_dma_buffer(kI2sPort);
  lastAudioAtMs = millis();
  lastAudioDetail = String(F("mono pcm played bytes=")) + String(playedBytes) +
                    F(", stream bytes=") + String(streamBytes) +
                    F(", rate=") + String(sampleRate) +
                    F(", padded=") + String(paddedBytes);
  audioBusy = false;
  return playedBytes > 0;
}

bool playRecordedWav(uint8_t *wav, size_t wavLen) {
  if (!wav || wavLen <= 44 || audioBusy || !i2sReady || !es8311Ready) {
    lastAudioDetail = F("recorded playback is not ready");
    return false;
  }

  audioBusy = true;
  setPowerAmp(true);
  es8311UpdateBits(0x31, 0x60, 0x00);
  setI2sSampleRate(kAudioSampleRate);
  setOledStatus(OledMode::Think, F("PLAY"), F("REC"), 0);

  uint32_t playedBytes = 0;
  const uint8_t *pcm = wav + 44;
  size_t remaining = wavLen - 44;
  constexpr size_t kFramesPerChunk = 256;
  int16_t stereo[kFramesPerChunk * 2];
  while (remaining >= 2) {
    size_t frames = min(kFramesPerChunk, remaining / 2);
    for (size_t i = 0; i < frames; ++i) {
      int16_t mono = static_cast<int16_t>(static_cast<uint16_t>(pcm[i * 2]) |
                                          (static_cast<uint16_t>(pcm[i * 2 + 1]) << 8));
      stereo[i * 2] = mono;
      stereo[i * 2 + 1] = mono;
    }

    size_t bytesToWrite = frames * 2 * sizeof(int16_t);
    size_t written = 0;
    esp_err_t err = i2s_write(kI2sPort, stereo, bytesToWrite, &written, pdMS_TO_TICKS(1000));
    if (err != ESP_OK || written != bytesToWrite) {
      audioBusy = false;
      lastAudioDetail = String(F("recorded playback write failed err=")) + String(static_cast<int>(err));
      setOledStatus(OledMode::Error, F("PLAY"), F("FAIL"), 0);
      return false;
    }

    playedBytes += written;
    pcm += frames * 2;
    remaining -= frames * 2;
    uint8_t progress = static_cast<uint8_t>(min<uint32_t>((playedBytes * 100UL) / (wavLen - 44), 100));
    setOledStatus(OledMode::Think, F("PLAY"), F("REC"), progress);
    yield();
  }

  i2s_zero_dma_buffer(kI2sPort);
  audioBusy = false;
  lastAudioAtMs = millis();
  lastAudioDetail = String(F("recorded playback bytes=")) + String(playedBytes);
  return playedBytes > 0;
}

bool playPcmUrl(const String &url, uint8_t channels, uint32_t sampleRate) {
  String scheme;
  String host;
  String path;
  uint16_t port = 80;
  if (!parseAudioUrl(url, &scheme, &host, &port, &path)) {
    lastAudioDetail = F("audio url must be http or https");
    markMcuInteraction(mcuInteractionId, F("failed"), lastAudioDetail);
    return false;
  }

  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  WiFiClient *client = &plainClient;
  if (scheme == F("https")) {
    secureClient.setInsecure();
    client = &secureClient;
  }
  client->setTimeout(kMcuAudioHttpTimeoutMs / 1000);
  if (!client->connect(host.c_str(), port)) {
    lastAudioDetail = String(F("cannot connect audio host ")) + host + F(":") + String(port);
    markMcuInteraction(mcuInteractionId, F("failed"), lastAudioDetail);
    return false;
  }

  client->print(F("GET "));
  client->print(path);
  client->print(F(" HTTP/1.1\r\nHost: "));
  client->print(host);
  client->print(F("\r\nConnection: close\r\nAccept: audio/x-pcm,application/octet-stream,*/*\r\n\r\n"));

  int statusCode = 0;
  int contentLength = -1;
  String contentType;
  if (!readHttpResponseHeaders(*client, &statusCode, &contentLength, &contentType)) {
    client->stop();
    return false;
  }
  if (statusCode < 200 || statusCode >= 300) {
    lastAudioDetail = String(F("audio HTTP ")) + statusCode;
    markMcuInteraction(mcuInteractionId, F("failed"), lastAudioDetail);
    client->stop();
    return false;
  }
  if (contentType.indexOf(F("mpeg")) >= 0 || contentType.indexOf(F("mp3")) >= 0) {
    lastAudioDetail = F("mp3 is not supported on MCU; send 24k PCM");
    markMcuInteraction(mcuInteractionId, F("failed"), lastAudioDetail);
    client->stop();
    return false;
  }

  uint32_t playbackRate = sampleRate > 0 ? sampleRate : kMcuAudioDefaultSampleRate;
  bool ok = channels == 1 ? playPcmMonoStream(client, contentLength, playbackRate)
                          : playPcmStereoStream(client, contentLength, playbackRate);
  client->stop();
  return ok;
}

void clearMcuAudioQueue() {
  for (int i = 0; i < kMaxMcuAudioQueue; ++i) {
    mcuAudioQueue[i] = McuAudioSegment();
  }
  mcuAudioHead = 0;
  mcuAudioCount = 0;
  mcuCurrentAudio = McuAudioSegment();
  mcuAudioPlaying = false;
  mcuAudioStartedAtMs = 0;
  mcuAudioDurationMs = 0;
}

bool broadcastMcuInterrupt(const String &interactionId, const String &reason) {
  if (!wsReady || !mcuSocketNamespaceReady) return false;
  String json;
  json.reserve(260);
  json += F("{\"type\":\"mcu.interrupt\",\"interactionId\":\"");
  json += escapeJson(interactionId.length() > 0 ? interactionId : mcuInteractionId);
  json += F("\",\"profile\":\"");
  json += escapeJson(selectedProfile);
  json += F("\",\"reason\":\"");
  json += escapeJson(reason);
  json += F("\"}");
  return sendMcuSocketJson(json);
}

bool broadcastMcuSessionClear(const String &interactionId) {
  if (!wsReady || !mcuSocketNamespaceReady) return false;
  String json;
  json.reserve(240);
  json += F("{\"type\":\"mcu.session.clear\",\"interactionId\":\"");
  json += escapeJson(interactionId);
  json += F("\",\"profile\":\"");
  json += escapeJson(selectedProfile);
  json += F("\"}");
  return sendMcuSocketJson(json);
}

void markMcuInteraction(const String &interactionId, const String &status, const String &text) {
  if (interactionId.length() > 0) mcuInteractionId = interactionId;
  if (status.length() > 0) mcuInteractionStatus = status;
  mcuInteractionText = compactDetail(text);
  mcuInteractionActive = true;
  mcuInteractionUpdatedAtMs = millis();
  if (mcuInteractionStatus == F("failed")) {
    setOledStatus(OledMode::Error, F("ERROR"), F("DETAIL"), 0);
  } else if (oledMode == OledMode::Error) {
    setOledStatus(OledMode::Think, interactionStatusLabel(), F(""), 0);
  }
  oledDirty = true;
}

bool shouldPreserveMcuToolStatus(const String &interactionId) {
  return mcuInteractionStatus == F("tool") && mcuToolName.length() > 0 &&
         (interactionId.length() == 0 || mcuInteractionId.length() == 0 || interactionId == mcuInteractionId);
}

void touchMcuInteraction(const String &interactionId) {
  if (interactionId.length() > 0) mcuInteractionId = interactionId;
  mcuInteractionActive = true;
  mcuInteractionUpdatedAtMs = millis();
  oledDirty = true;
}

void markMcuAudioSpeaking(const String &interactionId) {
  if (shouldPreserveMcuToolStatus(interactionId)) {
    touchMcuInteraction(interactionId);
    return;
  }
  markMcuInteraction(interactionId, F("speaking"), F(""));
}

void finishMcuAudio(bool interrupted) {
  if (!mcuAudioPlaying) return;
  String json;
  json.reserve(220);
  json += F("{\"type\":\"audio.");
  json += interrupted ? F("interrupted") : F("done");
  json += F("\",\"interactionId\":\"");
  json += escapeJson(mcuCurrentAudio.interactionId);
  json += F("\",\"segmentId\":\"");
  json += escapeJson(mcuCurrentAudio.segmentId);
  json += F("\"}");
  sendMcuSocketJson(json);

  mcuCurrentAudio = McuAudioSegment();
  mcuAudioPlaying = false;
  mcuAudioStartedAtMs = 0;
  mcuAudioDurationMs = 0;
  oledDirty = true;
}

void startNextMcuAudio() {
  if (mcuAudioPlaying || mcuAudioCount <= 0) return;
  mcuCurrentAudio = mcuAudioQueue[mcuAudioHead];
  mcuAudioQueue[mcuAudioHead] = McuAudioSegment();
  mcuAudioHead = (mcuAudioHead + 1) % kMaxMcuAudioQueue;
  --mcuAudioCount;

  mcuAudioPlaying = true;
  mcuAudioStartedAtMs = millis();
  mcuAudioDurationMs = mcuAudioDurationFor(mcuCurrentAudio);
  markMcuAudioSpeaking(mcuCurrentAudio.interactionId);

  String json;
  json.reserve(260);
  json += F("{\"type\":\"audio.started\",\"interactionId\":\"");
  json += escapeJson(mcuCurrentAudio.interactionId);
  json += F("\",\"segmentId\":\"");
  json += escapeJson(mcuCurrentAudio.segmentId);
  json += F("\",\"durationMs\":");
  json += mcuAudioDurationMs;
  json += F("}");
  sendMcuSocketJson(json);

  if (mcuCurrentAudio.url.length() > 0) {
    bool played = playPcmUrl(mcuCurrentAudio.url, mcuCurrentAudio.channels, mcuCurrentAudio.sampleRate);
    String interruptedInteractionId = mcuCurrentAudio.interactionId;
    bool completionManagedByServer = mcuCurrentAudio.completionManagedByServer;
    finishMcuAudio(!played);
    if (mcuSessionClearAfterAudioInterrupt) {
      mcuSessionClearAfterAudioInterrupt = false;
      mcuAudioStopOnlyAfterInterrupt = false;
      mcuVoiceAfterAudioInterrupt = false;
      clearMcuAudioQueue();
      clearMcuSessionByButton();
      return;
    }
    if (mcuVoiceAfterAudioInterrupt) {
      mcuVoiceAfterAudioInterrupt = false;
      broadcastMcuInterrupt(interruptedInteractionId, F("listen"));
      clearMcuAudioQueue();
      triggerBootVoiceTurn();
      return;
    }
    if (mcuAudioStopOnlyAfterInterrupt) {
      mcuAudioStopOnlyAfterInterrupt = false;
      broadcastMcuInterrupt(interruptedInteractionId, F("stop_audio"));
      clearMcuAudioQueue();
      markMcuInteraction(interruptedInteractionId, F("aborted"), F(""));
      broadcastMcuStatus();
      return;
    }
    if (played) {
      startNextMcuAudio();
      if (!completionManagedByServer && !mcuAudioPlaying && mcuAudioCount == 0) {
        markMcuInteraction(interruptedInteractionId, F("completed"), F(""));
        broadcastMcuStatus();
      }
    }
  }
}

bool enqueueMcuAudio(const McuAudioSegment &segment) {
  if (mcuAudioCount >= kMaxMcuAudioQueue) return false;
  int tail = (mcuAudioHead + mcuAudioCount) % kMaxMcuAudioQueue;
  mcuAudioQueue[tail] = segment;
  ++mcuAudioCount;
  markMcuAudioSpeaking(segment.interactionId);
  startNextMcuAudio();
  return true;
}

void handleMcuInteractionStatus(uint8_t clientId, const String &message) {
  String interactionId = jsonStringValue(message, F("interactionId"));
  String status = jsonStringValue(message, F("status"));
  String text = jsonStringValue(message, F("text"));
  if (status.length() == 0) status = F("thinking");
  if (status == F("speaking") && shouldPreserveMcuToolStatus(interactionId)) {
    touchMcuInteraction(interactionId);
  } else {
    if (status != F("tool")) {
      mcuToolName = "";
      mcuToolPreview = "";
      mcuToolStatus = "";
    }
    markMcuInteraction(interactionId, status, text);
  }
  sendWsJson(clientId, String(F("{\"type\":\"interaction.status.ack\",\"ok\":true,\"status\":\"")) +
                         escapeJson(status) + F("\"}"));
  broadcastMcuStatus();
}

void handleMcuToolEvent(uint8_t clientId, const String &message, const String &type) {
  String interactionId = jsonStringValue(message, F("interactionId"));
  mcuToolName = jsonStringValue(message, F("tool"));
  if (mcuToolName.length() == 0) mcuToolName = jsonStringValue(message, F("name"));
  if (mcuToolName.length() == 0) mcuToolName = F("tool");
  mcuToolPreview = jsonStringValue(message, F("preview"));
  String error = jsonStringValue(message, F("error"));
  if (type == F("tool.completed")) {
    mcuToolStatus = error.length() > 0 ? F("ERROR") : F("DONE");
  } else {
    mcuToolStatus = F("START");
  }
  markMcuInteraction(interactionId, F("tool"), F(""));
  sendWsJson(clientId, String(F("{\"type\":\"")) + escapeJson(type) + F(".ack\",\"ok\":true,\"tool\":\"") +
                         escapeJson(mcuToolName) + F("\"}"));
  broadcastMcuStatus();
}

void handleMcuAudioClear(uint8_t clientId, const String &message) {
  String interactionId = jsonStringValue(message, F("interactionId"));
  if (mcuAudioPlaying) finishMcuAudio(true);
  clearMcuAudioQueue();
  broadcastMcuInterrupt(interactionId, F("audio_clear"));
  markMcuInteraction(interactionId, F("aborted"), F(""));
  sendWsJson(clientId, String(F("{\"type\":\"audio.cleared\",\"interactionId\":\"")) +
                         escapeJson(mcuInteractionId) + F("\"}"));
  broadcastMcuStatus();
}

void stopMcuAudioQueueByButton() {
  String interactionId = mcuCurrentAudio.interactionId.length() > 0 ? mcuCurrentAudio.interactionId : mcuInteractionId;
  if (interactionId.length() == 0) interactionId = String(F("mcu-stop-")) + millis();
  if (mcuAudioPlaying) finishMcuAudio(true);
  clearMcuAudioQueue();
  mcuVoiceAfterAudioInterrupt = false;
  mcuAudioStopOnlyAfterInterrupt = false;
  mcuSessionClearAfterAudioInterrupt = false;
  broadcastMcuInterrupt(interactionId, F("button"));
  markMcuInteraction(interactionId, F("aborted"), F(""));
  broadcastMcuStatus();
}

void clearMcuSessionByButton() {
  String interactionId = String(F("mcu-clear-")) + millis();
  if (!wifiReady || WiFi.status() != WL_CONNECTED) {
    setOledStatus(OledMode::Error, F("WIFI"), F("OFFLINE"), 0);
    Serial.println(F("Session clear failed: WIFI OFFLINE"));
    return;
  }
  if (activeDeviceUrl.length() == 0 || mcuAuthToken.length() == 0) {
    markMcuInteraction(interactionId, F("failed"), F("NO DEVICE"));
    Serial.println(F("Session clear failed: NO DEVICE"));
    enqueueNoDevicePrompt(interactionId);
    return;
  }
  if (selectedProfile.length() == 0) {
    markMcuInteraction(interactionId, F("failed"), F("NO PROFILE"));
    Serial.println(F("Session clear failed: NO PROFILE"));
    broadcastMcuStatus();
    return;
  }
  if (!waitForMcuSocketReady(8000)) {
    markMcuInteraction(interactionId, F("failed"), F("SOCKET OFF"));
    Serial.printf("Session clear failed: SOCKET OFF activeUrl=%s token=%d profile=%s connected=%d namespace=%d\n",
                  activeDeviceUrl.c_str(), mcuAuthToken.length() > 0 ? 1 : 0, selectedProfile.c_str(),
                  mcuSocketConnected ? 1 : 0, mcuSocketNamespaceReady ? 1 : 0);
    broadcastMcuStatus();
    return;
  }
  if (mcuAudioPlaying) finishMcuAudio(true);
  clearMcuAudioQueue();
  mcuVoiceAfterAudioInterrupt = false;
  mcuAudioStopOnlyAfterInterrupt = false;
  mcuSessionClearAfterAudioInterrupt = false;
  broadcastMcuInterrupt(interactionId, F("session_clear"));
  if (!broadcastMcuSessionClear(interactionId)) {
    markMcuInteraction(interactionId, F("failed"), F("SOCKET OFF"));
    Serial.println(F("Session clear failed: send failed"));
    broadcastMcuStatus();
    return;
  }
  markMcuInteraction(interactionId, F("thinking"), F("SESSION CLEAR"));
  broadcastMcuStatus();
}

void handleMcuSessionCleared(uint8_t clientId, const String &message) {
  String interactionId = jsonStringValue(message, F("interactionId"));
  int deleted = jsonIntValue(message, F("deleted"));
  markMcuInteraction(interactionId, F("completed"), String(F("SESSION CLEAR ")) + deleted);
  sendWsJson(clientId, String(F("{\"type\":\"mcu.session.cleared.ack\",\"ok\":true}")));
  broadcastMcuStatus();
}

void handleMcuAudioEnqueue(uint8_t clientId, const String &message) {
  McuAudioSegment segment;
  segment.interactionId = jsonStringValue(message, F("interactionId"));
  if (segment.interactionId.length() == 0) segment.interactionId = mcuInteractionId;
  segment.segmentId = jsonStringValue(message, F("segmentId"));
  if (segment.segmentId.length() == 0) segment.segmentId = String(F("seg-")) + millis();
  segment.text = compactDetail(jsonStringValue(message, F("text")));
  segment.url = jsonStringValue(message, F("url"));
  segment.mimeType = jsonStringValue(message, F("mimeType"));
  int channels = jsonIntValue(message, F("channels"));
  segment.channels = channels == 1 ? 1 : 2;
  int sampleRate = jsonIntValue(message, F("sampleRate"));
  segment.sampleRate = sampleRate > 0 ? static_cast<uint32_t>(sampleRate) : kMcuAudioDefaultSampleRate;
  segment.durationMs = static_cast<uint32_t>(jsonIntValue(message, F("durationMs")));
  segment.completionManagedByServer = jsonBoolValue(message, F("completionManagedByServer"));

  bool queued = enqueueMcuAudio(segment);
  String json;
  json.reserve(220);
  json += F("{\"type\":\"");
  json += queued ? F("audio.queued") : F("audio.dropped");
  json += F("\",\"ok\":");
  json += queued ? F("true") : F("false");
  json += F(",\"interactionId\":\"");
  json += escapeJson(segment.interactionId);
  json += F("\",\"segmentId\":\"");
  json += escapeJson(segment.segmentId);
  json += F("\",\"queueLength\":");
  json += mcuAudioCount;
  json += F("}");
  sendWsJson(clientId, json);
  broadcastMcuStatus();
}

void handleMcuWebSocketText(uint8_t clientId, const String &message) {
  String type = jsonStringValue(message, F("type"));
  if (type == F("mcu.auth")) {
    sendWsJson(clientId, String(F("{\"type\":\"mcu.auth.ok\",\"ok\":true,\"id\":\"")) +
                           escapeJson(deviceId()) + F("\"}"));
    sendWsJson(clientId, mcuStatusJson());
    return;
  }
  if (type == F("interaction.status")) {
    handleMcuInteractionStatus(clientId, message);
    return;
  }
  if (type == F("tool.started") || type == F("tool.completed")) {
    handleMcuToolEvent(clientId, message, type);
    return;
  }
  if (type == F("audio.clear")) {
    handleMcuAudioClear(clientId, message);
    return;
  }
  if (type == F("mcu.session.cleared")) {
    handleMcuSessionCleared(clientId, message);
    return;
  }
  if (type == F("audio.enqueue")) {
    handleMcuAudioEnqueue(clientId, message);
    return;
  }
  if (type == F("mcu.status.get")) {
    sendWsJson(clientId, mcuStatusJson());
    return;
  }
  sendWsJson(clientId, String(F("{\"type\":\"mcu.unknown\",\"ok\":false,\"received\":\"")) +
                           escapeJson(type) + F("\"}"));
}

void enqueueMissingSttPrompt(const String &interactionId) {
  clearMcuAudioQueue();
  McuAudioSegment segment;
  segment.interactionId = interactionId.length() > 0 ? interactionId : String(F("missing-stt"));
  segment.segmentId = String(F("missing-stt-")) + millis();
  segment.text = F("当前profile没有配置语音转文字，请配置后再使用哦");
  segment.url = kMissingSttPromptPcmUrl;
  segment.mimeType = F("audio/x-pcm");
  segment.channels = 1;
  segment.sampleRate = kMcuAudioDefaultSampleRate;
  enqueueMcuAudio(segment);
}

void enqueueNoDevicePrompt(const String &interactionId) {
  Serial.printf("Enqueue no-device prompt interaction=%s heap=%lu socket=%d\n",
                interactionId.c_str(), static_cast<unsigned long>(ESP.getFreeHeap()),
                mcuSocketNamespaceReady ? 1 : 0);
  clearMcuAudioQueue();
  McuAudioSegment segment;
  segment.interactionId = interactionId.length() > 0 ? interactionId : String(F("no-device"));
  segment.segmentId = String(F("no-device-")) + millis();
  segment.text = F("你当前没有连接的设备哦，请到网页上连接设备");
  segment.url = kNoDevicePromptPcmUrl;
  segment.mimeType = F("audio/x-pcm");
  segment.channels = 1;
  segment.sampleRate = kMcuAudioDefaultSampleRate;
  enqueueMcuAudio(segment);
}

bool hasMcuSocketTarget() {
  return wsReady && mcuSocketNamespaceReady;
}

String activeVoiceTurnEndpoint() {
  String endpoint = activeDeviceUrl;
  endpoint.trim();
  while (endpoint.endsWith("/")) endpoint.remove(endpoint.length() - 1);
  if (endpoint.length() == 0) return "";
  endpoint += F("/api/hermes/mcu/voice-turn");
  return endpoint;
}

bool postMcuVoiceTurn(const String &interactionId, uint8_t *wav, size_t wavLen, String *response, int *statusCode) {
  if (response) *response = "";
  if (statusCode) *statusCode = 0;
  if (!wav || wavLen == 0) return false;

  String endpoint = activeVoiceTurnEndpoint();
  if (endpoint.length() == 0 || mcuAuthToken.length() == 0) {
    lastAudioDetail = F("missing MCU login target");
    return false;
  }

  HTTPClient http;
  http.setTimeout(kMcuAudioHttpTimeoutMs);
  if (!http.begin(endpoint)) {
    lastAudioDetail = F("cannot open voice endpoint");
    return false;
  }
  http.addHeader(F("Content-Type"), F("audio/wav"));
  http.addHeader(F("Authorization"), String(F("Bearer ")) + mcuAuthToken);
  if (interactionId.length() > 0) {
    http.addHeader(F("X-Hermes-Mcu-Interaction-Id"), interactionId);
  }
  http.addHeader(F("X-Hermes-Mcu-Device-Id"), deviceId());
  if (selectedProfile.length() > 0) {
    http.addHeader(F("X-Hermes-Profile"), selectedProfile);
  }

  int code = http.POST(wav, wavLen);
  String body = http.getString();
  http.end();

  if (response) *response = body;
  if (statusCode) *statusCode = code;
  bool ok = code >= 200 && code < 300;
  if (!ok) {
    lastAudioDetail = httpFailureDetail(code, body);
    if (code == 400) {
      lastAudioDetail += F(" rms=");
      lastAudioDetail += String(voiceRecordRms);
      lastAudioDetail += F(" peak=");
      lastAudioDetail += String(voiceRecordPeak);
    }
  }
  return ok;
}

String activeDeviceEndpoint(const __FlashStringHelper *path) {
  String endpoint = activeDeviceUrl;
  endpoint.trim();
  while (endpoint.endsWith("/")) endpoint.remove(endpoint.length() - 1);
  if (endpoint.length() == 0) return "";
  endpoint += path;
  return endpoint;
}

String activeDeviceEndpoint(const char *path) {
  String endpoint = activeDeviceUrl;
  endpoint.trim();
  while (endpoint.endsWith("/")) endpoint.remove(endpoint.length() - 1);
  if (endpoint.length() == 0) return "";
  endpoint += path;
  return endpoint;
}

bool downloadAndApplyMcuFirmware(const String &url, const String &md5, int expectedSize) {
  if (url.length() == 0 || mcuAuthToken.length() == 0 || expectedSize <= 0) return false;

  HTTPClient http;
  http.setTimeout(30000);
  if (!http.begin(url)) {
    Serial.println(F("MCU OTA failed: cannot open firmware URL"));
    return false;
  }
  http.addHeader(F("Authorization"), String(F("Bearer ")) + mcuAuthToken);

  int code = http.GET();
  if (code < 200 || code >= 300) {
    Serial.printf("MCU OTA failed: firmware HTTP %d\n", code);
    http.end();
    return false;
  }

  int contentLength = http.getSize();
  if (contentLength <= 0) contentLength = expectedSize;
  if (contentLength != expectedSize) {
    Serial.printf("MCU OTA failed: size mismatch manifest=%d http=%d\n", expectedSize, contentLength);
    http.end();
    return false;
  }

  WiFiClient *stream = http.getStreamPtr();
  if (!Update.begin(static_cast<size_t>(expectedSize))) {
    Serial.printf("MCU OTA failed: Update.begin error=%s\n", Update.errorString());
    http.end();
    return false;
  }
  if (md5.length() == 32) {
    Update.setMD5(md5.c_str());
  }

  setOledStatus(OledMode::Think, F("OTA"), F("UPDATE"), 10);
  size_t written = Update.writeStream(*stream);
  bool ok = written == static_cast<size_t>(expectedSize) && Update.end() && Update.isFinished();
  http.end();
  if (!ok) {
    Serial.printf("MCU OTA failed: written=%u expected=%d error=%s\n",
                  static_cast<unsigned>(written), expectedSize, Update.errorString());
    Update.abort();
    setOledStatus(OledMode::Error, F("OTA"), F("FAIL"), 0);
    return false;
  }

  Serial.printf("MCU OTA applied bytes=%u md5=%s\n", static_cast<unsigned>(written), md5.c_str());
  setOledStatus(OledMode::Ready, F("OTA"), F("RESTART"), 100);
  delay(500);
  ESP.restart();
  return true;
}

McuOtaResult checkMcuFirmwareUpdate(bool force, bool applyUpdate, String *outFirmwareUrl, String *outMd5, int *outSize) {
  if (!wifiReady || WiFi.status() != WL_CONNECTED || activeDeviceUrl.length() == 0 || mcuAuthToken.length() == 0) {
    return McuOtaResult::Failed;
  }
  if (!force && (audioBusy || mcuAudioPlaying || mcuInteractionStatus == F("listening") || mcuInteractionStatus == F("transcribing"))) {
    return McuOtaResult::Failed;
  }

  String endpoint = activeDeviceEndpoint(F("/api/hermes/mcu/firmware/manifest"));
  if (endpoint.length() == 0) return McuOtaResult::Failed;

  HTTPClient http;
  http.setTimeout(12000);
  if (!http.begin(endpoint)) return McuOtaResult::Failed;
  http.addHeader(F("Authorization"), String(F("Bearer ")) + mcuAuthToken);
  int code = http.GET();
  String body = http.getString();
  http.end();
  if (code == 404) {
    Serial.println(F("MCU OTA manifest not available"));
    return McuOtaResult::NoUpdate;
  }
  if (code < 200 || code >= 300) {
    Serial.printf("MCU OTA manifest HTTP %d\n", code);
    return McuOtaResult::Failed;
  }

  String md5 = jsonStringValue(body, F("md5"));
  String firmwarePath = jsonStringValue(body, F("url"));
  int size = jsonIntValue(body, F("size"));
  if (md5.length() != 32 || firmwarePath.length() == 0 || size <= 0) {
    Serial.println(F("MCU OTA manifest missing md5/url/size"));
    return McuOtaResult::Failed;
  }

  String currentMd5 = ESP.getSketchMD5();
  if (currentMd5.equalsIgnoreCase(md5)) {
    Serial.printf("MCU OTA already current md5=%s\n", currentMd5.c_str());
    return McuOtaResult::NoUpdate;
  }

  String firmwareUrl = firmwarePath;
  if (firmwareUrl.startsWith(F("/"))) {
    firmwareUrl = activeDeviceEndpoint(firmwarePath.c_str());
  }
  if (outFirmwareUrl) *outFirmwareUrl = firmwareUrl;
  if (outMd5) *outMd5 = md5;
  if (outSize) *outSize = size;
  Serial.printf("MCU OTA update available current=%s next=%s size=%d\n", currentMd5.c_str(), md5.c_str(), size);
  if (!applyUpdate) return McuOtaResult::UpdateAvailable;
  return downloadAndApplyMcuFirmware(firmwareUrl, md5, size) ? McuOtaResult::Updated : McuOtaResult::Failed;
}

bool broadcastMcuVoiceWav(const String &interactionId, const uint8_t *wav, size_t wavLen) {
  if (!wsReady || !mcuSocketNamespaceReady || !wav || wavLen == 0) return false;
  String json;
  json.reserve(260);
  json += F("{\"type\":\"voice.recorded\",\"interactionId\":\"");
  json += escapeJson(interactionId);
  json += F("\",\"mimeType\":\"audio/wav\",\"bytes\":");
  json += wavLen;
  json += F(",\"rms\":");
  json += voiceRecordRms;
  json += F(",\"peak\":");
  json += voiceRecordPeak;
  json += F("}");
  bool sent = sendMcuSocketJson(json);
  Serial.printf("MCU voice websocket metadata bytes=%u sent=%s socket=%d\n",
                static_cast<unsigned>(wavLen), sent ? "true" : "false", mcuSocketNamespaceReady ? 1 : 0);
  return sent;
}

bool broadcastMcuVoiceStreamStart(const String &interactionId) {
  if (!wsReady || !mcuSocketNamespaceReady) {
    Serial.printf("Voice stream start blocked ws=%d namespace=%d token=%d\n",
                  wsReady ? 1 : 0, mcuSocketNamespaceReady ? 1 : 0, mcuAuthToken.length() > 0 ? 1 : 0);
    return false;
  }
  String json;
  json.reserve(280);
  json += F("{\"type\":\"voice.stream.start\",\"interactionId\":\"");
  json += escapeJson(interactionId);
  json += F("\",\"mimeType\":\"audio/pcm\",\"sampleRate\":");
  json += kAudioSampleRate;
  json += F(",\"channels\":1,\"bitsPerSample\":16,\"profile\":\"");
  json += escapeJson(selectedProfile);
  json += F("\"}");
  return sendMcuSocketJson(json);
}

bool broadcastMcuVoiceStreamEnd(const String &interactionId, uint32_t dataBytes) {
  if (!wsReady || !mcuSocketNamespaceReady) return false;
  String json;
  json.reserve(300);
  json += F("{\"type\":\"voice.stream.end\",\"interactionId\":\"");
  json += escapeJson(interactionId);
  json += F("\",\"bytes\":");
  json += dataBytes;
  json += F(",\"rms\":");
  json += voiceRecordRms;
  json += F(",\"peak\":");
  json += voiceRecordPeak;
  json += F(",\"active\":");
  json += voiceRecordActiveSamples;
  json += F("}");
  return sendMcuSocketJson(json);
}

bool broadcastMcuVoiceStreamChunk(const String &interactionId, const uint8_t *data, size_t length, uint32_t offset) {
  if (!wsReady || !mcuSocketNamespaceReady || !data || length == 0) {
    Serial.printf("Voice stream chunk blocked ws=%d namespace=%d data=%d len=%u offset=%lu\n",
                  wsReady ? 1 : 0, mcuSocketNamespaceReady ? 1 : 0, data ? 1 : 0,
                  static_cast<unsigned>(length), static_cast<unsigned long>(offset));
    return false;
  }
  String encoded = base64Encode(data, length);
  if (encoded.length() == 0) {
    Serial.printf("Voice stream chunk base64 failed len=%u offset=%lu heap=%lu\n",
                  static_cast<unsigned>(length), static_cast<unsigned long>(offset),
                  static_cast<unsigned long>(ESP.getFreeHeap()));
    return false;
  }
  String json;
  json.reserve(encoded.length() + 260);
  json += F("{\"type\":\"voice.stream.chunk\",\"interactionId\":\"");
  json += escapeJson(interactionId);
  json += F("\",\"offset\":");
  json += offset;
  json += F(",\"bytes\":");
  json += length;
  json += F(",\"data\":\"");
  json += encoded;
  json += F("\"}");
  bool sent = sendMcuSocketJson(json);
  if (!sent) {
    Serial.printf("Voice stream chunk send failed len=%u encoded=%u offset=%lu heap=%lu ws=%d namespace=%d\n",
                  static_cast<unsigned>(length), static_cast<unsigned>(encoded.length()),
                  static_cast<unsigned long>(offset), static_cast<unsigned long>(ESP.getFreeHeap()),
                  wsReady ? 1 : 0, mcuSocketNamespaceReady ? 1 : 0);
  }
  mcuSocketLoop();
  yield();
  return sent;
}

bool recordAndBroadcastMcuVoiceStream(const String &interactionId) {
  if (audioBusy) {
    lastAudioDetail = F("audio busy before record");
    setOledStatus(OledMode::Think, F("BUSY"), F("AUDIO"), 50);
    return false;
  }
  if (!i2sReady || !es8311Ready) {
    lastAudioDetail = F("audio input is not ready");
    setOledStatus(OledMode::Error, F("AUDIO"), F("INPUT OFF"), 0);
    return false;
  }
  if (!broadcastMcuVoiceStreamStart(interactionId)) {
    lastAudioDetail = F("voice stream start failed");
    return false;
  }

  audioBusy = true;
  setPowerAmp(false);
  es8311UpdateBits(0x31, 0x60, 0x60);
  setI2sSampleRate(kAudioSampleRate);
  i2s_zero_dma_buffer(kI2sPort);
  setOledStatus(OledMode::Think, F("LISTEN"), F("SAY NOW"), 0);

  constexpr size_t kReadBytes = 512;
  constexpr size_t kPcmChunkFrames = 512;
  uint8_t readBuffer[kReadBytes];
  int16_t pcmChunk[kPcmChunkFrames];
  size_t pcmChunkFrames = 0;
  uint32_t framesDone = 0;
  uint32_t emptyReads = 0;
  uint16_t leftPeak = 0;
  uint16_t rightPeak = 0;
  uint16_t monoPeak = 0;
  uint64_t monoSquares = 0;
  uint32_t activeSamples = 0;
  uint32_t sentBytes = 0;
  const char *stopReason = "max";
  voiceRecordHeardSpeech = false;
  voiceRecordRms = 0;
  voiceRecordPeak = 0;
  voiceRecordActiveSamples = 0;
  const uint32_t maxFrames = (kAudioSampleRate * kVoiceStreamRecordMs) / 1000UL;
  const uint32_t startedAt = millis();
  uint32_t releaseStartedAt = 0;
  uint32_t lastRecordOledAtMs = startedAt;
  uint8_t lastRecordProgress = 0;

  auto flushPcmChunk = [&]() -> bool {
    if (pcmChunkFrames == 0) return true;
    size_t bytes = pcmChunkFrames * sizeof(int16_t);
    uint32_t offset = sentBytes;
    if (!broadcastMcuVoiceStreamChunk(interactionId, reinterpret_cast<const uint8_t *>(pcmChunk), bytes, offset)) {
      return false;
    }
    sentBytes += static_cast<uint32_t>(bytes);
    pcmChunkFrames = 0;
    return true;
  };

  while (framesDone < maxFrames) {
    uint32_t loopNow = millis();
    if (loopNow - startedAt > kVoiceRecordHardTimeoutMs) {
      stopReason = "timeout";
      lastAudioDetail = String(F("voice stream timeout frames=")) + String(framesDone) +
                        F(", empty=") + String(emptyReads);
      break;
    }
    if (framesDone > 0 && loopNow - startedAt > kBootDebounceMs) {
      if (digitalRead(kPinBoot) != LOW) {
        if (releaseStartedAt == 0) releaseStartedAt = loopNow;
        if (loopNow - releaseStartedAt >= kBootDebounceMs) {
          stopReason = "release";
          break;
        }
      } else {
        releaseStartedAt = 0;
      }
    }
    size_t bytesRead = 0;
    esp_err_t err = i2s_read(kI2sPort, readBuffer, sizeof(readBuffer), &bytesRead, pdMS_TO_TICKS(40));
    if (err != ESP_OK) {
      audioBusy = false;
      lastAudioDetail = String(F("I2S stream read failed err=")) + String(static_cast<int>(err));
      setOledStatus(OledMode::Error, F("I2S"), F("READ FAIL"), 0);
      return false;
    }
    if (bytesRead == 0) {
      ++emptyReads;
      setOledStatus(OledMode::Think, F("LISTEN"), F("WAIT I2S"), 5);
      yield();
      continue;
    }

    int16_t *samples = reinterpret_cast<int16_t *>(readBuffer);
    size_t count = bytesRead / sizeof(int16_t);
    for (size_t i = 0; i + 1 < count && framesDone < maxFrames; i += 2) {
      int16_t left = samples[i];
      int16_t right = samples[i + 1];
      uint16_t leftMag = sampleMagnitude(left);
      uint16_t rightMag = sampleMagnitude(right);
      if (leftMag > leftPeak) leftPeak = leftMag;
      if (rightMag > rightPeak) rightPeak = rightMag;

      int16_t mono = voiceInputMonoSample(left, right);
      uint16_t monoMag = sampleMagnitude(mono);
      if (monoMag > monoPeak) monoPeak = monoMag;
      monoSquares += static_cast<uint64_t>(monoMag) * static_cast<uint64_t>(monoMag);
      if (monoMag >= kVoiceVadActiveThreshold) ++activeSamples;
      pcmChunk[pcmChunkFrames++] = mono;
      ++framesDone;

      if (pcmChunkFrames >= kPcmChunkFrames && !flushPcmChunk()) {
        audioBusy = false;
        lastAudioDetail = F("voice stream chunk send failed");
        return false;
      }
    }

    uint8_t progress = static_cast<uint8_t>(min<uint32_t>((framesDone * 100UL) / maxFrames, 100));
    uint32_t now = millis();
    if (progress != lastRecordProgress && now - lastRecordOledAtMs >= 250) {
      lastRecordProgress = progress;
      lastRecordOledAtMs = now;
      setOledStatus(OledMode::Think, F("LISTEN"), F("RECORDING"), progress);
    }
    yield();
  }

  if (!flushPcmChunk()) {
    audioBusy = false;
    lastAudioDetail = F("voice stream final send failed");
    return false;
  }

  audioBusy = false;
  if (sentBytes == 0) {
    lastAudioDetail = String(F("voice stream empty, i2s empty reads=")) + String(emptyReads);
    setOledStatus(OledMode::Error, F("MIC"), F("NO DATA"), 0);
    return false;
  }

  voiceRecordPeak = monoPeak;
  voiceRecordRms = framesDone > 0 ? static_cast<uint32_t>(sqrt(static_cast<double>(monoSquares) / framesDone)) : 0;
  voiceRecordActiveSamples = activeSamples;
  voiceRecordHeardSpeech = voiceRecordRms >= kVoiceVadRmsStart &&
                            voiceRecordPeak >= kVoiceVadPeakStart &&
                            voiceRecordActiveSamples >= kVoiceVadMinActiveSamples;
  lastAudioDetail = String(F("voice pcm bytes=")) + String(sentBytes) +
                    F(", frames=") + String(framesDone) +
                    F(", rms=") + String(voiceRecordRms) +
                    F(", peak=") + String(voiceRecordPeak) +
                    F(", active=") + String(voiceRecordActiveSamples);
  Serial.printf("Voice stream frames=%lu bytes=%lu stop=%s peak L/R/M=%u/%u/%u rms=%lu active=%lu vad=%s\n",
                static_cast<unsigned long>(framesDone), static_cast<unsigned long>(sentBytes), stopReason,
                leftPeak, rightPeak, monoPeak, static_cast<unsigned long>(voiceRecordRms),
                static_cast<unsigned long>(voiceRecordActiveSamples), voiceRecordHeardSpeech ? "true" : "false");
  broadcastMcuVoiceStreamEnd(interactionId, sentBytes);
  return true;
}

bool waitForMcuSocketReady(uint32_t timeoutMs) {
  if (mcuSocketNamespaceReady) return true;
  uint32_t startedAt = millis();
  uint32_t lastConnectAttemptAt = 0;
  while (!mcuSocketNamespaceReady && millis() - startedAt < timeoutMs) {
    if ((!wsReady || !mcuSocketConnected) && millis() - lastConnectAttemptAt >= 500) {
      connectMcuSocketClient();
      lastConnectAttemptAt = millis();
    }
    mcuSocketLoop();
    delay(20);
    yield();
  }
  return mcuSocketNamespaceReady;
}

void handleVoiceTurnResponse(const String &interactionId, const String &response, int statusCode) {
  if (statusCode < 200 || statusCode >= 300) {
    markMcuInteraction(interactionId, F("failed"), String(F("HTTP ")) + statusCode);
    broadcastMcuStatus();
    return;
  }

  if (jsonBoolValue(response, F("accepted"))) {
    return;
  }

  String audioPayload = jsonObjectValue(response, F("audio"));
  String audioUrl = jsonStringValue(response, F("url"));
  if (audioUrl.length() == 0 && audioPayload.length() > 0) {
    audioUrl = jsonStringValue(audioPayload, F("url"));
  }
  if (audioUrl.length() > 0) {
    clearMcuAudioQueue();
    McuAudioSegment segment;
    segment.interactionId = interactionId;
    segment.segmentId = String(F("voice-")) + millis();
    segment.text = compactDetail(jsonStringValue(response, F("text")));
    if (segment.text.length() == 0 && audioPayload.length() > 0) {
      segment.text = compactDetail(jsonStringValue(audioPayload, F("text")));
    }
    if (segment.text.length() == 0) segment.text = F("语音提示");
    segment.url = audioUrl;
    segment.mimeType = jsonStringValue(response, F("mimeType"));
    if (segment.mimeType.length() == 0 && audioPayload.length() > 0) {
      segment.mimeType = jsonStringValue(audioPayload, F("mimeType"));
    }
    int channels = jsonIntValue(response, F("channels"));
    if (channels == 0 && audioPayload.length() > 0) channels = jsonIntValue(audioPayload, F("channels"));
    segment.channels = channels == 1 ? 1 : 2;
    int sampleRate = jsonIntValue(response, F("sampleRate"));
    if (sampleRate == 0 && audioPayload.length() > 0) sampleRate = jsonIntValue(audioPayload, F("sampleRate"));
    segment.sampleRate = sampleRate > 0 ? static_cast<uint32_t>(sampleRate) : kMcuAudioDefaultSampleRate;
    enqueueMcuAudio(segment);
    return;
  }

  String transcript = compactDetail(jsonStringValue(response, F("transcript")));
  if (transcript.length() > 0) {
    markMcuInteraction(interactionId, F("completed"), transcript);
    broadcastMcuStatus();
    return;
  }

  markMcuInteraction(interactionId, F("failed"), F("empty voice response"));
  broadcastMcuStatus();
}

void triggerBootVoiceTurn() {
  Serial.printf("Voice trigger wifi=%d status=%d activeUrl=%s token=%d profile=%s socket=%d audioBusy=%d playing=%d heap=%lu\n",
                wifiReady ? 1 : 0, static_cast<int>(WiFi.status()), activeDeviceUrl.c_str(),
                mcuAuthToken.length() > 0 ? 1 : 0, selectedProfile.c_str(), mcuSocketNamespaceReady ? 1 : 0,
                audioBusy ? 1 : 0, mcuAudioPlaying ? 1 : 0, static_cast<unsigned long>(ESP.getFreeHeap()));
  if (!wifiReady || WiFi.status() != WL_CONNECTED) {
    setOledStatus(OledMode::Error, F("WIFI"), F("OFFLINE"), 0);
    Serial.println(F("Voice trigger failed: WIFI OFFLINE"));
    return;
  }

  String interruptedInteractionId = mcuInteractionId;
  if (mcuAudioPlaying) {
    finishMcuAudio(true);
    clearMcuAudioQueue();
  } else if (audioBusy) {
    setOledStatus(OledMode::Think, F("BUSY"), F("AUDIO"), 50);
    Serial.println(F("Voice trigger ignored: AUDIO BUSY"));
    return;
  }
  if (mcuInteractionActive && interruptedInteractionId.length() > 0) {
    broadcastMcuInterrupt(interruptedInteractionId, F("listen"));
  }

  String interactionId = String(F("mcu-voice-")) + millis();
  if (activeDeviceUrl.length() == 0 || mcuAuthToken.length() == 0) {
    markMcuInteraction(interactionId, F("failed"), F("NO DEVICE"));
    Serial.println(F("Voice trigger failed: NO DEVICE"));
    enqueueNoDevicePrompt(interactionId);
    return;
  }
  if (selectedProfile.length() == 0) {
    markMcuInteraction(interactionId, F("failed"), F("NO PROFILE"));
    Serial.println(F("Voice trigger failed: NO PROFILE"));
    broadcastMcuStatus();
    return;
  }
  if (!waitForMcuSocketReady(8000)) {
    markMcuInteraction(interactionId, F("failed"), F("SOCKET OFF"));
    Serial.printf("Voice trigger failed: SOCKET OFF activeUrl=%s token=%d profile=%s connected=%d namespace=%d\n",
                  activeDeviceUrl.c_str(), mcuAuthToken.length() > 0 ? 1 : 0, selectedProfile.c_str(),
                  mcuSocketConnected ? 1 : 0, mcuSocketNamespaceReady ? 1 : 0);
    broadcastMcuStatus();
    return;
  }

  markMcuInteraction(interactionId, F("listening"), F(""));
  broadcastMcuStatus();

  if (!recordAndBroadcastMcuVoiceStream(interactionId)) {
    Serial.printf("Voice record failed detail=%s heap=%lu\n",
                  lastAudioDetail.c_str(), static_cast<unsigned long>(ESP.getFreeHeap()));
    markMcuInteraction(interactionId, F("failed"),
                       lastAudioDetail.length() > 0 ? lastAudioDetail : String(F("record failed")));
    broadcastMcuStatus();
    return;
  }

  markMcuInteraction(interactionId, F("transcribing"), F(""));
  broadcastMcuStatus();
}

void triggerBootRecordPlaybackTest() {
  if (mcuAudioPlaying || audioBusy) {
    setOledStatus(OledMode::Think, F("BUSY"), F("AUDIO"), 50);
    return;
  }

  String interactionId = String(F("rec-play-")) + millis();
  markMcuInteraction(interactionId, F("listening"), F("REC TEST"));
  broadcastMcuStatus();

  uint8_t *wav = nullptr;
  size_t wavLen = 0;
  if (!recordVoiceWav(&wav, &wavLen)) {
    markMcuInteraction(interactionId, F("failed"),
                       lastAudioDetail.length() > 0 ? lastAudioDetail : String(F("record failed")));
    broadcastMcuStatus();
    return;
  }

  markMcuInteraction(interactionId, F("speaking"), F("PLAY REC"));
  broadcastMcuStatus();
  bool played = playRecordedWav(wav, wavLen);
  markMcuInteraction(interactionId, played ? F("completed") : F("failed"),
                     played ? String(F("")) : String(F("playback failed")));
  broadcastMcuStatus();
}

void handleBootButton() {
  bool bootPressed = digitalRead(kPinBoot) == LOW;
  uint32_t now = millis();

  if (!bootInputArmed) {
    bootWasPressed = false;
    bootLongPressHandled = false;
    bootClickPending = false;
    bootSecondClickStarted = false;
    audioInterruptPressStartedAtMs = 0;
    if (now < kBootInputArmDelayMs || bootPressed) {
      bootReleaseStartedAtMs = 0;
      return;
    }
    if (bootReleaseStartedAtMs == 0) {
      bootReleaseStartedAtMs = now;
      return;
    }
    if (now - bootReleaseStartedAtMs < kBootDebounceMs) return;
    bootInputArmed = true;
    lastBootButtonAtMs = now;
    Serial.println(F("BOOT button armed after startup release"));
    return;
  }

  if (bootPressed && !bootWasPressed && now - lastBootButtonAtMs > kBootDebounceMs) {
    if (bootClickPending && now - bootClickPendingAtMs > kBootDoubleClickMs) {
      bootClickPending = false;
      bootSecondClickStarted = false;
      lastBootButtonAtMs = now;
      stopMcuAudioQueueByButton();
      return;
    }
    if (bootClickPending && now - bootClickPendingAtMs <= kBootDoubleClickMs) {
      bootSecondClickStarted = true;
    }
    bootWasPressed = true;
    bootLongPressHandled = false;
    bootPressedAtMs = now;
    return;
  }

  if (bootPressed && bootWasPressed && !bootLongPressHandled &&
      now - bootPressedAtMs >= kBootLongPressMs) {
    bootLongPressHandled = true;
    bootClickPending = false;
    bootSecondClickStarted = false;
    lastBootButtonAtMs = now;
    triggerBootVoiceTurn();
    return;
  }

  if (!bootPressed && bootWasPressed) {
    bootWasPressed = false;
    uint32_t heldMs = now - bootPressedAtMs;
    if (!bootLongPressHandled && heldMs >= kBootDebounceMs) {
      if (bootClickPending && (bootSecondClickStarted || now - bootClickPendingAtMs <= kBootDoubleClickMs)) {
        bootClickPending = false;
        bootSecondClickStarted = false;
        lastBootButtonAtMs = now;
        clearMcuSessionByButton();
      } else {
        bootClickPending = true;
        bootSecondClickStarted = false;
        bootClickPendingAtMs = now;
      }
    }
  }

  if (!bootWasPressed && bootClickPending && now - bootClickPendingAtMs > kBootDoubleClickMs) {
    bootClickPending = false;
    bootSecondClickStarted = false;
    lastBootButtonAtMs = now;
    stopMcuAudioQueueByButton();
  }
}

String mcuSocketAuthJson() {
  String json;
  json.reserve(mcuAuthToken.length() + selectedProfile.length() + 180);
  json += F("{\"token\":\"");
  json += escapeJson(mcuAuthToken);
  json += F("\",\"role\":\"hermes-studio\",\"instanceId\":\"");
  json += escapeJson(deviceId());
  json += F("\",\"profile\":\"");
  json += escapeJson(selectedProfile);
  json += F("\"}");
  return json;
}

void sendMcuSocketNamespaceConnect() {
  if (!mcuSocketConnected || mcuAuthToken.length() == 0) return;
  String frame = String(F("40/global-agent,")) + mcuSocketAuthJson();
  sendRawWsText(frame);
}

void sendMcuReady() {
  String json = String(F("{\"type\":\"mcu.ready\",\"id\":\"")) + escapeJson(deviceId()) +
                F("\",\"active_device\":\"") + escapeJson(activeDeviceKey) +
                F("\",\"profile\":\"") + escapeJson(selectedProfile) +
                F("\",\"capabilities\":{\"display\":true,\"audio_queue\":true,\"audio_playback\":true,\"pcm_stream\":false}}");
  sendMcuSocketEvent(F("mcu.ready"), json);
  broadcastMcuStatus();
}

bool parseSocketIoEvent(const String &message, String *event, String *json) {
  int arrayStart = message.indexOf('[');
  if (arrayStart < 0) return false;
  int firstQuote = message.indexOf('"', arrayStart);
  if (firstQuote < 0) return false;
  int secondQuote = message.indexOf('"', firstQuote + 1);
  if (secondQuote < 0) return false;
  int comma = message.indexOf(',', secondQuote + 1);
  int arrayEnd = message.lastIndexOf(']');
  if (comma < 0 || arrayEnd <= comma) return false;
  String parsedEvent = message.substring(firstQuote + 1, secondQuote);
  int payloadStart = comma + 1;
  while (payloadStart < arrayEnd && isspace(static_cast<unsigned char>(message[payloadStart]))) ++payloadStart;
  int payloadEnd = arrayEnd;
  if (payloadStart < arrayEnd && message[payloadStart] == '{') {
    int depth = 0;
    bool inString = false;
    bool escaped = false;
    for (int i = payloadStart; i < arrayEnd; ++i) {
      char c = message[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c == '\\') {
        escaped = true;
        continue;
      }
      if (c == '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c == '{') {
        ++depth;
      } else if (c == '}') {
        --depth;
        if (depth == 0) {
          payloadEnd = i + 1;
          break;
        }
      }
    }
  }
  String parsedJson = message.substring(payloadStart, payloadEnd);
  parsedJson.trim();
  if (!parsedJson.startsWith("{")) {
    parsedJson = String(F("{\"type\":\"")) + escapeJson(parsedEvent) + F("\"}");
  } else if (jsonStringValue(parsedJson, F("type")).length() == 0) {
    parsedJson = String(F("{\"type\":\"")) + escapeJson(parsedEvent) + F("\",") + parsedJson.substring(1);
  }
  if (event) *event = parsedEvent;
  if (json) *json = parsedJson;
  return parsedEvent.length() > 0;
}

void handleSocketIoText(const String &message) {
  if (message == F("2")) {
    sendRawWsText(String(F("3")));
    return;
  }
  if (message.startsWith(F("0"))) {
    sendMcuSocketNamespaceConnect();
    return;
  }
  if (message.startsWith(F("40/global-agent"))) {
    mcuSocketNamespaceReady = true;
    Serial.println(F("Socket.IO namespace /global-agent connected"));
    sendMcuReady();
    return;
  }
  if (message.startsWith(F("44/global-agent"))) {
    mcuSocketNamespaceReady = false;
    Serial.printf("Socket.IO namespace error: %s\n", message.c_str());
    return;
  }
  if (message.startsWith(F("42"))) {
    String event;
    String json;
    if (parseSocketIoEvent(message, &event, &json)) {
      Serial.printf("Socket.IO event %s %s\n", event.c_str(), json.c_str());
      handleMcuWebSocketText(0, json);
    }
    return;
  }
}

bool readMcuWsBytes(uint8_t *buffer, size_t length, uint32_t timeoutMs = 100) {
  size_t read = 0;
  uint32_t startedAt = millis();
  while (read < length && millis() - startedAt < timeoutMs) {
    int available = mcuWsClient.available();
    if (available > 0) {
      int n = mcuWsClient.read(buffer + read, min(static_cast<size_t>(available), length - read));
      if (n > 0) read += static_cast<size_t>(n);
    } else {
      delay(1);
      yield();
    }
  }
  return read == length;
}

void closeMcuSocketTransport(const __FlashStringHelper *reason) {
  if (mcuWsClient.connected()) mcuWsClient.stop();
  wsReady = false;
  mcuSocketConnected = false;
  mcuSocketNamespaceReady = false;
  Serial.print(F("Socket.IO transport disconnected"));
  if (reason) {
    Serial.print(F(": "));
    Serial.print(reason);
  }
  Serial.println();
}

void mcuSocketLoop() {
  if (!wsReady) return;
  if (!mcuWsClient.connected()) {
    closeMcuSocketTransport(F("tcp closed"));
    return;
  }

  while (mcuWsClient.available() >= 2) {
    uint8_t header[2];
    if (!readMcuWsBytes(header, 2)) return;
    uint8_t opcode = header[0] & 0x0F;
    bool masked = (header[1] & 0x80) != 0;
    uint64_t length = header[1] & 0x7F;
    if (length == 126) {
      uint8_t ext[2];
      if (!readMcuWsBytes(ext, 2)) return;
      length = (static_cast<uint16_t>(ext[0]) << 8) | ext[1];
    } else if (length == 127) {
      uint8_t ext[8];
      if (!readMcuWsBytes(ext, 8)) return;
      length = 0;
      for (uint8_t i = 0; i < 8; ++i) length = (length << 8) | ext[i];
    }
    if (length > 8192) {
      closeMcuSocketTransport(F("frame too large"));
      return;
    }
    uint8_t mask[4] = {0, 0, 0, 0};
    if (masked && !readMcuWsBytes(mask, 4)) return;
    std::unique_ptr<uint8_t[]> payload(new uint8_t[static_cast<size_t>(length) + 1]);
    if (!payload || !readMcuWsBytes(payload.get(), static_cast<size_t>(length), 500)) return;
    for (size_t i = 0; masked && i < static_cast<size_t>(length); ++i) payload[i] ^= mask[i & 3];
    payload[static_cast<size_t>(length)] = 0;

    if (opcode == 0x1) {
      String message(reinterpret_cast<char *>(payload.get()));
      Serial.printf("Socket.IO message %s\n", message.c_str());
      handleSocketIoText(message);
    } else if (opcode == 0x8) {
      closeMcuSocketTransport(F("close frame"));
      return;
    } else if (opcode == 0x9) {
      sendRawWsFrame(0xA, payload.get(), static_cast<size_t>(length));
    }
  }
}

void disconnectMcuSocketClient() {
  if (mcuWsClient.connected()) mcuWsClient.stop();
  wsReady = false;
  mcuSocketConnected = false;
  mcuSocketNamespaceReady = false;
  mcuSocketTargetKey = "";
}

void connectMcuSocketClient() {
  if (!wifiReady || WiFi.status() != WL_CONNECTED || activeDeviceUrl.length() == 0 || mcuAuthToken.length() == 0) {
    disconnectMcuSocketClient();
    return;
  }

  String scheme;
  String host;
  uint16_t port = 0;
  String path;
  if (!parseAudioUrl(activeDeviceUrl, &scheme, &host, &port, &path)) {
    disconnectMcuSocketClient();
    return;
  }

  String targetKey = scheme + F("://") + host + F(":") + String(port) + F("|") + selectedProfile + F("|") + mcuAuthToken;
  if (wsReady && mcuSocketTargetKey == targetKey) return;
  disconnectMcuSocketClient();

  if (scheme != F("http")) {
    Serial.printf("Socket.IO client unsupported scheme=%s\n", scheme.c_str());
    return;
  }

  if (!mcuWsClient.connect(host.c_str(), port, 5000)) {
    Serial.printf("Socket.IO tcp connect failed host=%s port=%u\n", host.c_str(), port);
    return;
  }

  String socketPath = F("/socket.io/?EIO=4&transport=websocket");
  String key = F("dGhlIHNhbXBsZSBub25jZQ==");
  String request;
  request.reserve(host.length() + socketPath.length() + 260);
  request += F("GET ");
  request += socketPath;
  request += F(" HTTP/1.1\r\nHost: ");
  request += host;
  request += F(":");
  request += port;
  request += F("\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ");
  request += key;
  request += F("\r\nUser-Agent: HStudio-ESP32C3\r\n\r\n");
  mcuWsClient.print(request);

  String statusLine = mcuWsClient.readStringUntil('\n');
  statusLine.trim();
  if (!statusLine.startsWith(F("HTTP/1.1 101")) && !statusLine.startsWith(F("HTTP/1.0 101"))) {
    Serial.printf("Socket.IO websocket upgrade failed: %s\n", statusLine.c_str());
    mcuWsClient.stop();
    return;
  }
  uint32_t headerStartedAt = millis();
  while (mcuWsClient.connected() && millis() - headerStartedAt < 3000) {
    String line = mcuWsClient.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) break;
  }
  wsReady = true;
  mcuSocketConnected = true;
  mcuSocketNamespaceReady = false;
  mcuSocketTargetKey = targetKey;
  lastMcuSocketConnectAtMs = millis();
  Serial.printf("Socket.IO client connecting host=%s port=%u profile=%s\n",
                host.c_str(), port, selectedProfile.c_str());
  mcuSocketLoop();
}

void sendConnectSuccessPage(const String &ssid, const IPAddress &ip) {
  String target = deviceUrl(ip);
  String html = pageStart(F("Wi-Fi 已连接"));
  html += F("<section class='panel'><p class='meta'>HStudio ESP32-C3</p><h1>Wi-Fi 已连接</h1>");
  html += F("<p class='lead ok'>");
  html += escapeHtml(ssid);
  html += F(" · IP ");
  html += ip.toString();
  html += F("</p><p class='hint'>设备将自动重启并关闭配网热点，随后打开局域网地址。如果手机没有自动切回同一个 Wi-Fi，请手动切回后再打开。</p>");
  html += F("<div class='btn-row'><a class='btn primary' href='");
  html += target;
  html += F("'>打开设备页面</a><a class='btn' href='/wifi'>重新配置</a></div></section>");
  html += F("<script>setTimeout(function(){location.href='");
  html += target;
  html += F("';},");
  html += kProvisionRedirectDelayMs;
  html += F(");</script>");
  html += pageEnd();
  server.send(200, F("text/html; charset=utf-8"), html);
}

void sendConnectFailedPage(const String &ssid) {
  String html = pageStart(F("Wi-Fi 连接失败"));
  html += F("<section class='panel'><p class='meta'>HStudio ESP32-C3</p><h1>Wi-Fi 连接失败</h1>");
  html += F("<p class='lead bad'>没有连上 ");
  html += escapeHtml(ssid);
  html += F("。请检查 SSID 和密码后重试。</p>");
  html += F("<div class='btn-row'><a class='btn primary' href='/wifi'>返回配网</a><a class='btn primary' href='/clear'>清除配置</a></div></section>");
  html += pageEnd();
  server.send(200, F("text/html; charset=utf-8"), html);
}

bool connectWifiCredentials(const String &ssid, const String &pass, wifi_mode_t mode) {
  setOledStatus(OledMode::Think, F("WIFI"), F("CONNECT"), 25);
  WiFi.mode(mode);
  WiFi.setSleep(false);
  WiFi.disconnect(false, false);
  delay(100);
  WiFi.begin(ssid.c_str(), pass.c_str());
  uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < kConnectTimeoutMs) {
    delay(250);
    refreshOled();
    yield();
  }

  wifiReady = WiFi.status() == WL_CONNECTED;
  if (wifiReady) {
    wifiDisconnectedSinceMs = 0;
    if (mode == WIFI_STA) setupApMode = false;
    connectMcuSocketClient();
    setOledStatus(OledMode::Ready, F("ONLINE"), WiFi.localIP().toString(), 100);
    Serial.printf("WiFi connected ssid=%s ip=%s\n", ssid.c_str(), WiFi.localIP().toString().c_str());
    esp_rom_printf("WiFi connected ssid=%s ip=%s\n", ssid.c_str(), WiFi.localIP().toString().c_str());
  } else {
    setOledStatus(OledMode::Error, F("WIFI"), F("FAILED"), 0);
    delay(500);
  }
  return wifiReady;
}

void saveWifi() {
  String ssid = server.arg(F("ssid"));
  ssid.trim();
  String manualSsid = server.arg(F("ssid_manual"));
  manualSsid.trim();
  if (ssid == F("__manual__") || ssid.length() == 0) {
    ssid = manualSsid;
  }
  String pass = server.arg(F("pass"));
  if (ssid.length() == 0) {
    server.send(400, F("text/plain; charset=utf-8"), F("缺少 SSID"));
    return;
  }
  prefs.begin("net", false);
  prefs.putString("ssid", ssid);
  prefs.putString("pass", pass);
  prefs.end();
  if (connectWifiCredentials(ssid, pass, WIFI_AP_STA)) {
    sendConnectSuccessPage(ssid, WiFi.localIP());
    restartPending = true;
    restartAtMs = millis() + kProvisionRestartDelayMs;
    setOledStatus(OledMode::Think, F("WIFI"), F("RESTART"), 90);
    return;
  }
  sendConnectFailedPage(ssid);
}

void clearWifi() {
  prefs.begin("net", false);
  prefs.clear();
  prefs.end();
  setOledStatus(OledMode::Think, F("WIFI"), F("CLEAR"), 40);
  server.send(200, F("text/html; charset=utf-8"),
              F("<!doctype html><meta charset='utf-8'><p>已清除，设备正在重启并回到热点模式...</p>"));
  delay(700);
  ESP.restart();
}

bool connectSavedWifi() {
  String ssid = prefString("ssid");
  String pass = prefString("pass");
  ssid.trim();
  if (ssid.length() == 0) return false;
  return connectWifiCredentials(ssid, pass, WIFI_STA);
}

void startSetupAp() {
  setOledStatus(OledMode::Think, F("SETUP"), F("AP START"), 35);
  if (lanUdpReady) {
    lanUdp.stop();
    lanUdpReady = false;
  }
  lanDeviceCount = 0;
  lastLanDiscoveryAtMs = 0;
  scanWifiList();
  WiFi.persistent(false);
  WiFi.disconnect(true, true);
  WiFi.softAPdisconnect(true);
  delay(120);
  WiFi.mode(WIFI_AP);
  WiFi.setSleep(false);
  bool configOk = WiFi.softAPConfig(kApIp, kApGateway, kApSubnet);
  bool apOk = WiFi.softAP(kApName, nullptr, 1, false, 4);
  bool ok = configOk && apOk;
  setupApMode = ok;
  wifiReady = false;
  setOledStatus(ok ? OledMode::Ready : OledMode::Error, ok ? F("SETUP") : F("AP ERR"),
                ok ? F("OPEN WIFI AP") : F("AP FAILED"), ok ? 100 : 0);
  Serial.printf("Setup AP config=%d ap=%d ssid=%s ip=%s open=1\n", configOk ? 1 : 0,
                apOk ? 1 : 0, kApName, WiFi.softAPIP().toString().c_str());
  esp_rom_printf("Setup AP config=%d ap=%d ssid=%s ip=%s open=1\n", configOk ? 1 : 0,
                 apOk ? 1 : 0, kApName, WiFi.softAPIP().toString().c_str());
}

void handleRoot() {
  if (wifiReady && WiFi.status() == WL_CONNECTED) {
    sendStatusPage();
    return;
  }
  sendWifiPage();
}

void handleHealth() {
  String json = F("{\"status\":\"ok\",\"wifi_connected\":");
  json += (wifiReady && WiFi.status() == WL_CONNECTED) ? F("true") : F("false");
  json += F(",\"ip\":\"");
  json += currentIp();
  json += F("\",\"setup_ap\":\"");
  json += setupApMode ? kApName : "";
  json += F("\",\"mcu\":{\"interaction_active\":");
  json += mcuInteractionActive ? F("true") : F("false");
  json += F(",\"status\":\"");
  json += escapeJson(mcuInteractionStatus);
  json += F("\",\"audio_playing\":");
  json += mcuAudioPlaying ? F("true") : F("false");
  json += F(",\"queue_length\":");
  json += mcuAudioCount;
  json += F("},\"audio\":{\"i2s_ready\":");
  json += i2sReady ? F("true") : F("false");
  json += F(",\"es8311_ready\":");
  json += es8311Ready ? F("true") : F("false");
  json += F(",\"volume\":");
  json += outputVolumePercent;
  json += F(",\"battery_known\":false,\"battery_level\":0,\"battery_charging\":false");
  json += F(",\"busy\":");
  json += audioBusy ? F("true") : F("false");
  json += F(",\"last_detail\":\"");
  json += escapeJson(lastAudioDetail);
  json += F("\"}}");
  server.send(200, F("application/json"), json);
}

void tickMcuInteraction() {
  if (mcuAudioPlaying && mcuAudioDurationMs > 0 &&
      millis() - mcuAudioStartedAtMs >= mcuAudioDurationMs) {
    bool completionManagedByServer = mcuCurrentAudio.completionManagedByServer;
    finishMcuAudio(false);
    startNextMcuAudio();
    if (!completionManagedByServer && !mcuAudioPlaying && mcuAudioCount == 0 &&
        (mcuInteractionStatus == F("speaking") || mcuInteractionStatus == F("completed"))) {
      markMcuInteraction(mcuInteractionId, F("completed"), F(""));
      broadcastMcuStatus();
    }
  }

  uint32_t idleDelayMs = mcuInteractionStatus == F("failed") ? kMcuFailureIdleDelayMs : kMcuInteractionIdleDelayMs;
  if (mcuInteractionActive && !mcuAudioPlaying && mcuAudioCount == 0 &&
      (mcuInteractionStatus == F("completed") || mcuInteractionStatus == F("failed") ||
       mcuInteractionStatus == F("aborted")) &&
      millis() - mcuInteractionUpdatedAtMs > idleDelayMs) {
    mcuInteractionActive = false;
    mcuInteractionStatus = F("idle");
    mcuInteractionText = "";
    mcuToolName = "";
    mcuToolPreview = "";
    mcuToolStatus = "";
    if (wifiReady && WiFi.status() == WL_CONNECTED) {
      setOledStatus(OledMode::Ready, F("ONLINE"), WiFi.localIP().toString(), 100);
    } else {
      setOledStatus(OledMode::Ready, F("READY"), F(""), 0);
    }
    oledDirty = true;
  }
}

void handleNoContent() {
  server.send(204, F("text/plain"), F(""));
}

void handleAppleCaptiveCheck() {
  server.send(200, F("text/html"), F("Success"));
}

void handleWindowsConnectCheck() {
  server.send(200, F("text/plain"), F("Microsoft Connect Test"));
}

void handleWindowsNcsiCheck() {
  server.send(200, F("text/plain"), F("Microsoft NCSI"));
}

void setupRoutes() {
  server.on(F("/"), HTTP_GET, handleRoot);
  server.on(F("/ping"), HTTP_GET, []() {
    server.send(200, F("text/plain"), F("ok"));
  });
  server.on(F("/generate_204"), HTTP_GET, handleNoContent);
  server.on(F("/gen_204"), HTTP_GET, handleNoContent);
  server.on(F("/hotspot-detect.html"), HTTP_GET, handleAppleCaptiveCheck);
  server.on(F("/library/test/success.html"), HTTP_GET, handleAppleCaptiveCheck);
  server.on(F("/connecttest.txt"), HTTP_GET, handleWindowsConnectCheck);
  server.on(F("/ncsi.txt"), HTTP_GET, handleWindowsNcsiCheck);
  server.on(F("/favicon.ico"), HTTP_GET, handleNoContent);
  server.on(F("/device"), HTTP_GET, sendStatusPage);
  server.on(F("/device/scan"), HTTP_GET, scanAndSendStatusPage);
  server.on(F("/device/audio"), HTTP_POST, handleDeviceAudio);
  server.on(F("/device/manual"), HTTP_POST, addManualDevice);
  server.on(F("/device/login"), HTTP_GET, sendMcuLoginPage);
  server.on(F("/device/login"), HTTP_POST, handleMcuLogin);
  server.on(F("/device/profile"), HTTP_GET, switchProfilePage);
  server.on(F("/device/profile"), HTTP_POST, saveProfile);
  server.on(F("/device/active"), HTTP_GET, setActiveDevice);
  server.on(F("/device/logout"), HTTP_GET, logoutDevice);
  server.on(F("/ota"), HTTP_GET, []() { sendOtaPage(); });
  server.on(F("/ota/check"), HTTP_POST, handleOtaCheck);
  server.on(F("/wifi"), HTTP_GET, sendWifiPage);
  server.on(F("/wifi"), HTTP_POST, saveWifi);
  server.on(F("/clear"), HTTP_GET, clearWifi);
  server.on(F("/clear"), HTTP_POST, clearWifi);
  server.on(F("/health"), HTTP_GET, handleHealth);
  server.onNotFound(handleRoot);
  server.begin();
}
}  // namespace

void setup() {
  delay(500);
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println(F("HStudio WiFi setup firmware boot"));
  Serial.printf("Reset reason=%d free_heap=%lu min_free_heap=%lu\n",
                static_cast<int>(esp_reset_reason()),
                static_cast<unsigned long>(ESP.getFreeHeap()),
                static_cast<unsigned long>(ESP.getMinFreeHeap()));
  esp_rom_printf("HStudio WiFi setup firmware boot\n");
  initOledDisplay();
  loadAudioPreferences();
  initAudioHardware();
  prefs.begin("mcu", true);
  pendingProfileDeviceKey = prefs.getString("last_key", "");
  activeDeviceKey = prefs.getString("active_key", "");
  activeDeviceUrl = prefs.getString("active_url", "");
  mcuAuthToken = prefs.getString("auth_token", "");
  selectedProfile = prefs.getString("last_profile", "");
  prefs.end();
  setOledStatus(OledMode::Boot, F("BOOT"), F("WIFI ONLY"), 15);
  if (kForceSetupAp || !connectSavedWifi()) {
    startSetupAp();
  }
  setupRoutes();
  if (wifiReady && !setupApMode) {
    autoLoginSavedDevice();
  }
}

void loop() {
  if (restartPending && static_cast<int32_t>(millis() - restartAtMs) >= 0) {
    ESP.restart();
  }

  server.handleClient();
  if (wsReady) mcuSocketLoop();
  tickMcuInteraction();
  refreshOled();
  handleBootButton();
  if (kAutoOtaEnabled && static_cast<int32_t>(millis() - nextMcuOtaCheckAtMs) >= 0) {
    McuOtaResult otaResult = checkMcuFirmwareUpdate(false);
    nextMcuOtaCheckAtMs = millis() + (otaResult == McuOtaResult::Failed ? kMcuOtaRetryMs : kMcuOtaIntervalMs);
  }

  if (wifiReady && WiFi.status() != WL_CONNECTED) {
    uint32_t now = millis();
    if (wifiDisconnectedSinceMs == 0) {
      wifiDisconnectedSinceMs = now;
      setOledStatus(OledMode::Think, F("WIFI"), F("RECONNECT"), 60);
      Serial.printf("WiFi disconnected status=%d, waiting %lu ms before setup AP\n",
                    static_cast<int>(WiFi.status()),
                    static_cast<unsigned long>(kWifiDisconnectGraceMs));
      WiFi.reconnect();
    } else if (now - wifiDisconnectedSinceMs >= kWifiDisconnectGraceMs) {
      setOledStatus(OledMode::Error, F("WIFI"), F("LOST"), 0);
      delay(500);
      wifiDisconnectedSinceMs = 0;
      startSetupAp();
    }
  } else if (wifiReady) {
    wifiDisconnectedSinceMs = 0;
  }
}
