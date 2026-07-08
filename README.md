# SleepScope

SleepScope is a React Native prototype that estimates behavioral sleep states using smartphone motion (accelerometer) and environmental audio (microphone).

The app records 1 Hz sensor telemetry, downsamples it into 2-minute epochs, and uses the Groq API to classify each epoch into one of three behavioral states:

- Quiet Sleep
- Restless
- Awake

> **Note:** SleepScope estimates behavioral activity only. It does not detect physiological sleep stages such as REM, light sleep, or deep sleep.

---

# How It Works

1. **Data Collection**
   - Records accelerometer movement (Delta X, Y, Z) and peak microphone level (dBFS) once per second.

2. **Edge Compression**
   - Compresses every 120 seconds of telemetry into a single summary row using peak detection.
   - This greatly reduces API token usage while preserving meaningful activity patterns.

3. **AI Classification**
   - After the recording ends, the compressed CSV is sent to the Groq API.
   - Llama 3.3 70B classifies every 2-minute epoch as Quiet Sleep, Restless, or Awake using a deterministic prompt.

4. **Local Processing**
   - The app calculates durations, percentages, and the sleep timeline locally.
   - Results are exported as JSON through the iOS Share Sheet.
   - If AI classification fails, the raw CSV is exported instead.

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

## API Key Setup

SleepScope uses the Groq API for AI classification.

The Groq free tier has per-account rate limits. Since multiple team members may be testing at the same time, everyone should generate their own free API key.

If you have trouble creating one, contact the project owner.

### 1. Create a Groq account

Visit:

https://console.groq.com

Sign in using your Google account.

### 2. Generate an API key

Navigate to:

**API Keys → Create API Key**

### 3. Create a `.env` file

In the project root, create a file named:

```
.env
```

Add your API key:

```env
EXPO_PUBLIC_GROQ_KEY=your_api_key_here
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

# Exporting Results

When you wake up:

1. Tap the screen to exit blackout mode.
2. Tap **Stop & Export Metrics**.

The app will:

1. Generate the compressed CSV.
2. Send it to Groq for classification.
3. Calculate sleep statistics locally.
4. Display the session summary.
5. Open the native Share Sheet.

Upload the exported JSON file to the team Google Drive:

https://drive.google.com/drive/folders/1STzX1D45tIOndZys6E-O5Zn6tXZO1KXL?usp=share_link

If AI classification fails because of a network or rate-limit issue, the app automatically exports the raw CSV instead. No data is lost, and the CSV can be classified later using the same prompt included in the source code.
