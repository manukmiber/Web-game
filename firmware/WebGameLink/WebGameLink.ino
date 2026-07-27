/*
 * WebGameLink — reference firmware for the editor's hardware layer.
 *
 * Streams analog and digital pins as `channel=value` lines and accepts the same shape back for
 * outputs. Tested on an Uno and a Leonardo; anything with `Serial` will run it.
 *
 *   Editor  ← A0=512 A1=7 D2=1     inputs, only when they change
 *   Editor  → D13=255              outputs, applied to the pin
 *   Editor  → ?                    "identify yourself" → a `hello` line
 *
 * Wiring for the defaults below:
 *
 *   A0, A1   potentiometer wipers (outer legs to 5V and GND)
 *   D2, D3   momentary buttons to GND — INPUT_PULLUP means no resistor and inverted logic,
 *            which this file corrects so the editor sees 1 for "pressed"
 *   D9       LED through a 220Ω resistor (PWM, so it can dim)
 *   D13      the built-in LED
 *
 * Three details are the whole reason this file is worth reading before writing your own:
 *
 * 1. **Send only on change, with a floor on the rate.** A 10-bit ADC jitters by a count or two
 *    even when nothing moves; streaming every reading fills the link with noise. CHANGE_MIN is
 *    a deadband in raw counts, and MIN_INTERVAL_MS caps how often a channel may report.
 * 2. **Never `delay()`.** A delay in the loop is latency in the game — this is a control
 *    surface, not a data logger.
 * 3. **The editor opening the port resets the board** (DTR toggles reset on most Arduinos).
 *    That is why `hello` is sent from `setup()` *and* on request: the editor asks, because it
 *    may have attached after the board booted.
 */

const unsigned long BAUD = 115200;

const uint8_t ANALOG_PINS[] = {A0, A1};
const uint8_t BUTTON_PINS[] = {2, 3};
const uint8_t OUTPUT_PINS[] = {9, 13};

const uint8_t ANALOG_COUNT = sizeof(ANALOG_PINS) / sizeof(ANALOG_PINS[0]);
const uint8_t BUTTON_COUNT = sizeof(BUTTON_PINS) / sizeof(BUTTON_PINS[0]);
const uint8_t OUTPUT_COUNT = sizeof(OUTPUT_PINS) / sizeof(OUTPUT_PINS[0]);

/* Raw ADC counts a reading must move before it is worth a line. */
const int CHANGE_MIN = 4;
/* Fastest a single channel may report, in milliseconds. 8 ms is ~120 Hz — twice a 60 fps frame. */
const unsigned long MIN_INTERVAL_MS = 8;
/* Slowest — a heartbeat, so a channel that has not moved still proves it is alive. */
const unsigned long HEARTBEAT_MS = 1000;

int lastAnalog[ANALOG_COUNT];
unsigned long lastAnalogSent[ANALOG_COUNT];
int lastButton[BUTTON_COUNT];
unsigned long lastButtonChange[BUTTON_COUNT];

/* Buttons bounce for a few milliseconds; a bounce is two spurious presses in the game. */
const unsigned long DEBOUNCE_MS = 12;

char command[24];
uint8_t commandLength = 0;
bool commandOverflow = false;

void sendHello() {
  Serial.print(F("hello name=WebGameLink protocol=1 channels="));
  for (uint8_t i = 0; i < ANALOG_COUNT; i++) {
    Serial.print('A');
    Serial.print(i);
    Serial.print(',');
  }
  for (uint8_t i = 0; i < BUTTON_COUNT; i++) {
    Serial.print('D');
    Serial.print(BUTTON_PINS[i]);
    if (i + 1 < BUTTON_COUNT) Serial.print(',');
  }
  Serial.println();
}

void setup() {
  Serial.begin(BAUD);

  for (uint8_t i = 0; i < BUTTON_COUNT; i++) {
    pinMode(BUTTON_PINS[i], INPUT_PULLUP);
    lastButton[i] = -1;
    lastButtonChange[i] = 0;
  }
  for (uint8_t i = 0; i < OUTPUT_COUNT; i++) {
    pinMode(OUTPUT_PINS[i], OUTPUT);
    analogWrite(OUTPUT_PINS[i], 0);
  }
  for (uint8_t i = 0; i < ANALOG_COUNT; i++) {
    lastAnalog[i] = -1000;
    lastAnalogSent[i] = 0;
  }

  sendHello();
}

void reportAnalog(unsigned long now) {
  for (uint8_t i = 0; i < ANALOG_COUNT; i++) {
    if (now - lastAnalogSent[i] < MIN_INTERVAL_MS) continue;

    const int value = analogRead(ANALOG_PINS[i]);
    const bool moved = abs(value - lastAnalog[i]) >= CHANGE_MIN;
    const bool due = now - lastAnalogSent[i] >= HEARTBEAT_MS;
    if (!moved && !due) continue;

    lastAnalog[i] = value;
    lastAnalogSent[i] = now;
    Serial.print('A');
    Serial.print(i);
    Serial.print('=');
    Serial.println(value);
  }
}

void reportButtons(unsigned long now) {
  for (uint8_t i = 0; i < BUTTON_COUNT; i++) {
    /* INPUT_PULLUP reads LOW when the button is pressed, so this inverts it: the editor's
       protocol says 1 means "on", and firmware is the right place to know about the wiring. */
    const int value = digitalRead(BUTTON_PINS[i]) == LOW ? 1 : 0;
    if (value == lastButton[i]) continue;
    if (now - lastButtonChange[i] < DEBOUNCE_MS) continue;

    lastButton[i] = value;
    lastButtonChange[i] = now;
    Serial.print('D');
    Serial.print(BUTTON_PINS[i]);
    Serial.print('=');
    Serial.println(value);
  }
}

void applyCommand(char *line) {
  if (line[0] == '?') {
    sendHello();
    return;
  }

  char *equals = strchr(line, '=');
  if (equals == NULL) return;
  *equals = '\0';

  const char *channel = line;
  const long value = atol(equals + 1);

  if (strcmp(channel, "bye") == 0) {
    for (uint8_t i = 0; i < OUTPUT_COUNT; i++) analogWrite(OUTPUT_PINS[i], 0);
    return;
  }
  if (channel[0] != 'D') return;

  const int pin = atoi(channel + 1);
  for (uint8_t i = 0; i < OUTPUT_COUNT; i++) {
    if (OUTPUT_PINS[i] != pin) continue;
    /* analogWrite falls back to digital on a non-PWM pin, so one call covers lamps and servos'
       worth of brightness alike. Values above 255 are the caller's mistake, clamped here. */
    analogWrite(pin, constrain(value, 0, 255));
    return;
  }
}

void readSerial() {
  while (Serial.available() > 0) {
    const char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (commandLength > 0 && !commandOverflow) {
        command[commandLength] = '\0';
        applyCommand(command);
      }
      commandLength = 0;
      commandOverflow = false;
      continue;
    }
    /* A line longer than the buffer is dropped whole rather than truncated: `D13=255` cut
       short is `D13=2`, which parses fine and sets the wrong brightness. */
    if (commandLength < sizeof(command) - 1) command[commandLength++] = c;
    else commandOverflow = true;
  }
}

void loop() {
  const unsigned long now = millis();
  readSerial();
  reportAnalog(now);
  reportButtons(now);
}
