import { Feather } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import { useKeepAwake } from 'expo-keep-awake';
import { Accelerometer, Gyroscope } from 'expo-sensors';
import * as Sharing from 'expo-sharing';
import React, { useRef, useState } from 'react';
import { Alert, Keyboard, StyleSheet, Text, TextInput, TouchableOpacity, TouchableWithoutFeedback, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Save to disk every 30 rows so a crash overnight only loses a few seconds
const FLUSH_EVERY_ROWS = 30;

// Event column is empty except on rows where the user logged a wake-up
const CSV_HEADER = 'Timestamp,Accel_X,Accel_Y,Accel_Z,Gyro_X,Gyro_Y,Gyro_Z,dB,Event';

// seconds -> "2h 34m"
const formatDuration = (totalSeconds: number): string => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return hours + 'h ' + minutes + 'm';
};

const formatClock = (isoString: string): string => {
  const date = new Date(isoString);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

// old groq labeling helper - we do labeling in python on the desktop now,
// keeping this here in case we ever want it back
//
// // helper function to handle AI rate limiting
// const fetchWithRetry = async (endpoint: string, options: any, maxRetries = 3) => {
//   for (let attempt = 1; attempt <= maxRetries; attempt++) {
//     const response = await fetch(endpoint, options);
//
//     if (response.status === 429) {
//       console.warn(`Rate limited! Retrying in ${attempt * 15} seconds...`);
//       await new Promise(resolve => setTimeout(resolve, attempt * 15000));
//       continue;
//     }
//
//     if (!response.ok) throw new Error(`API failed with status: ${response.status}`);
//     return response;
//   }
//   throw new Error("Max retries reached. Server is too busy.");
// };

export default function App() {
  // prevents the phone screen from locking during the overnight session
  useKeepAwake();

  const [participantId, setParticipantId] = useState<string>('');

  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isBlackout, setIsBlackout] = useState<boolean>(false);
  const [isFinishing, setIsFinishing] = useState<boolean>(false);

  // tips screen shown after pressing Initiate
  const [showTips, setShowTips] = useState<boolean>(false);
  const [hideTips, setHideTips] = useState<boolean>(false);

  // notes screen shown after stopping
  const [showNotes, setShowNotes] = useState<boolean>(false);
  const [sessionNotes, setSessionNotes] = useState<string>('');

  const [wakeUpCount, setWakeUpCount] = useState<number>(0);

  // wake-up reason menu
  const [showLogMenu, setShowLogMenu] = useState<boolean>(false);
  const [logNote, setLogNote] = useState<string>('');

  const [lastSession, setLastSession] = useState<{
    durationSeconds: number;
    wakeUps: number;
    startClock: string;
    endClock: string;
    file: string;
  } | null>(null);

  const startedAtRef = useRef<string>('');

  const latestAccel = useRef<{ x: number; y: number; z: number }>({ x: 0, y: 0, z: 0 });
  const latestGyro = useRef<{ x: number; y: number; z: number }>({ x: 0, y: 0, z: 0 });

  const dataLog = useRef<string[]>([]);
  const rowsSinceFlush = useRef<number>(0);
  const rowCount = useRef<number>(0);
  const fileUri = useRef<string | null>(null);

  // When the user logs a wake-up we hold the label here, and the next data row
  // picks it up and writes it into the Event column
  const pendingEvent = useRef<string>('');

  const audioRecordingRef = useRef<Audio.Recording | null>(null);
  const accelSubscriptionRef = useRef<{ remove: () => void } | null>(null);
  const gyroSubscriptionRef = useRef<{ remove: () => void } | null>(null);

  // writes the whole log (header + all rows) to the file
  const saveToPhone = async () => {
    if (fileUri.current === null) {
      return;
    }
    const fs = FileSystem as any;
    const allText = dataLog.current.join('\n');
    await fs.writeAsStringAsync(fileUri.current, allText, { encoding: 'utf8' });
    rowsSinceFlush.current = 0;
  };

  const saveWakeUp = (label: string) => {
    // commas and line breaks would break the csv columns, swap them out
    const trimmedLabel = label.trim();
    const cleanLabel = trimmedLabel.replace(/[,\r\n]+/g, ';');

    if (cleanLabel === '') {
      return;
    }

    // next data row will pick this up and put it in the Event column
    pendingEvent.current = cleanLabel;
    setWakeUpCount(wakeUpCount + 1);
    setLogNote('');
    setShowLogMenu(false);
  };

  const startTracking = async () => {
    try {
      const cleanId = participantId.trim();
      if (cleanId === '') {
        Alert.alert('Setup Incomplete', 'Enter a participant ID before starting.');
        return;
      }

      const permission = await Audio.requestPermissionsAsync();
      if (permission.status !== 'granted') {
        Alert.alert('Permission Denied', 'Microphone access is required.');
        return;
      }

      // Lines starting with # are session info, pandas skips them with
      // read_csv(comment='#')
      const startedAt = new Date().toISOString();
      startedAtRef.current = startedAt;
      const safeId = cleanId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const safeTime = startedAt.replace(/[:.]/g, '-');
      const fileName = 'sleepscope_' + safeId + '_' + safeTime + '.csv';

      const fs = FileSystem as any;
      const safeDir = fs.documentDirectory || 'file:///tmp/';
      fileUri.current = safeDir + fileName;

      dataLog.current = [
        '# participant=' + cleanId,
        '# started=' + startedAt,
        CSV_HEADER,
      ];
      rowsSinceFlush.current = 0;
      rowCount.current = 0;
      pendingEvent.current = '';
      setWakeUpCount(0);
      setSessionNotes('');
      setLastSession(null);

      // write the file right away so it exists from the start
      await saveToPhone();

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

      Gyroscope.setUpdateInterval(1000);
      gyroSubscriptionRef.current = Gyroscope.addListener(data => {
        latestGyro.current = data;
      });

      // this callback fires every second and is what writes each row
      recording.setProgressUpdateInterval(1000);
      recording.setOnRecordingStatusUpdate((status: Audio.RecordingStatus) => {
        const s = status as any;

        let currentDb = -160.0;
        if (typeof s.metering === 'number') {
          currentDb = s.metering;
        }

        const timestamp = new Date().toISOString();
        const a = latestAccel.current;
        const g = latestGyro.current;

        // grab any pending wake-up label and clear it so it only lands on this row
        const eventLabel = pendingEvent.current;
        pendingEvent.current = '';

        // Raw data only, no math on the phone - python side handles the
        // 30 second grouping later
        const row =
          timestamp + ',' +
          a.x.toFixed(4) + ',' + a.y.toFixed(4) + ',' + a.z.toFixed(4) + ',' +
          g.x.toFixed(4) + ',' + g.y.toFixed(4) + ',' + g.z.toFixed(4) + ',' +
          currentDb.toFixed(1) + ',' + eventLabel;
        dataLog.current.push(row);
        rowCount.current = rowCount.current + 1;

        rowsSinceFlush.current = rowsSinceFlush.current + 1;
        if (rowsSinceFlush.current >= FLUSH_EVERY_ROWS) {
          // don't await, saving in the background so we don't block the callback
          saveToPhone().catch(err => console.warn('Save failed:', err));
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

  // show tips first unless the user turned them off
  const handleInitiatePress = () => {
    if (hideTips) {
      startTracking();
    } else {
      setShowTips(true);
    }
  };

  const startFromTips = (turnTipsOff: boolean) => {
    if (turnTipsOff) {
      setHideTips(true);
    }
    setShowTips(false);
    startTracking();
  };

  const stopTracking = async () => {
    try {
      setIsFinishing(true);

      if (accelSubscriptionRef.current) {
        accelSubscriptionRef.current.remove();
      }
      if (gyroSubscriptionRef.current) {
        gyroSubscriptionRef.current.remove();
      }

      let audioUri: string | null = null;
      if (audioRecordingRef.current) {
        await audioRecordingRef.current.stopAndUnloadAsync();
        audioUri = audioRecordingRef.current.getURI();
        audioRecordingRef.current = null;
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      }

      // final save to catch the last rows
      await saveToPhone();

      // old groq post-processing that used to label each row here. Moved to the
      // python desktop side, keeping the original code for reference
      //
      //       const csvString = dataLog.current.join('\n');
      //       let finalExportText = "";
      //       let exportFileName = "";
      //
      //       // AI post-processing
      //       const API_KEY = process.env.EXPO_PUBLIC_GROQ_KEY;
      //       const endpoint = `https://api.groq.com/openai/v1/chat/completions`;
      //
      //       try {
      //         const aiResponse = await fetchWithRetry(endpoint, {
      //           method: 'POST',
      //           headers: {
      //             'Content-Type': 'application/json',
      //             'Authorization': `Bearer ${API_KEY}`
      //           },
      //           body: JSON.stringify({
      //             model: "llama-3.3-70b-versatile",
      //             response_format: { type: "json_object" },
      //             messages: [
      //               {
      //                 role: "system",
      //                 content: "You are a behavioral sleep classifier. The input is CSV telemetry from a smartphone. Each row represents one independent 2-minute epoch. Classify EVERY row independently as exactly one of: Quiet Sleep, Restless, or Awake.\n\nGuidelines:\n- Quiet Sleep: very little movement across all axes (low Delta XYZ) and peak audio below -45 dBFS.\n- Restless: moderate movement variance, occasional movement spikes, or isolated audio events between -45 and -30 dBFS.\n- Awake: high movement across multiple axes, very high movement variance, or peak audio louder than -30 dBFS.\n\nRules:\n- Use only the telemetry provided.\n- Do not infer REM sleep, deep sleep, light sleep, or medical conditions.\n- Preserve the timestamps exactly as provided.\n- Return one classification for every input row.\n- Do not omit or merge rows.\n\nReturn ONLY a JSON object containing a single key called 'epochs' that holds an array of objects. Each object must have 'timestamp' and 'state'."
      //               },
      //               {
      //                 role: "user",
      //                 content: csvString
      //               }
      //             ]
      //           })
      //         });
      //
      //         const jsonResponse = await aiResponse.json();
      //
      //         const rawAiText = jsonResponse.choices[0].message.content;
      //         const parsedData = JSON.parse(rawAiText);
      //         const aiEpochs = parsedData.epochs;
      //
      //         // multiply array length by 120 seconds to get total duration
      //         let calcTotal = aiEpochs.length * 120;
      //         let calcAwake = 0;
      //         let calcRestless = 0;
      //         let calcQuiet = 0;
      //         const timelineArray: { time: string; state: string }[] = [];
      //         let lastState = null;
      //
      //         for (const epoch of aiEpochs) {
      //           if (epoch.state === 'Awake') calcAwake += 120;
      //           else if (epoch.state === 'Restless') calcRestless += 120;
      //           else if (epoch.state === 'Quiet Sleep') calcQuiet += 120;
      //
      //           // build a merged timeline for the UI (only log when the state changes)
      //           if (epoch.state !== lastState) {
      //             const timeObj = new Date(epoch.timestamp);
      //             const formattedTime = timeObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      //
      //             timelineArray.push({
      //               time: formattedTime,
      //               state: epoch.state
      //             });
      //             lastState = epoch.state;
      //           }
      //         }
      //
      //         setSummary({
      //           total: calcTotal,
      //           awake: calcAwake,
      //           restless: calcRestless,
      //           quiet: calcQuiet,
      //           timeline: timelineArray
      //         });
      //
      //         finalExportText = JSON.stringify(aiEpochs, null, 2);
      //         exportFileName = `sleep_analysis_${Date.now()}.json`;
      //
      //       } catch (aiError) {
      //         console.error("AI Analysis Failed:", aiError);
      //         Alert.alert("Analysis Error", "The AI failed to process the data. Exporting raw CSV as a fallback.");
      //
      //         // Fallback: If the API fails for some reason, export the CSV so the data isn't lost
      //         // we can still have csv data and we can feed this into ai later
      //         finalExportText = csvString;
      //         exportFileName = `fallback_raw_data_${Date.now()}.csv`;
      //       }

      setIsRecording(false);
      setIsBlackout(false);

      // We only needed the audio for the dB metering, delete the actual sound file
      if (audioUri) {
        const fs = FileSystem as any;
        await fs.deleteAsync(audioUri, { idempotent: true });
      }

      // notes screen comes before the export
      setShowNotes(true);
      setIsFinishing(false);
    } catch (error) {
      console.error('Teardown Failure:', error);
      setIsFinishing(false);
      Alert.alert('Error', 'Failed to finalize session.');
    }
  };

  const saveNotesAndExport = async () => {
    try {
      // note has to stay on one line, a second line wouldn't start with #
      // and would look like a data row
      const trimmedNote = sessionNotes.trim();
      const note = trimmedNote.replace(/[\r\n]+/g, ' ');

      if (note !== '') {
        dataLog.current.push('# note=' + note);
        await saveToPhone();
      }

      const savedFileUri = fileUri.current;
      if (savedFileUri) {
        const sharing = Sharing as any;
        if (await sharing.isAvailableAsync()) {
          await sharing.shareAsync(savedFileUri);
        } else {
          Alert.alert('Saved', 'File saved to: ' + savedFileUri);
        }

        const parts = savedFileUri.split('/');
        const shortName = parts[parts.length - 1];

        // one row per second, so row count = seconds recorded
        setLastSession({
          durationSeconds: rowCount.current,
          wakeUps: wakeUpCount,
          startClock: formatClock(startedAtRef.current),
          endClock: formatClock(new Date().toISOString()),
          file: shortName,
        });
      }

      setShowNotes(false);
    } catch (error) {
      console.error('Export Failure:', error);
      Alert.alert('Error', 'Failed to export the file.');
    }
  };

  // blackout screen
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

  // wake-up reason menu
  if (isRecording && showLogMenu) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Log Wake-Up</Text>
          <Text style={styles.subtitle}>What caused the disruption?</Text>
        </View>

        <View style={styles.setupCard}>
          <TouchableOpacity style={styles.optionButton} onPress={() => saveWakeUp('bathroom')}>
            <Feather name="log-out" size={18} color="#e2e8f0" />
            <Text style={styles.optionText}>Bathroom / Out of Bed</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.optionButton} onPress={() => saveWakeUp('awake_in_bed')}>
            <Feather name="eye" size={18} color="#e2e8f0" />
            <Text style={styles.optionText}>Awake in Bed</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.optionButton} onPress={() => saveWakeUp('noise')}>
            <Feather name="volume-x" size={18} color="#e2e8f0" />
            <Text style={styles.optionText}>Noise / Disturbance</Text>
          </TouchableOpacity>

          <Text style={styles.setupLabel}>Or write your own note</Text>
          <TextInput
            style={styles.input}
            value={logNote}
            onChangeText={setLogNote}
            placeholder="e.g. bad dream"
            placeholderTextColor="#64748b"
          />
          <TouchableOpacity style={styles.secondaryButton} onPress={() => saveWakeUp(logNote)}>
            <Feather name="check" size={18} color="#e2e8f0" />
            <Text style={styles.optionText}>Save Note</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.nightModeButton} onPress={() => setShowLogMenu(false)}>
          <Text style={styles.nightModeText}>Cancel</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // Tips screen
  if (showTips) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.tipsCard}>
          <View style={styles.iconCircle}>
            <Feather name="info" size={24} color="#818cf8" />
          </View>
          <Text style={styles.tipsTitle}>Before You Start</Text>

          <View style={styles.tipRow}>
            <Feather name="clock" size={20} color="#94a3b8" />
            <Text style={styles.tipText}>Start the app BEFORE you get into bed, so it captures the time you spend lying awake.</Text>
          </View>
          <View style={styles.tipRow}>
            <Feather name="smartphone" size={20} color="#94a3b8" />
            <Text style={styles.tipText}>Place the phone flat on the mattress next to you.</Text>
          </View>
          <View style={styles.tipRow}>
            <Feather name="battery-charging" size={20} color="#94a3b8" />
            <Text style={styles.tipText}>Keep the phone plugged in and leave the app open all night.</Text>
          </View>

          <TouchableOpacity style={[styles.button, styles.startButton, { width: '100%', alignSelf: 'center' }]} onPress={() => startFromTips(false)}>
            <Text style={styles.buttonText}>Got It - Start Session</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.tipsHideButton} onPress={() => startFromTips(true)}>
            <Text style={styles.tipsHideText}>Don't Show Tips Again</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Notes screen. Kept near the top of the screen so the keyboard doesn't
  // cover the box, tapping outside closes the keyboard
  if (showNotes) {
    return (
      <TouchableWithoutFeedback onPress={() => Keyboard.dismiss()}>
        <SafeAreaView style={styles.notesContainer}>
          <View style={styles.header}>
            <Text style={styles.title}>Session Notes</Text>
            <Text style={styles.subtitle}>Add anything you remember (optional) </Text>
          </View>

          <View style={styles.setupCard}>
            <Text style={styles.setupLabel}>Notes</Text>
            <TextInput
              style={styles.notesInput}
              value={sessionNotes}
              onChangeText={setSessionNotes}
              placeholder="e.g. woke up feeling extremely rested, dog barked around 4AM..."
              placeholderTextColor="#64748b"
              multiline={true}
            />
          </View>

          <TouchableOpacity style={[styles.button, styles.startButton]} onPress={saveNotesAndExport}>
            <Feather name="share" size={20} color="white" />
            <Text style={styles.buttonText}>Save & Export CSV</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </TouchableWithoutFeedback>
    );
  }

  // main screen
  let statusText = 'Logs your sleep data';
  let StatusIcon = <Feather name="database" size={16} color="#94a3b8" style={{ marginRight: 6 }} />;

  if (isRecording) {
    statusText = 'Logging Active...';
    StatusIcon = <Feather name="activity" size={16} color="#10b981" style={{ marginRight: 6 }} />;
  } else if (isFinishing) {
    statusText = 'Saving Session...';
    StatusIcon = <Feather name="loader" size={16} color="#f59e0b" style={{ marginRight: 6 }} />;
  }

  let buttonLabel = 'Initiate Sleep Session';
  if (isRecording) {
    buttonLabel = 'Stop & Export CSV';
  } else if (isFinishing) {
    buttonLabel = 'Saving...';
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Feather name="moon" size={32} color="#818cf8" />
          <Text style={styles.title}>SleepScope</Text>
        </View>
        <View style={styles.statusBadge}>
          {StatusIcon}
          <Text style={styles.subtitle}>{statusText}</Text>
        </View>
      </View>

      {!isRecording && !isFinishing && (
        <View style={styles.setupCard}>
          <Text style={styles.setupLabel}>Participant ID</Text>
          <TextInput
            style={styles.input}
            value={participantId}
            onChangeText={setParticipantId}
            placeholder="e.g. P01"
            placeholderTextColor="#64748b"
            autoCapitalize="characters"
            autoCorrect={false}
          />
        </View>
      )}

      <TouchableOpacity
        style={[
          styles.button,
          isRecording ? styles.stopButton : styles.startButton,
          isFinishing && { opacity: 0.5 },
        ]}
        onPress={isRecording ? stopTracking : handleInitiatePress}
        disabled={isFinishing}
      >
        {!isRecording && !isFinishing && <Feather name="play" size={20} color="white" />}
        {isRecording && <Feather name="square" size={20} color="#f8fafc" />}
        <Text style={styles.buttonText}>{buttonLabel}</Text>
      </TouchableOpacity>

      {isRecording && (
        <TouchableOpacity style={styles.wakeButton} onPress={() => setShowLogMenu(true)}>
          <Feather name="edit-3" size={18} color="#818cf8" />
          <Text style={styles.wakeButtonText}>Log Wake-Up ({wakeUpCount})</Text>
        </TouchableOpacity>
      )}

      {isRecording && (
        <TouchableOpacity style={styles.nightModeButton} onPress={() => setIsBlackout(true)}>
          <Feather name="eye-off" size={16} color="#94a3b8" style={{ marginRight: 6 }} />
          <Text style={styles.nightModeText}>Re-engage OLED Blackout</Text>
        </TouchableOpacity>
      )}

      {!isRecording && !isFinishing && lastSession && (
        <View style={styles.summaryCard}>
          <Text style={styles.summaryTitle}>Last Session</Text>

          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Recording Duration</Text>
            <Text style={styles.statValue}>{formatDuration(lastSession.durationSeconds)}</Text>
          </View>

          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Wake-Ups Logged</Text>
            <Text style={styles.statValue}>{lastSession.wakeUps}</Text>
          </View>

          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Time Window</Text>
            <Text style={styles.statValue}>{lastSession.startClock} - {lastSession.endClock}</Text>
          </View>

          <Text style={styles.summaryFile}>{lastSession.file}</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a', alignItems: 'center', justifyContent: 'center' },
  notesContainer: { flex: 1, backgroundColor: '#0f172a', alignItems: 'center', justifyContent: 'flex-start', paddingTop: 60 },
  blackoutContainer: { flex: 1, backgroundColor: '#000000', alignItems: 'center', justifyContent: 'center' },

  header: { marginBottom: 40, alignItems: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  title: { fontSize: 36, fontWeight: '800', color: '#f8fafc', letterSpacing: 0.5, marginLeft: 8 },
  statusBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1e293b', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: '#334155' },
  subtitle: { fontSize: 14, color: '#e2e8f0', fontWeight: '600' },
  hiddenText: { color: '#1a1a1a', fontSize: 12, fontWeight: '600' },

  // Cards mapped to Tailwind slate-900 with slate-800 borders
  setupCard: { width: '85%', padding: 24, backgroundColor: '#1e293b', borderRadius: 20, borderWidth: 1, borderColor: '#334155', marginBottom: 30, shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.2, shadowRadius: 15 },
  setupLabel: { color: '#cbd5e1', fontSize: 14, fontWeight: '700', marginBottom: 10, marginTop: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    backgroundColor: '#0f172a', color: '#f8fafc', fontSize: 16, paddingVertical: 14,
    paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: '#475569',
  },
  notesInput: {
    backgroundColor: '#0f172a', color: '#f8fafc', fontSize: 16, paddingVertical: 14,
    paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: '#475569',
    height: 120, textAlignVertical: 'top',
  },

  featureBox: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(245, 158, 11, 0.1)', padding: 14, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(245, 158, 11, 0.2)', marginTop: 20 },
  featureIconWrap: { backgroundColor: 'rgba(245, 158, 11, 0.2)', padding: 8, borderRadius: 10, marginRight: 12 },
  featureTextWrap: { flex: 1 },
  featureTitle: { color: '#fbbf24', fontWeight: '700', fontSize: 15, marginBottom: 2 },
  featureSub: { color: '#cbd5e1', fontSize: 12 },

  tipsCard: { width: '85%', padding: 28, backgroundColor: '#1e293b', borderRadius: 20, borderWidth: 1, borderColor: '#334155' },
  iconCircle: { alignSelf: 'center', backgroundColor: 'rgba(99, 102, 241, 0.1)', padding: 16, borderRadius: 50, marginBottom: 16 },
  tipsTitle: { color: '#f8fafc', fontSize: 24, fontWeight: '800', marginBottom: 24, textAlign: 'center' },
  tipRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 16, paddingRight: 10 },
  tipText: { color: '#cbd5e1', fontSize: 15, marginLeft: 12, lineHeight: 22 },
  tipsHideButton: { paddingVertical: 16, alignItems: 'center', marginTop: 10 },
  tipsHideText: { color: '#64748b', fontSize: 15, fontWeight: '600' },

  button: { paddingVertical: 18, paddingHorizontal: 32, borderRadius: 16, width: '85%', alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 10 },
  startButton: { backgroundColor: '#4f46e5', shadowColor: '#4f46e5', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 12 },
  stopButton: { backgroundColor: '#1e293b', borderWidth: 1, borderColor: '#ef4444' },
  secondaryButton: { backgroundColor: '#334155', paddingVertical: 16, borderRadius: 12, alignItems: 'center', marginTop: 12, flexDirection: 'row', justifyContent: 'center', gap: 8 },
  buttonText: { color: 'white', fontSize: 18, fontWeight: '700' },

  wakeButton: { marginTop: 30, paddingVertical: 16, paddingHorizontal: 32, borderRadius: 16, borderWidth: 1, borderColor: '#4f46e5', backgroundColor: 'rgba(79, 70, 229, 0.1)', flexDirection: 'row', alignItems: 'center', gap: 10 },
  wakeButtonText: { color: '#818cf8', fontSize: 16, fontWeight: '700' },

  optionButton: { backgroundColor: '#334155', paddingVertical: 16, borderRadius: 12, alignItems: 'center', marginTop: 12, flexDirection: 'row', justifyContent: 'center', gap: 10 },
  optionText: { color: '#f8fafc', fontSize: 16, fontWeight: '600' },

  nightModeButton: { marginTop: 24, padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  nightModeText: { color: '#94a3b8', fontSize: 15, fontWeight: '600' },

  summaryCard: { marginTop: 40, padding: 24, backgroundColor: '#1e293b', borderRadius: 20, borderWidth: 1, borderColor: '#334155', width: '85%' },
  summaryTitle: { color: '#f8fafc', fontSize: 18, fontWeight: '800', marginBottom: 18, textAlign: 'center' },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#334155' },
  statLabel: { color: '#94a3b8', fontSize: 15, fontWeight: '600' },
  statValue: { color: '#f8fafc', fontSize: 16, fontWeight: '700' },
  summaryFile: { color: '#64748b', fontSize: 12, marginTop: 16, textAlign: 'center', fontVariant: ['tabular-nums'] },
});