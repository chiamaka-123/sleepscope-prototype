# SleepScope

SleepScope is a React Native prototype for collecting overnight smartphone sensor data. It records accelerometer, gyroscope, microphone sound level (dB), and user-logged wake-up events into a timestamped CSV for later analysis.



---

# How It Works

1. **Session Setup**
   - The participant enters a unique participant ID before starting a recording.
   - This ID is stored in the exported CSV metadata.

2. **Data Collection**
   - Records accelerometer (X, Y, Z), gyroscope (X, Y, Z), and microphone level (dBFS) once per second.

3. **Wake-Up Logging**
   - Participants can log wake-up events during the night using predefined reasons or custom notes.
   - Wake-up events are written into the CSV alongside sensor data.

4. **Session Notes**
   - At the end of the recording, optional notes can be added describing anything remembered about the night.

5. **CSV Export**
   - The completed session is exported as a CSV using the native iOS/Android Share Sheet.
   - Audio recordings are deleted after extracting microphone levels, so only the CSV is retained.

---

# Getting Started

## Prerequisites

- Node.js
- Expo Go installed on your iPhone or Android device
- Laptop and phone connected to the same Wi-Fi network

### Expo Go Settings

Before testing:

- Open **Diagnostics** and enable **Audio**
- Open **Settings** and disable **Shake Gesture**
- Verify Expo Go supports **SDK 54**. Update the app if necessary.

---

## Installation

Clone the repository and install dependencies.

```bash
git clone https://github.com/chiamaka-123/sleepscope-prototype.git

cd sleepscope-prototype

npm install
```
---

## Running the App

Start the Expo development server.

```bash
npx expo start
```

Open Expo Go and scan the QR code displayed in the terminal.

---

# Overnight Testing Protocol

SleepScope runs inside Expo Go during development.

The app remains connected to the Expo development server running on your laptop. If the laptop sleeps, the development server stops and the recording may fail.

Before going to sleep, complete the following checklist.

---

## Laptop

### All Platforms

- Plug the laptop into power.
- Prevent the computer from sleeping overnight.
- It is fine for the display to turn off, but the computer and Wi-Fi must remain awake.

### macOS

Go to Mac's Settings menu and click on Displays.

Click the **Advanced** button at the bottom of the Displays page.
Turn ON the toggle that says "Prevent automatic sleeping on power adapter when the display is off."
Go to the Lock Screen menu and change "Turn display off on power adapter" to desired duration.

Leave the Terminal window open overnight.

### Windows

Go to:

**Settings → System → Power & battery**

Configure:

- **Turn off screen when plugged in:** Set desired duration
- **Put device to sleep when plugged in:** Never

---

## Phone

- Connect the phone to a charger.
- Leave Expo Go open in the foreground.
- Tap **Initiate Sleep Session**.
- The screen will enter blackout mode to reduce light while keeping the app active.
- Place the phone face-up on the mattress next to you.
- Do not switch to another app while testing or the app will stop recording audio and movement. If this happens, restart the session.

---

# CSV Format

Each recording produces a timestamped CSV containing one row per second.

Columns:

| Column | Description |
|---------|-------------|
| Timestamp | ISO-8601 timestamp |
| Accel_X, Accel_Y, Accel_Z | Accelerometer readings |
| Gyro_X, Gyro_Y, Gyro_Z | Gyroscope readings |
| dB | Microphone level (dBFS) |
| Event | Wake-up event logged by the participant (blank otherwise) |

The first few lines of the CSV begin with `#` and contain session metadata, including:

- participant ID
- session start time
- optional session notes

## Reliability

Sensor data is automatically written to disk every 30 seconds during recording. If the app unexpectedly closes, at most the most recent 30 seconds of data may be lost.

---

# Exporting Results

When you wake up:

1. Tap the screen to exit blackout mode.
2. Tap **Stop & Export CSV**.
3. Optionally enter session notes.
4. Tap **Save & Export CSV**.

The app will:
- Stop sensor recording.
- Save the final CSV to local storage.
- Remove the temporary audio recording (only microphone levels are retained).
- Open the native Share Sheet so the CSV can be saved or shared.

Upload the exported CSV to the team Google Drive:

https://drive.google.com/drive/folders/1STzX1D45tIOndZys6E-O5Zn6tXZO1KXL?usp=share_link

