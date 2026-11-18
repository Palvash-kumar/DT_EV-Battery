// EV Digital Twin - Phase 10: ambient temperature sensor (Arduino UNO R4 WiFi)
//
// Sensor : LM35 analog temperature sensor, 10 mV per °C
// Wiring : LM35 +Vs -> 5V, Vout -> A0, GND -> GND  (low-voltage only;
//          never connect anything here to the EV or charger high-voltage side)
// Measures: AMBIENT / charger-area air temperature, NOT battery-cell temperature.
// Output : one line every ~2.2 s at 9600 baud, e.g.  "Temperature: 31.26 °C"
//          laptop-1/backend/scripts/arduino-gateway.js reads these lines.
//          Keep the "Temperature: <number>" format if you change the sketch.
// Calibration: none (readings are stored as "uncalibrated"). See
//          what_I_did/phase10_arduino.md for a one-point offset calibration.
//
// The code below is exactly the sketch that was running during Phase 10.

const int tempPin = A0;

void setup() {
  Serial.begin(9600);
  analogReadResolution(12);
}

void loop() {
  long total = 0;

  // Take 20 readings for better accuracy
  for (int i = 0; i < 20; i++) {
    total += analogRead(tempPin);
    delay(10);
  }

  float average = total / 20.0;

  // Convert ADC reading into voltage
  float voltage = average * (5.0 / 4095.0);

  // LM35 gives 10mV per degree Celsius
  float temperature = voltage * 100.0;

  Serial.print("Temperature: ");
  Serial.print(temperature);
  Serial.println(" °C");

  delay(2000);
}
