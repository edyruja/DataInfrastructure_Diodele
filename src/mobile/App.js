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
  ScrollView,
} from 'react-native';
import * as Location from 'expo-location';
import { DeviceMotion, Gyroscope } from 'expo-sensors';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

const BASE_WS_URL = 'wss://datainfrastructure-diodele.cristianstefanpopa05.workers.dev/ws';

// Circuit Cluj Demo Waypoints pentru Simulator (buclă închisă de ~1.8 km)
const SIM_TRACK_WAYPOINTS = [
  { lat: 46.77000, lon: 23.60000, speed: 195, gLat: 0.1,  gBrake: 0,    apex: 0 }, // Linia dreaptă start/sosire
  { lat: 46.77120, lon: 23.60040, speed: 225, gLat: 0.2,  gBrake: 0,    apex: 0 },
  { lat: 46.77240, lon: 23.60080, speed: 235, gLat: 0.1,  gBrake: 0.8,  apex: 0 }, // Frânare Turn 1
  { lat: 46.77320, lon: 23.60150, speed: 110, gLat: 1.35, gBrake: 0.3,  apex: 1 }, // Turn 1 Apex
  { lat: 46.77380, lon: 23.60280, speed: 140, gLat: 0.85, gBrake: 0,    apex: 0 },
  { lat: 46.77450, lon: 23.60420, speed: 175, gLat: 0.3,  gBrake: 0,    apex: 0 }, // Sector 2
  { lat: 46.77530, lon: 23.60600, speed: 210, gLat: 0.15, gBrake: 1.1,  apex: 0 }, // Frânare Ac de păr
  { lat: 46.77550, lon: 23.60680, speed: 82,  gLat: 1.65, gBrake: 0.2,  apex: 1 }, // Hairpin Apex
  { lat: 46.77480, lon: 23.60740, speed: 120, gLat: 0.9,  gBrake: 0,    apex: 0 },
  { lat: 46.77360, lon: 23.60660, speed: 165, gLat: 0.4,  gBrake: 0,    apex: 0 }, // Șicane
  { lat: 46.77250, lon: 23.60520, speed: 135, gLat: 1.25, gBrake: 0.1,  apex: 1 }, // Chicane Apex
  { lat: 46.77150, lon: 23.60350, speed: 180, gLat: 0.5,  gBrake: 0,    apex: 0 },
  { lat: 46.77060, lon: 23.60180, speed: 190, gLat: 0.2,  gBrake: 0.3,  apex: 0 }, // Ultimul viraj
  { lat: 46.77010, lon: 23.60060, speed: 170, gLat: 0.8,  gBrake: 0,    apex: 1 },
];

export default function App() {
  // Preset implicit adaptat platformei (iPhone vs Android)
  const defaultDriver = Platform.OS === 'ios' ? 'Cristi - iPhone' : 'Alex - S23';
  const [driverName, setDriverName] = useState(defaultDriver);
  const [trackName, setTrackName] = useState('Circuit-Cluj');
  const [isSimulatorMode, setIsSimulatorMode] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [statusText, setStatusText] = useState('Pregătit');

  // Metrici live afișate pe ecranul telefonului
  const [liveStats, setLiveStats] = useState({
    speedKmh: 0,
    gForce: 0,
    pointsSent: 0,
  });

  const ws = useRef(null);
  const isRunningRef = useRef(false);
  const isSimulatorModeRef = useRef(false);
  const imuBuffer = useRef([]);
  const retryQueue = useRef([]);
  const latestGps = useRef({ lat: 46.77000, lon: 23.60000, speed: 0, bearing: 0 });
  const latestGyro = useRef({ x: 0, y: 0, z: 0 });
  const sessionIdRef = useRef('');
  const pointsSentCounter = useRef(0);
  const simStepRef = useRef(0);

  useEffect(() => {
    isRunningRef.current = isRunning;
    isSimulatorModeRef.current = isSimulatorMode;
    let locSub = null;
    let accelSub = null;
    let gyroSub = null;
    let sendInterval = null;
    let simInterval = null;
    let reconnectTimeout = null;

    const flushRetryQueue = () => {
      while (retryQueue.current.length > 0 && ws.current && ws.current.readyState === WebSocket.OPEN) {
        const queued = retryQueue.current.shift();
        try {
          ws.current.send(JSON.stringify(queued));
          pointsSentCounter.current += queued.samples ? queued.samples.length : 1;
        } catch (err) {
          retryQueue.current.unshift(queued);
          break;
        }
      }
    };

    const connectWebSocket = () => {
      if (!isRunningRef.current) return;

      const cleanTrack = encodeURIComponent(trackName.trim() || 'Default-Track');
      const cleanDriver = encodeURIComponent(driverName.trim() || defaultDriver);
      const fullUrl = `${BASE_WS_URL}?session=${sessionIdRef.current}&track=${cleanTrack}&device=${cleanDriver}`;

      setStatusText('Conectare la Cloud...');
      ws.current = new WebSocket(fullUrl);

      ws.current.onopen = () => {
        const modeLabel = isSimulatorModeRef.current ? 'SIMULATOR F1' : 'LIVE SENZORI';
        setStatusText(`● LIVE (${modeLabel})`);
        flushRetryQueue();
      };

      ws.current.onerror = () => {
        setStatusText('Reconectare...');
      };

      ws.current.onclose = () => {
        if (isRunningRef.current) {
          const qCount = retryQueue.current.length;
          setStatusText(
            qCount > 0
              ? `Buffer offline (${qCount}) - Reconectare...`
              : 'Semnal slab - Reconectare...'
          );
          reconnectTimeout = setTimeout(connectWebSocket, 1000);
        }
      };
    };

    const startTelemetry = async () => {
      await activateKeepAwakeAsync().catch(() => {});

      // Generare Session ID unic ce include numele pilotului pentru a preveni coliziunile multi-user
      const cleanTag = (driverName.trim() || defaultDriver).replace(/[^a-zA-Z0-9]/g, '_');
      sessionIdRef.current = `ses_${cleanTag}_${Date.now()}`;
      imuBuffer.current = [];
      retryQueue.current = [];
      pointsSentCounter.current = 0;
      simStepRef.current = 0;

      // Dacă e mod simulator, inițializăm GPS cu primul waypoint ÎNAINTE de connect
      // astfel primul batch trimis are speed corect (nu 0)
      if (isSimulatorModeRef.current) {
        const wp0 = SIM_TRACK_WAYPOINTS[0];
        const wp1 = SIM_TRACK_WAYPOINTS[1];
        const dLon0 = wp1.lon - wp0.lon;
        const y0 = Math.sin(dLon0) * Math.cos(wp1.lat);
        const x0 = Math.cos(wp0.lat) * Math.sin(wp1.lat) - Math.sin(wp0.lat) * Math.cos(wp1.lat) * Math.cos(dLon0);
        const initBearing = (Math.atan2(y0, x0) * (180 / Math.PI) + 360) % 360;
        latestGps.current = {
          lat: wp0.lat,
          lon: wp0.lon,
          speed: wp0.speed / 3.6, // km/h → m/s
          bearing: initBearing,
        };
      }

      connectWebSocket();

      if (isSimulatorModeRef.current) {
        // ── MOD SIMULATOR F1 (permite generare simultană pentru juriu fără GPS fizic) ──
        simInterval = setInterval(() => {
          if (!isRunningRef.current) return;

          const totalWp = SIM_TRACK_WAYPOINTS.length;
          const currentIdx = Math.floor(simStepRef.current) % totalWp;
          const nextIdx = (currentIdx + 1) % totalWp;
          const progress = simStepRef.current - Math.floor(simStepRef.current);

          const wp1 = SIM_TRACK_WAYPOINTS[currentIdx];
          const wp2 = SIM_TRACK_WAYPOINTS[nextIdx];

          // Interpolare lină GPS între jaloane
          const lat = wp1.lat + (wp2.lat - wp1.lat) * progress;
          const lon = wp1.lon + (wp2.lon - wp1.lon) * progress;
          const speedKmh = wp1.speed + (wp2.speed - wp1.speed) * progress;
          const speedMs = speedKmh / 3.6;

          // Calcul unghi direcție (bearing)
          const dLon = wp2.lon - wp1.lon;
          const y = Math.sin(dLon) * Math.cos(wp2.lat);
          const x = Math.cos(wp1.lat) * Math.sin(wp2.lat) - Math.sin(wp1.lat) * Math.cos(wp2.lat) * Math.cos(dLon);
          const bearing = (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;

          latestGps.current = { lat, lon, speed: speedMs, bearing };

          // Generare mostre IMU simulate (Forțe G laterale și de frânare realiste)
          const gLat = wp1.gLat + (wp2.gLat - wp1.gLat) * progress + (Math.random() - 0.5) * 0.08;
          const gBrake = wp1.gBrake + (wp2.gBrake - wp1.gBrake) * progress;
          const gLon = gBrake > 0 ? -gBrake : 0.35; // Accelerație pozitivă la ieșire din viraj

          imuBuffer.current.push({
            ts: Date.now(),
            ax: Number(gLat.toFixed(3)),
            ay: Number(gLon.toFixed(3)),
            az: 0.98,
            gx: 0,
            gy: 0,
            gz: Number((gLat * 0.45).toFixed(3)),
          });

          // Actualizare HUD ecran
          setLiveStats({
            speedKmh: Math.round(speedKmh),
            gForce: Number(Math.abs(gLat).toFixed(2)),
            pointsSent: pointsSentCounter.current,
          });

          // Pas de înaintare pe circuit
          simStepRef.current += 0.08;
        }, 80);

      } else {
        // ── MOD SENZORI REALI (compatibil 100% cu iPhone / iOS și Android) ──
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          setStatusText('Eroare: Permisiune GPS necesară!');
          setIsRunning(false);
          return;
        }

        locSub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: 100,
            distanceInterval: 0,
          },
          (location) => {
            if (!location || !location.coords) return;
            const spd = location.coords.speed && location.coords.speed > 0 ? location.coords.speed : 0;
            latestGps.current = {
              lat: location.coords.latitude,
              lon: location.coords.longitude,
              speed: spd,
              bearing: location.coords.heading || 0,
            };
            setLiveStats((prev) => ({
              ...prev,
              speedKmh: Math.round(spd * 3.6),
            }));
          }
        );

        Gyroscope.setUpdateInterval(20);
        gyroSub = Gyroscope.addListener((gyro) => {
          if (gyro) {
            latestGyro.current = {
              x: typeof gyro.x === 'number' ? gyro.x : 0,
              y: typeof gyro.y === 'number' ? gyro.y : 0,
              z: typeof gyro.z === 'number' ? gyro.z : 0,
            };
          }
        });

        DeviceMotion.setUpdateInterval(20);
        accelSub = DeviceMotion.addListener((motion) => {
          if (!motion) return;

          let calX = 0;
          let calY = 0;
          let calZ = 0;
          const G_CONST = 9.80665;

          // Extragere sigură a accelerației (compatibilă cu CoreMotion pe iOS și Sensor API pe Android)
          const hasLinear = motion.acceleration && typeof motion.acceleration.x === 'number';
          const hasGravity = motion.accelerationIncludingGravity && typeof motion.accelerationIncludingGravity.x === 'number';

          if (hasLinear && hasGravity) {
            const gx = motion.accelerationIncludingGravity.x - motion.acceleration.x;
            const gy = motion.accelerationIncludingGravity.y - motion.acceleration.y;
            const gz = motion.accelerationIncludingGravity.z - motion.acceleration.z;
            const gNorm = Math.sqrt(gx * gx + gy * gy + gz * gz) || G_CONST;

            const upX = gx / gNorm;
            const upY = gy / gNorm;
            const upZ = gz / gNorm;

            const ax = motion.acceleration.x;
            const ay = motion.acceleration.y;
            const az = motion.acceleration.z;

            // Proiecție dinamică pe plan orizontal
            const aVertical = ax * upX + ay * upY + az * upZ;
            calX = (ax - aVertical * upX) / G_CONST;
            calY = (ay - aVertical * upY) / G_CONST;
            calZ = (az - aVertical * upZ) / G_CONST;
          } else if (hasGravity) {
            calX = (motion.accelerationIncludingGravity.x || 0) / G_CONST;
            calY = (motion.accelerationIncludingGravity.y || 0) / G_CONST;
            calZ = (motion.accelerationIncludingGravity.z || 0) / G_CONST;
          }

          imuBuffer.current.push({
            ts: Date.now(),
            ax: Number(calX.toFixed(4)),
            ay: Number(calY.toFixed(4)),
            az: Number(calZ.toFixed(4)),
            gx: Number((latestGyro.current.x || 0).toFixed(4)),
            gy: Number((latestGyro.current.y || 0).toFixed(4)),
            gz: Number((latestGyro.current.z || 0).toFixed(4)),
          });

          if (imuBuffer.current.length > 500) {
            imuBuffer.current.shift();
          }

          setLiveStats((prev) => ({
            ...prev,
            gForce: Number(Math.abs(calX).toFixed(2)),
          }));
        });
      }

      // Interval de trimitere loturi telemetrie (la fiecare 200ms)
      sendInterval = setInterval(() => {
        if (imuBuffer.current.length === 0 && retryQueue.current.length === 0) return;

        let payload = null;
        if (imuBuffer.current.length > 0) {
          const samplesToSend = [...imuBuffer.current];
          imuBuffer.current = [];

          payload = {
            session_id: sessionIdRef.current,
            device_id: driverName.trim() || defaultDriver,
            track_name: trackName.trim() || 'Circuit-Cluj',
            event_type: 'telemetry_batch',
            timestamp: new Date().toISOString(),
            unit: {
              accel: 'g',
              gyro: 'rad/s',
              speed: 'm/s',
              bearing: 'deg',
            },
            value: {
              gps: latestGps.current,
              samples: samplesToSend,
            },
            gps: latestGps.current,
            samples: samplesToSend,
          };
        }

        if (ws.current && ws.current.readyState === WebSocket.OPEN) {
          flushRetryQueue();
          if (payload) {
            try {
              ws.current.send(JSON.stringify(payload));
              pointsSentCounter.current += payload.samples.length;
              setLiveStats((prev) => ({ ...prev, pointsSent: pointsSentCounter.current }));
            } catch (err) {
              retryQueue.current.push(payload);
            }
          }
        } else if (payload) {
          retryQueue.current.push(payload);
          if (retryQueue.current.length > 300) {
            retryQueue.current.shift();
          }
          if (isRunningRef.current) {
            setStatusText(`Buffer offline (${retryQueue.current.length}) - Reconectare...`);
          }
        }
      }, 200);
    };

    const stopTelemetry = () => {
      const stopPayload = {
        session_id: sessionIdRef.current,
        device_id: driverName.trim() || defaultDriver,
        event_type: 'STOP_SESSION',
        timestamp: new Date().toISOString(),
        unit: 'event',
        value: 'session_completed',
      };

      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        flushRetryQueue();
        try {
          ws.current.send(JSON.stringify(stopPayload));
        } catch (e) {
          console.warn('Failed to send STOP_SESSION', e);
        }
        ws.current.close();
      } else if (ws.current) {
        ws.current.close();
      }
      deactivateKeepAwake();
      if (sessionIdRef.current) {
        setStatusText('Sesiune finalizată și salvată');
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
      if (simInterval) clearInterval(simInterval);
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
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.brandTitle}>F1 TELEMETRY</Text>
            <Text style={styles.platformBadge}>
              {Platform.OS === 'ios' ? '🍎 iOS Device' : '🤖 Android Device'}
            </Text>
            <View style={[styles.badge, isRunning ? styles.badgeLive : styles.badgeOff]}>
              <Text style={[styles.badgeText, isRunning && { color: '#00e676' }]}>
                {statusText}
              </Text>
            </View>
          </View>

          {/* HUD Live Telemetrie când este activ */}
          {isRunning && (
            <View style={styles.hudCard}>
              <View style={styles.hudCol}>
                <Text style={styles.hudValue}>{liveStats.speedKmh}</Text>
                <Text style={styles.hudLabel}>VITEZĂ (KM/H)</Text>
              </View>
              <View style={styles.hudDivider} />
              <View style={styles.hudCol}>
                <Text style={styles.hudValue}>{liveStats.gForce} G</Text>
                <Text style={styles.hudLabel}>FORȚĂ G</Text>
              </View>
              <View style={styles.hudDivider} />
              <View style={styles.hudCol}>
                <Text style={styles.hudValue}>{liveStats.pointsSent}</Text>
                <Text style={styles.hudLabel}>MOSTRE</Text>
              </View>
            </View>
          )}

          {/* Formular Pilot și Circuit */}
          <View style={styles.formBox}>
            <Text style={styles.label}>NUME PILOT</Text>
            <TextInput
              style={[styles.input, isRunning && styles.inputLocked]}
              value={driverName}
              onChangeText={setDriverName}
              editable={!isRunning}
              placeholder="Ex: Cristi - iPhone"
              placeholderTextColor="#555"
            />

            {/* Selector rapid de profil pilot pentru jurizare / testare simultană */}
            {!isRunning && (
              <View style={styles.presetsRow}>
                <TouchableOpacity
                  style={[styles.presetBtn, driverName === 'Cristi - iPhone' && styles.presetBtnActive]}
                  onPress={() => setDriverName('Cristi - iPhone')}
                >
                  <Text style={styles.presetText}>Cristi (iPhone)</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.presetBtn, driverName === 'Alex - S23' && styles.presetBtnActive]}
                  onPress={() => setDriverName('Alex - S23')}
                >
                  <Text style={styles.presetText}>Alex (S23)</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.presetBtn, driverName === 'Juriu - Pilot 1' && styles.presetBtnActive]}
                  onPress={() => setDriverName('Juriu - Pilot 1')}
                >
                  <Text style={styles.presetText}>Juriu #1</Text>
                </TouchableOpacity>
              </View>
            )}

            <Text style={[styles.label, { marginTop: 18 }]}>NUME CIRCUIT</Text>
            <TextInput
              style={[styles.input, isRunning && styles.inputLocked]}
              value={trackName}
              onChangeText={setTrackName}
              editable={!isRunning}
              placeholder="Circuit-Cluj"
              placeholderTextColor="#555"
            />

            {/* Selector Mod: Senzori Reali vs Simulator */}
            {!isRunning && (
              <View style={styles.modeSection}>
                <Text style={styles.label}>MOD TRANSMISIE TELEMETRIE</Text>
                <View style={styles.modeToggleRow}>
                  <TouchableOpacity
                    style={[styles.modeBtn, !isSimulatorMode && styles.modeBtnActive]}
                    onPress={() => setIsSimulatorMode(false)}
                  >
                    <Text style={[styles.modeBtnText, !isSimulatorMode && styles.modeBtnTextActive]}>
                      📱 Senzori Reali
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modeBtn, isSimulatorMode && styles.modeBtnActive]}
                    onPress={() => setIsSimulatorMode(true)}
                  >
                    <Text style={[styles.modeBtnText, isSimulatorMode && styles.modeBtnTextActive]}>
                      🏎️ Simulator Circuit
                    </Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.modeHint}>
                  {isSimulatorMode
                    ? 'Permite simularea simultană pe circuit chiar din sală.'
                    : 'Folosește GPS-ul și giroscopul real al telefonului tău.'}
                </Text>
              </View>
            )}
          </View>
        </ScrollView>

        {/* Buton principal START / STOP */}
        <TouchableOpacity
          style={[styles.mainButton, isRunning ? styles.btnStop : styles.btnStart]}
          onPress={() => setIsRunning((prev) => !prev)}
          activeOpacity={0.85}
        >
          <Text style={styles.mainButtonText}>
            {isRunning ? 'STOP TELEMETRIE' : 'START TELEMETRIE'}
          </Text>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d0e12',
  },
  inner: {
    flex: 1,
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: Platform.OS === 'ios' ? 12 : 20,
  },
  scrollContent: {
    paddingTop: 10,
    paddingBottom: 20,
  },
  header: {
    alignItems: 'center',
    marginBottom: 16,
  },
  brandTitle: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: 3,
    marginBottom: 4,
  },
  platformBadge: {
    color: '#00e5ff',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 10,
  },
  badge: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 20,
  },
  badgeLive: {
    backgroundColor: 'rgba(0, 230, 118, 0.15)',
    borderWidth: 1,
    borderColor: '#00e676',
  },
  badgeOff: {
    backgroundColor: '#1b1d24',
  },
  badgeText: {
    color: '#8e92a4',
    fontSize: 13,
    fontWeight: '700',
  },
  hudCard: {
    flexDirection: 'row',
    backgroundColor: '#141721',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#23293a',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  hudCol: {
    alignItems: 'center',
  },
  hudValue: {
    color: '#ffffff',
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: 1,
  },
  hudLabel: {
    color: '#656a80',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginTop: 2,
  },
  hudDivider: {
    width: 1,
    height: 30,
    backgroundColor: '#23293a',
  },
  formBox: {
    backgroundColor: '#141721',
    padding: 20,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#23293a',
  },
  label: {
    color: '#7b8098',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#1c202e',
    color: '#ffffff',
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderRadius: 12,
    fontSize: 16,
    fontWeight: '600',
    borderWidth: 1,
    borderColor: '#2d344a',
  },
  inputLocked: {
    opacity: 0.45,
    color: '#888888',
  },
  presetsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  presetBtn: {
    flex: 1,
    backgroundColor: '#1c202e',
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2d344a',
  },
  presetBtnActive: {
    borderColor: '#00e5ff',
    backgroundColor: 'rgba(0, 229, 255, 0.1)',
  },
  presetText: {
    color: '#c2c6dc',
    fontSize: 11,
    fontWeight: '700',
  },
  modeSection: {
    marginTop: 18,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#23293a',
  },
  modeToggleRow: {
    flexDirection: 'row',
    gap: 10,
  },
  modeBtn: {
    flex: 1,
    backgroundColor: '#1c202e',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2d344a',
  },
  modeBtnActive: {
    backgroundColor: 'rgba(0, 230, 118, 0.12)',
    borderColor: '#00e676',
  },
  modeBtnText: {
    color: '#8e92a4',
    fontSize: 13,
    fontWeight: '700',
  },
  modeBtnTextActive: {
    color: '#00e676',
  },
  modeHint: {
    color: '#555b72',
    fontSize: 11,
    marginTop: 8,
    fontStyle: 'italic',
  },
  mainButton: {
    height: 72,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 12,
  },
  btnStart: {
    backgroundColor: '#00c853',
    shadowColor: '#00c853',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 6,
  },
  btnStop: {
    backgroundColor: '#ff1744',
    shadowColor: '#ff1744',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 6,
  },
  mainButtonText: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 2.5,
  },
});
