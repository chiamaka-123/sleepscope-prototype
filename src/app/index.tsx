import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import { useKeepAwake } from 'expo-keep-awake';
import { Accelerometer } from 'expo-sensors';
import * as Sharing from 'expo-sharing';
import React, { useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// helper function to handle AI rate limiting
const fetchWithRetry = async (endpoint: string, options: any, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await fetch(endpoint, options);

    if (response.status === 429) {
      console.warn(`Rate limited! Retrying in ${attempt * 15} seconds...`);
      await new Promise(resolve => setTimeout(resolve, attempt * 15000));
      continue;
    }

    if (!response.ok) throw new Error(`API failed with status: ${response.status}`);
    return response;
  }
  throw new Error("Max retries reached. Server is too busy.");
};

export default function App() {
  // prevents the phone screen from locking during the overnight session
  useKeepAwake();

  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isBlackout, setIsBlackout] = useState<boolean>(false);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);

  const [summary, setSummary] = useState<{
    total: number;
    awake: number;
    restless: number;
    quiet: number;
    timeline: { time: string; state: string }[];
  } | null>(null);

  const latestAccel = useRef<{ x: number; y: number; z: number }>({ x: 0, y: 0, z: 0 });
  const dataLog = useRef<string[]>([]);
  const audioRecordingRef = useRef<Audio.Recording | null>(null);
  const accelSubscriptionRef = useRef<{ remove: () => void } | null>(null);

  // staging buffer holds 1Hz data until we reach epoch limit
  const epochBufferRef = useRef<{ timestamp: string; x: number; y: number; z: number; db: number }[]>([]);

  const processEpoch = () => {
    const buffer = epochBufferRef.current;
    if (buffer.length === 0) return;

    // compress 120 seconds of data into a single summary row 
    let peakDb = -160;
    let maxX = buffer[0].x, minX = buffer[0].x;
    let maxY = buffer[0].y, minY = buffer[0].y;
    let maxZ = buffer[0].z, minZ = buffer[0].z;

    for (const item of buffer) {
      if (item.db > peakDb) peakDb = item.db; // catch the loudest noise (peak detection)
      if (item.x > maxX) maxX = item.x;
      if (item.x < minX) minX = item.x;
      if (item.y > maxY) maxY = item.y;
      if (item.y < minY) minY = item.y;
      if (item.z > maxZ) maxZ = item.z;
      if (item.z < minZ) minZ = item.z;
    }

    // calc the total movement range over the window
    const deltaX = maxX - minX;
    const deltaY = maxY - minY;
    const deltaZ = maxZ - minZ;

    // push only one summary row instead of individual rows
    dataLog.current.push(
      `${buffer[0].timestamp},${deltaX.toFixed(3)},${deltaY.toFixed(3)},${deltaZ.toFixed(3)},${peakDb.toFixed(1)}`
    );

    // wipe the staging buffer clean for the next window
    epochBufferRef.current = [];
  };

  const startTracking = async () => {
    try {
      const apiKey = process.env.EXPO_PUBLIC_GROQ_KEY;
      if (!apiKey) {
        Alert.alert('Configuration Error', 'Missing EXPO_PUBLIC_GROQ_KEY in .env file.');
        return;
      }

      const permission = await Audio.requestPermissionsAsync();
      if (permission.status !== 'granted') {
        Alert.alert('Permission Denied', 'Microphone access is required.');
        return;
      }

      // reset UI and background tallies for a fresh session
      setSummary(null);
      epochBufferRef.current = [];
      dataLog.current = ['Timestamp,Delta_X,Delta_Y,Delta_Z,Peak_Audio_dBFS'];

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync({
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      });

      Accelerometer.setUpdateInterval(1000);
      accelSubscriptionRef.current = Accelerometer.addListener(data => {
        latestAccel.current = data;
      });

      recording.setProgressUpdateInterval(1000);
      recording.setOnRecordingStatusUpdate((status: Audio.RecordingStatus) => {
        const s = status as any;
        let currentDb = -160.00;

        if (typeof s.metering === 'number') {
          currentDb = s.metering;
        }

        const timestamp = new Date().toISOString();
        const { x, y, z } = latestAccel.current;

        // push 1Hz raw data to our staging buffer
        epochBufferRef.current.push({ timestamp, x, y, z, db: currentDb });

        // if the buffer hits 120 items, commit to the CSV array
        if (epochBufferRef.current.length >= 120) {
          processEpoch();
        }
      });

      audioRecordingRef.current = recording;
      await recording.startAsync();

      setIsRecording(true);
      setIsBlackout(true);

    } catch (error) {
      console.error('Initialization Failure:', error);
      Alert.alert('Error', 'Failed to properly initialize system sensors.');
    }
  };

  const stopTracking = async () => {
    try {
      setIsAnalyzing(true);

      if (accelSubscriptionRef.current) {
        accelSubscriptionRef.current.remove();
      }

      let audioUri: string | null = null;

      if (audioRecordingRef.current) {
        await audioRecordingRef.current.stopAndUnloadAsync();
        audioUri = audioRecordingRef.current.getURI();
        audioRecordingRef.current = null;
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      }

      // flush any remaining data in the buffer (even if it didn't reach 120)
      processEpoch();

      setIsRecording(false);
      setIsBlackout(false);

      const csvString = dataLog.current.join('\n');
      let finalExportText = "";
      let exportFileName = "";

      // AI post-processing
      const API_KEY = process.env.EXPO_PUBLIC_GROQ_KEY;
      const endpoint = `https://api.groq.com/openai/v1/chat/completions`;

      try {
        const aiResponse = await fetchWithRetry(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`
          },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content: "You are a behavioral sleep classifier. The input is CSV telemetry from a smartphone. Each row represents one independent 2-minute epoch. Classify EVERY row independently as exactly one of: Quiet Sleep, Restless, or Awake.\n\nGuidelines:\n- Quiet Sleep: very little movement across all axes (low Delta XYZ) and peak audio below -45 dBFS.\n- Restless: moderate movement variance, occasional movement spikes, or isolated audio events between -45 and -30 dBFS.\n- Awake: high movement across multiple axes, very high movement variance, or peak audio louder than -30 dBFS.\n\nRules:\n- Use only the telemetry provided.\n- Do not infer REM sleep, deep sleep, light sleep, or medical conditions.\n- Preserve the timestamps exactly as provided.\n- Return one classification for every input row.\n- Do not omit or merge rows.\n\nReturn ONLY a JSON object containing a single key called 'epochs' that holds an array of objects. Each object must have 'timestamp' and 'state'."
              },
              {
                role: "user",
                content: csvString
              }
            ]
          })
        });

        const jsonResponse = await aiResponse.json();

        const rawAiText = jsonResponse.choices[0].message.content;
        const parsedData = JSON.parse(rawAiText);
        const aiEpochs = parsedData.epochs;

        // multiply array length by 120 seconds to get total duration
        let calcTotal = aiEpochs.length * 120;
        let calcAwake = 0;
        let calcRestless = 0;
        let calcQuiet = 0;
        const timelineArray: { time: string; state: string }[] = [];
        let lastState = null;

        for (const epoch of aiEpochs) {
          if (epoch.state === 'Awake') calcAwake += 120;
          else if (epoch.state === 'Restless') calcRestless += 120;
          else if (epoch.state === 'Quiet Sleep') calcQuiet += 120;

          // build a merged timeline for the UI (only log when the state changes)
          if (epoch.state !== lastState) {
            const timeObj = new Date(epoch.timestamp);
            const formattedTime = timeObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            timelineArray.push({
              time: formattedTime,
              state: epoch.state
            });
            lastState = epoch.state;
          }
        }

        setSummary({
          total: calcTotal,
          awake: calcAwake,
          restless: calcRestless,
          quiet: calcQuiet,
          timeline: timelineArray
        });

        finalExportText = JSON.stringify(aiEpochs, null, 2);
        exportFileName = `sleep_analysis_${Date.now()}.json`;

      } catch (aiError) {
        console.error("AI Analysis Failed:", aiError);
        Alert.alert("Analysis Error", "The AI failed to process the data. Exporting raw CSV as a fallback.");

        // Fallback: If the API fails for some reason, export the CSV so the data isn't lost
        // we can still have csv data and we can feed this into ai later
        finalExportText = csvString;
        exportFileName = `fallback_raw_data_${Date.now()}.csv`;
      }

      const fs = FileSystem as any;
      const safeDir = fs.documentDirectory || 'file:///tmp/';
      const targetFileUri = `${safeDir}${exportFileName}`;

      await fs.writeAsStringAsync(targetFileUri, finalExportText, { encoding: 'utf8' });

      if (audioUri) {
        await fs.deleteAsync(audioUri, { idempotent: true });
      }

      const sharing = Sharing as any;
      if (await sharing.isAvailableAsync()) {
        await sharing.shareAsync(targetFileUri);
      } else {
        Alert.alert('Saved', `File saved to: ${targetFileUri}`);
      }

      dataLog.current = [];
      setIsAnalyzing(false);

    } catch (error) {
      console.error('Teardown Failure:', error);
      setIsAnalyzing(false);
      Alert.alert('Error', 'Failed to finalize session.');
    }
  };

  if (isBlackout) {
    return (
      <TouchableOpacity
        style={styles.blackoutContainer}
        onPress={() => setIsBlackout(false)}
        activeOpacity={1}
      >
        <Text style={styles.hiddenText}>[ SleepScope Active - Tap Screen to Dismiss Blackout ]</Text>
      </TouchableOpacity>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>SleepScope</Text>
        <Text style={styles.subtitle}>
          {isRecording ? 'Logging Active...' : isAnalyzing ? 'AI Analyzing Session...' : 'System Idle'}
        </Text>
      </View>

      <TouchableOpacity
        style={[
          styles.button,
          isRecording ? styles.stopButton : styles.startButton,
          isAnalyzing && { opacity: 0.5 }
        ]}
        onPress={isRecording ? stopTracking : startTracking}
        disabled={isAnalyzing}
      >
        <Text style={styles.buttonText}>
          {isRecording ? 'Stop & Export Metrics' : isAnalyzing ? 'Processing...' : 'Initiate Sleep Session'}
        </Text>
      </TouchableOpacity>

      {!isRecording && summary && (
        <View style={styles.summaryCard}>
          <Text style={styles.summaryTitle}>Session Breakdown</Text>
          <Text style={styles.summaryText}>Duration: {(summary.total / 60).toFixed(1)} minutes</Text>

          <View style={styles.divider} />

          <View style={styles.statsRow}>
            <Text style={styles.statDetail}>Quiet: {((summary.quiet / summary.total) * 100).toFixed(0)}%</Text>
            <Text style={styles.statDetail}>Restless: {((summary.restless / summary.total) * 100).toFixed(0)}%</Text>
            <Text style={styles.statDetail}>Awake: {((summary.awake / summary.total) * 100).toFixed(0)}%</Text>
          </View>

          <View style={styles.divider} />
          <Text style={styles.timelineHeader}>Sleep Timeline</Text>

          <ScrollView style={styles.timelineContainer} showsVerticalScrollIndicator={false}>
            {summary.timeline.map((event, index) => (
              <View key={index} style={styles.timelineItem}>
                <Text style={styles.timelineTime}>{event.time}</Text>
                <Text style={styles.timelineState}>{event.state}</Text>
              </View>
            ))}
          </ScrollView>

          <Text style={styles.disclaimerText}>
            SleepScope estimates behavioral and environmental activity states using smartphone motion and acoustic signals powered by Groq.
          </Text>
        </View>
      )}

      {isRecording && (
        <TouchableOpacity style={styles.nightModeButton} onPress={() => setIsBlackout(true)}>
          <Text style={styles.nightModeText}>Re-engage OLED Blackout</Text>
        </TouchableOpacity>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1c1c1e', alignItems: 'center', justifyContent: 'center' },
  blackoutContainer: { flex: 1, backgroundColor: '#000000', alignItems: 'center', justifyContent: 'center' },
  header: { marginBottom: 60, alignItems: 'center' },
  title: { fontSize: 36, fontWeight: 'bold', color: '#ffffff', letterSpacing: 0.5 },
  subtitle: { fontSize: 16, color: '#8e8e93', marginTop: 8, fontWeight: '500' },
  hiddenText: { color: '#1a1a1a', fontSize: 12, fontWeight: '600' },
  button: { paddingVertical: 22, paddingHorizontal: 44, borderRadius: 35, width: '80%', alignItems: 'center' },
  startButton: { backgroundColor: '#34c759' },
  stopButton: { backgroundColor: '#ff3b30' },
  buttonText: { color: 'white', fontSize: 18, fontWeight: '700' },
  nightModeButton: { marginTop: 35, padding: 15 },
  nightModeText: { color: '#0a84ff', fontSize: 16, fontWeight: '600' },

  summaryCard: { marginTop: 40, padding: 25, backgroundColor: '#2c2c2e', borderRadius: 15, width: '90%', maxHeight: 450, alignItems: 'center' },
  summaryTitle: { color: '#ffffff', fontSize: 20, fontWeight: 'bold', marginBottom: 10 },
  summaryText: { color: '#e5e5ea', fontSize: 16, fontWeight: '500' },
  divider: { height: 1, width: '100%', backgroundColor: '#48484a', marginVertical: 15 },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between', width: '100%', paddingHorizontal: 10 },
  statDetail: { color: '#a1a1a6', fontSize: 14, fontWeight: '600' },

  timelineHeader: { color: '#ffffff', fontSize: 16, fontWeight: 'bold', marginBottom: 10, alignSelf: 'flex-start' },
  timelineContainer: { width: '100%', maxHeight: 200 },
  timelineItem: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#3a3a3c' },
  timelineTime: { color: '#8e8e93', fontSize: 14, fontWeight: '500' },
  timelineState: { color: '#34c759', fontSize: 14, fontWeight: '600' },
  disclaimerText: { color: '#8e8e93', fontSize: 10, textAlign: 'center', marginTop: 15, fontStyle: 'italic', paddingHorizontal: 5 }
});