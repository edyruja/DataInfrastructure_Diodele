import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  TextInput,
  SafeAreaView,
  StatusBar,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import * as Location from 'expo-location';
import { Accelerometer, Gyroscope } from 'expo-sensors';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

const BASE_WS_URL = 'wss://datainfrastructure-diodele.cristianstefanpopa05.workers.dev/ws';

export default function App() {
  const [driverName, setDriverName] = useState('Alex - S23');
  const [trackName, setTrackName] = useState('Circuit-Cluj');
  const [isRunning, setIsRunning] = useState(false);
  const [statusText, setStatusText] = useState('Pregătit');

  const ws = useRef(null);
  const isRunningRef = useRef(false);
  const imuBuffer = useRef([]);
  const latestGps = useRef({ lat: 0, lon: 0, speed: 0, bearing: 0 });
  const latestGyro = useRef({ x: 0, y: 0, z: 0 });
  const calibrationOffset = useRef({ x: 0, y: 0, z: 0 });
  const isCalibrated = useRef(false);
  const sessionIdRef = useRef('');

  useEffect(() => {
    isRunningRef.current = isRunning;
    let locSub = null;
    let accelSub = null;
    let gyroSub = null;
    let sendInterval = null;
    let reconnectTimeout = null;

    const connectWebSocket = () => {
      if (!isRunningRef.current) return;

      const cleanTrack = encodeURIComponent(trackName.trim() || 'Default-Track');
      const cleanDriver = encodeURIComponent(driverName.trim() || 'S23-Driver');
      const fullUrl = `${BASE_WS_URL}?session=${sessionIdRef.current}&track=${cleanTrack}&device=${cleanDriver}`;

      setStatusText('Conectare la Cloud...');
      ws.current = new WebSocket(fullUrl);

      ws.current.onopen = () => {
        setStatusText('● LIVE - Se înregistrează');
      };

      ws.current.onerror = () => {
        setStatusText('Reconectare...');
      };

      ws.current.onclose = () => {
        if (isRunningRef.current) {
          setStatusText('Semnal slab - Reconectare...');
          reconnectTimeout = setTimeout(connectWebSocket, 1000);
        }
      };
    };

    const startTelemetry = async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setStatusText('Eroare: Activează GPS-ul!');
        setIsRunning(false);
        return;
      }

      await activateKeepAwakeAsync();

      sessionIdRef.current = `ses_${Date.now()}`;
      imuBuffer.current = [];
      isCalibrated.current = false;

      connectWebSocket();

      locSub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 100,
          distanceInterval: 0,
        },
        (location) => {
          latestGps.current = {
            lat: location.coords.latitude,
            lon: location.coords.longitude,
            speed: location.coords.speed && location.coords.speed > 0 ? location.coords.speed : 0,
            bearing: location.coords.heading || 0,
          };
        }
      );

      Gyroscope.setUpdateInterval(10);
      gyroSub = Gyroscope.addListener((gyro) => {
        latestGyro.current = gyro;
      });

      Accelerometer.setUpdateInterval(10);
      accelSub = Accelerometer.addListener((accel) => {
        if (!isCalibrated.current) {
          calibrationOffset.current = { x: accel.x, y: accel.y, z: accel.z };
          isCalibrated.current = true;
        }

        const calX = accel.x - calibrationOffset.current.x;
        const calY = accel.y - calibrationOffset.current.y;
        const calZ = accel.z - calibrationOffset.current.z;

        imuBuffer.current.push({
          ts: Date.now(),
          ax: Number(calX.toFixed(4)),
          ay: Number(calY.toFixed(4)),
          az: Number(calZ.toFixed(4)),
          gx: Number(latestGyro.current.x.toFixed(4)),
          gy: Number(latestGyro.current.y.toFixed(4)),
          gz: Number(latestGyro.current.z.toFixed(4)),
        });

        if (imuBuffer.current.length > 500) {
          imuBuffer.current.shift();
        }
      });

      sendInterval = setInterval(() => {
        if (ws.current && ws.current.readyState === WebSocket.OPEN && imuBuffer.current.length > 0) {
          const samplesToSend = [...imuBuffer.current];
          imuBuffer.current = [];

          const payload = {
            session_id: sessionIdRef.current,
            device_id: driverName.trim() || 'S23-Driver',
            track_name: trackName.trim() || 'Default-Track',
            event_type: 'telemetry_batch',
            timestamp: new Date().toISOString(),
            gps: latestGps.current,
            samples: samplesToSend,
          };

          ws.current.send(JSON.stringify(payload));
        }
      }, 200);
    };

    const stopTelemetry = () => {
      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        ws.current.send(
          JSON.stringify({
            session_id: sessionIdRef.current,
            event_type: 'STOP_SESSION',
            timestamp: new Date().toISOString(),
          })
        );
        ws.current.close();
      }
      deactivateKeepAwake();
      if (sessionIdRef.current) {
        setStatusText('Sesiune salvată în Cloud');
      } else {
        setStatusText('Pregătit');
      }
    };

    if (isRunning) {
      startTelemetry();
    } else {
      stopTelemetry();
    }

    return () => {
      if (locSub) locSub.remove();
      if (accelSub) accelSub.remove();
      if (gyroSub) gyroSub.remove();
      if (sendInterval) clearInterval(sendInterval);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws.current) ws.current.close();
      deactivateKeepAwake();
    };
  }, [isRunning]);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.inner}
      >
        <View style={styles.header}>
          <Text style={styles.title}>TELEMETRY</Text>
          <View style={[styles.badge, isRunning ? styles.badgeLive : styles.badgeOff]}>
            <Text style={[styles.badgeText, isRunning && { color: '#00e676' }]}>
              {statusText}
            </Text>
          </View>
        </View>

        <View style={styles.formBox}>
          <Text style={styles.label}>NUME PILOT</Text>
          <TextInput
            style={[styles.input, isRunning && styles.inputLocked]}
            value={driverName}
            onChangeText={setDriverName}
            editable={!isRunning}
            placeholder="Introdu numele pilotului"
            placeholderTextColor="#555"
          />

          <Text style={[styles.label, { marginTop: 20 }]}>NUME CIRCUIT</Text>
          <TextInput
            style={[styles.input, isRunning && styles.inputLocked]}
            value={trackName}
            onChangeText={setTrackName}
            editable={!isRunning}
            placeholder="Introdu numele circuitului"
            placeholderTextColor="#555"
          />
        </View>

        <TouchableOpacity
          style={[styles.mainButton, isRunning ? styles.btnStop : styles.btnStart]}
          onPress={() => setIsRunning((prev) => !prev)}
          activeOpacity={0.85}
        >
          <Text style={styles.mainButtonText}>{isRunning ? 'STOP' : 'START'}</Text>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
  },
  inner: {
    flex: 1,
    justifyContent: 'space-between',
    padding: 24,
  },
  header: {
    alignItems: 'center',
    marginTop: 20,
  },
  title: {
    color: '#ffffff',
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 3,
    marginBottom: 12,
  },
  badge: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  badgeLive: {
    backgroundColor: 'rgba(0, 230, 118, 0.12)',
    borderWidth: 1,
    borderColor: '#00e676',
  },
  badgeOff: {
    backgroundColor: '#1e1e1e',
  },
  badgeText: {
    color: '#aaaaaa',
    fontSize: 14,
    fontWeight: '600',
  },
  formBox: {
    backgroundColor: '#1a1a1a',
    padding: 22,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  label: {
    color: '#888888',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#252525',
    color: '#ffffff',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    fontSize: 17,
    fontWeight: '600',
    borderWidth: 1,
    borderColor: '#333333',
  },
  inputLocked: {
    opacity: 0.4,
    color: '#999999',
  },
  mainButton: {
    height: 85,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  btnStart: {
    backgroundColor: '#00c853',
  },
  btnStop: {
    backgroundColor: '#ff1744',
  },
  mainButtonText: {
    color: '#ffffff',
    fontSize: 26,
    fontWeight: '900',
    letterSpacing: 3,
  },
});