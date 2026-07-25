import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import { useKeepAwake } from 'expo-keep-awake';
import { Accelerometer, Gyroscope } from 'expo-sensors';
import * as Sharing from 'expo-sharing';
import React, { useRef, useState } from 'react';
import { Alert, Keyboard, StyleSheet, Text, TextInput, TouchableOpacity, TouchableWithoutFeedback, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// save every 30 rows so a crash doesn't lose much
const FLUSH_EVERY_ROWS = 30;

// Event is empty except on rows where a wake-up was logged
const CSV_HEADER = 'Timestamp,Accel_X,Accel_Y,Accel_Z,Gyro_X,Gyro_Y,Gyro_Z,dB,Event';

const formatDuration = (totalSeconds: number): string => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return hours + 'h ' + minutes + 'm';
};

const formatClock = (isoString: string): string => {
  const date = new Date(isoString);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export default function App() {
  // keep the screen on all night
  useKeepAwake();

  const [participantId, setParticipantId] = useState<string>('');

  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isBlackout, setIsBlackout] = useState<boolean>(false);
  const [isFinishing, setIsFinishing] = useState<boolean>(false);

  // tips screen
  const [showTips, setShowTips] = useState<boolean>(false);
  const [hideTips, setHideTips] = useState<boolean>(false);

  // notes screen
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

  // holds a wake-up label until the next row writes it
  const pendingEvent = useRef<string>('');

  const audioRecordingRef = useRef<Audio.Recording | null>(null);
  const accelSubscriptionRef = useRef<{ remove: () => void } | null>(null);
  const gyroSubscriptionRef = useRef<{ remove: () => void } | null>(null);

  // writes the whole log to the file
  const saveToPhone = async () => {
    if (fileUri.current === null) {
      return;
    }
    const allText = dataLog.current.join('\n');
    await FileSystem.writeAsStringAsync(fileUri.current, allText, { encoding: 'utf8' });
  };

  const saveWakeUp = (label: string) => {
    // commas and line breaks would break the csv columns
    const trimmedLabel = label.trim();
    const cleanLabel = trimmedLabel.replace(/[,\r\n]+/g, ';');

    if (cleanLabel === '') {
      return;
    }

    pendingEvent.current = cleanLabel;
    setWakeUpCount(count => count + 1);
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

      // # lines are session info, pandas can skip them
      const startedAt = new Date().toISOString();
      startedAtRef.current = startedAt;
      const safeId = cleanId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const safeTime = startedAt.replace(/[:.]/g, '-');
      const fileName = 'sleepscope_' + safeId + '_' + safeTime + '.csv';

      const safeDir = FileSystem.documentDirectory || 'file:///tmp/';
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

      // write it once so the file exists from the start
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

      // fires every second, writes one row
      recording.setProgressUpdateInterval(1000);
      recording.setOnRecordingStatusUpdate((status: Audio.RecordingStatus) => {
        let currentDb = -160.0;
        if (typeof status.metering === 'number') {
          currentDb = status.metering;
        }

        const timestamp = new Date().toISOString();
        const a = latestAccel.current;
        const g = latestGyro.current;

        // take the pending label so it only lands on this row
        const eventLabel = pendingEvent.current;
        pendingEvent.current = '';

        // raw data only, python does the math later
        const row =
          timestamp + ',' +
          a.x.toFixed(4) + ',' + a.y.toFixed(4) + ',' + a.z.toFixed(4) + ',' +
          g.x.toFixed(4) + ',' + g.y.toFixed(4) + ',' + g.z.toFixed(4) + ',' +
          currentDb.toFixed(1) + ',' + eventLabel;
        dataLog.current.push(row);
        rowCount.current = rowCount.current + 1;

        rowsSinceFlush.current = rowsSinceFlush.current + 1;
        if (rowsSinceFlush.current >= FLUSH_EVERY_ROWS) {
          // reset before saving, otherwise the next tick starts a second write
          rowsSinceFlush.current = 0;
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

      // last save, catches the rows since the previous flush
      await saveToPhone();

      setIsRecording(false);
      setIsBlackout(false);

      // only needed the dB numbers, not the audio itself
      if (audioUri) {
        await FileSystem.deleteAsync(audioUri, { idempotent: true });
      }

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
      // keep it on one line, otherwise it looks like a data row
      const trimmedNote = sessionNotes.trim();
      const note = trimmedNote.replace(/[\r\n]+/g, ' ');

      if (note !== '') {
        dataLog.current.push('# note=' + note);
        await saveToPhone();
      }

      const savedFileUri = fileUri.current;
      if (savedFileUri) {
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(savedFileUri);
        } else {
          Alert.alert('Saved', 'File saved to: ' + savedFileUri);
        }

        const parts = savedFileUri.split('/');
        const shortName = parts[parts.length - 1];

        // one row per second, so rows = seconds
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
          <Text style={styles.subtitle}>Why did you wake up?</Text>
        </View>

        <View style={styles.setupCard}>
          <TouchableOpacity style={styles.optionButton} onPress={() => saveWakeUp('bathroom')}>
            <Text style={styles.optionText}>Bathroom / Out of Bed</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.optionButton} onPress={() => saveWakeUp('awake_in_bed')}>
            <Text style={styles.optionText}>Awake in Bed</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.optionButton} onPress={() => saveWakeUp('noise')}>
            <Text style={styles.optionText}>Noise / Disturbance</Text>
          </TouchableOpacity>

          <Text style={styles.setupLabel}>Or write your own note</Text>
          <TextInput
            style={styles.input}
            value={logNote}
            onChangeText={setLogNote}
            placeholder="e.g. bad dream"
            placeholderTextColor="#6c6c70"
          />
          <TouchableOpacity style={styles.optionButton} onPress={() => saveWakeUp(logNote)}>
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
          <Text style={styles.tipsTitle}>Before You Start</Text>

          <Text style={styles.tipText}>
            1. Start the app BEFORE you get into bed, so it captures the time you spend lying awake.
          </Text>
          <Text style={styles.tipText}>
            2. Place the phone flat on the mattress next to you.
          </Text>
          <Text style={styles.tipText}>
            3. Keep the phone plugged in and leave the app open all night.
          </Text>

          <TouchableOpacity style={styles.tipsStartButton} onPress={() => startFromTips(false)}>
            <Text style={styles.buttonText}>Got It - Start Session</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.tipsHideButton} onPress={() => startFromTips(true)}>
            <Text style={styles.tipsHideText}>{"Don't Show Tips Again"}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // notes screen, sits up top so the keyboard doesn't cover the box
  if (showNotes) {
    return (
      <TouchableWithoutFeedback onPress={() => Keyboard.dismiss()}>
        <SafeAreaView style={styles.notesContainer}>
          <View style={styles.header}>
            <Text style={styles.title}>Session Notes</Text>
            <Text style={styles.subtitle}>Add anything you remember (optional)</Text>
          </View>

          <View style={styles.setupCard}>
            <Text style={styles.setupLabel}>Notes</Text>
            <TextInput
              style={styles.notesInput}
              value={sessionNotes}
              onChangeText={setSessionNotes}
              placeholder="dog barked"
              placeholderTextColor="#6c6c70"
              multiline={true}
            />
          </View>

          <TouchableOpacity style={[styles.button, styles.startButton]} onPress={saveNotesAndExport}>
            <Text style={styles.buttonText}>Save & Export CSV</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </TouchableWithoutFeedback>
    );
  }

  // main screen
  let statusText = 'Data Logger';
  if (isRecording) {
    statusText = 'Logging Active...';
  } else if (isFinishing) {
    statusText = 'Saving Session...';
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
        <Text style={styles.title}>SleepScope</Text>
        <Text style={styles.subtitle}>{statusText}</Text>
      </View>

      {!isRecording && !isFinishing && (
        <View style={styles.setupCard}>
          <Text style={styles.setupLabel}>Participant ID</Text>
          <TextInput
            style={styles.input}
            value={participantId}
            onChangeText={setParticipantId}
            placeholder="e.g. P01"
            placeholderTextColor="#6c6c70"
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
        <Text style={styles.buttonText}>{buttonLabel}</Text>
      </TouchableOpacity>

      {isRecording && (
        <TouchableOpacity style={styles.wakeButton} onPress={() => setShowLogMenu(true)}>
          <Text style={styles.wakeButtonText}>Log Wake-Up ({wakeUpCount})</Text>
        </TouchableOpacity>
      )}

      {isRecording && (
        <TouchableOpacity style={styles.nightModeButton} onPress={() => setIsBlackout(true)}>
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
            <Text style={styles.statLabel}>Start / End</Text>
            <Text style={styles.statValue}>{lastSession.startClock} - {lastSession.endClock}</Text>
          </View>

          <Text style={styles.summaryFile}>{lastSession.file}</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1c1c1e', alignItems: 'center', justifyContent: 'center' },
  notesContainer: { flex: 1, backgroundColor: '#1c1c1e', alignItems: 'center', justifyContent: 'flex-start', paddingTop: 60 },

  blackoutContainer: { flex: 1, backgroundColor: '#000000', alignItems: 'center', justifyContent: 'center' },

  header: { marginBottom: 40, alignItems: 'center' },
  title: { fontSize: 36, fontWeight: 'bold', color: '#ffffff', letterSpacing: 0.5 },
  subtitle: { fontSize: 16, color: '#8e8e93', marginTop: 8, fontWeight: '500' },
  hiddenText: { color: '#1a1a1a', fontSize: 12, fontWeight: '600' },

  setupCard: { width: '85%', padding: 20, backgroundColor: '#2c2c2e', borderRadius: 15, marginBottom: 30 },
  setupLabel: { color: '#e5e5ea', fontSize: 14, fontWeight: '600', marginBottom: 8, marginTop: 8 },
  input: {
    backgroundColor: '#1c1c1e', color: '#ffffff', fontSize: 16, paddingVertical: 12,
    paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: '#48484a',
  },
  notesInput: {
    backgroundColor: '#1c1c1e', color: '#ffffff', fontSize: 16, paddingVertical: 12,
    paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: '#48484a',
    height: 120, textAlignVertical: 'top',
  },

  tipsCard: { width: '85%', padding: 25, backgroundColor: '#2c2c2e', borderRadius: 15 },
  tipsTitle: { color: '#ffffff', fontSize: 22, fontWeight: 'bold', marginBottom: 18, textAlign: 'center' },
  tipText: { color: '#e5e5ea', fontSize: 16, marginBottom: 14, lineHeight: 22 },
  tipsStartButton: { backgroundColor: '#34c759', paddingVertical: 18, borderRadius: 30, alignItems: 'center', marginTop: 10 },
  tipsHideButton: { paddingVertical: 14, alignItems: 'center', marginTop: 6 },
  tipsHideText: { color: '#8e8e93', fontSize: 15, fontWeight: '600' },

  button: { paddingVertical: 22, paddingHorizontal: 44, borderRadius: 35, width: '80%', alignItems: 'center' },
  startButton: { backgroundColor: '#34c759' },
  stopButton: { backgroundColor: '#ff3b30' },
  buttonText: { color: 'white', fontSize: 18, fontWeight: '700' },

  wakeButton: { marginTop: 25, paddingVertical: 14, paddingHorizontal: 30, borderRadius: 25, borderWidth: 1, borderColor: '#0a84ff' },
  wakeButtonText: { color: '#0a84ff', fontSize: 16, fontWeight: '700' },

  optionButton: { backgroundColor: '#0a84ff', paddingVertical: 15, borderRadius: 12, alignItems: 'center', marginTop: 10 },
  optionText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },

  nightModeButton: { marginTop: 20, padding: 15 },
  nightModeText: { color: '#0a84ff', fontSize: 16, fontWeight: '600' },

  summaryCard: { marginTop: 40, padding: 20, backgroundColor: '#2c2c2e', borderRadius: 15, width: '85%' },
  summaryTitle: { color: '#ffffff', fontSize: 18, fontWeight: 'bold', marginBottom: 14, textAlign: 'center' },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#3a3a3c' },
  statLabel: { color: '#8e8e93', fontSize: 15, fontWeight: '500' },
  statValue: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  summaryFile: { color: '#8e8e93', fontSize: 12, marginTop: 12, textAlign: 'center' },
});
