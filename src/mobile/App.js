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
  Alert,
} from 'react-native';
import * as Location from 'expo-location';
import { DeviceMotion } from 'expo-sensors';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

// ─── VERSIUNE: v2.1 – build stabil pentru juriu ───────────────────────────────
const APP_VERSION = 'v2.1';
const BASE_WS_URL = 'wss://datainfrastructure-diodele.cristianstefanpopa05.workers.dev/ws';

// Circuit Cluj – 14 jaloane, buclă ~1.8 km
const SIM_WAYPOINTS = [
  { lat: 46.77000, lon: 23.60000, spd: 195, gL: 0.10, gB: 0.0 },
  { lat: 46.77120, lon: 23.60040, spd: 225, gL: 0.20, gB: 0.0 },
  { lat: 46.77240, lon: 23.60080, spd: 235, gL: 0.10, gB: 0.8 },
  { lat: 46.77320, lon: 23.60150, spd: 110, gL: 1.35, gB: 0.3 },
  { lat: 46.77380, lon: 23.60280, spd: 140, gL: 0.85, gB: 0.0 },
  { lat: 46.77450, lon: 23.60420, spd: 175, gL: 0.30, gB: 0.0 },
  { lat: 46.77530, lon: 23.60600, spd: 210, gL: 0.15, gB: 1.1 },
  { lat: 46.77550, lon: 23.60680, spd: 82,  gL: 1.65, gB: 0.2 },
  { lat: 46.77480, lon: 23.60740, spd: 120, gL: 0.90, gB: 0.0 },
  { lat: 46.77360, lon: 23.60660, spd: 165, gL: 0.40, gB: 0.0 },
  { lat: 46.77250, lon: 23.60520, spd: 135, gL: 1.25, gB: 0.1 },
  { lat: 46.77150, lon: 23.60350, spd: 180, gL: 0.50, gB: 0.0 },
  { lat: 46.77060, lon: 23.60180, spd: 190, gL: 0.20, gB: 0.3 },
  { lat: 46.77010, lon: 23.60060, spd: 170, gL: 0.80, gB: 0.0 },
];

export default function App() {
  const isIOS = Platform.OS === 'ios';
  const defaultDriver = isIOS ? 'Cristi - iPhone' : 'Alex - S23';

  const [driverName, setDriverName]       = useState(defaultDriver);
  const [trackName,  setTrackName]        = useState('Circuit-Cluj');
  const [simMode,    setSimMode]          = useState(false);
  const [running,    setRunning]          = useState(false);
  const [status,     setStatus]           = useState('Pregătit ' + APP_VERSION);
  const [elapsed,    setElapsed]          = useState(0);   // secunde, pentru cronometru
  const [speed,      setSpeed]            = useState(0);
  const [gForce,     setGForce]           = useState(0);
  const [points,     setPoints]           = useState(0);

  // refs
  const wsRef         = useRef(null);
  const runRef        = useRef(false);
  const simRef        = useRef(false);
  const gpsRef        = useRef({ lat: 0, lon: 0, speed: 0, bearing: 0 });
  const imuBuf        = useRef([]);
  const retryBuf      = useRef([]);
  const sessionRef    = useRef('');
  const ptsCnt        = useRef(0);
  const simStep       = useRef(0);
  const startTime     = useRef(0);

  // ── cronometru afișat pe ecran ──────────────────────────────────────────────
  useEffect(() => {
    if (!running) { setElapsed(0); return; }
    startTime.current = Date.now();
    const t = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [running]);

  // ── logica principală telemetrie ────────────────────────────────────────────
  useEffect(() => {
    runRef.current = running;
    simRef.current = simMode;

    if (!running) {
      stopAll();
      return;
    }

    let locSub   = null;
    let motSub   = null;
    let simInt   = null;
    let sendInt  = null;
    let recoTmo  = null;

    // ── helpers ──────────────────────────────────────────────────────────────
    const sendMsg = (payload) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(JSON.stringify(payload));
          if (payload.samples) {
            ptsCnt.current += payload.samples.length;
            setPoints(ptsCnt.current);
          }
          return true;
        } catch (_) {}
      }
      retryBuf.current.push(payload);
      if (retryBuf.current.length > 400) retryBuf.current.shift();
      return false;
    };

    const flushRetry = () => {
      while (
        retryBuf.current.length > 0 &&
        wsRef.current &&
        wsRef.current.readyState === WebSocket.OPEN
      ) {
        const p = retryBuf.current.shift();
        try { wsRef.current.send(JSON.stringify(p)); ptsCnt.current += (p.samples||[]).length; setPoints(ptsCnt.current); }
        catch (_) { retryBuf.current.unshift(p); break; }
      }
    };

    const makePayload = (samples) => ({
      session_id:  sessionRef.current,
      device_id:   driverName.trim() || defaultDriver,
      track_name:  trackName.trim()  || 'Circuit-Cluj',
      event_type:  'telemetry_batch',
      timestamp:   new Date().toISOString(),
      unit: { accel: 'g', gyro: 'rad/s', speed: 'm/s', bearing: 'deg' },
      gps:     gpsRef.current,
      samples,
      value: { gps: gpsRef.current, samples },
    });

    // ── WebSocket ─────────────────────────────────────────────────────────────
    const connect = () => {
      if (!runRef.current) return;
      const sess  = encodeURIComponent(sessionRef.current);
      const track = encodeURIComponent(trackName.trim() || 'Circuit-Cluj');
      const drv   = encodeURIComponent(driverName.trim() || defaultDriver);
      const url   = `${BASE_WS_URL}?session=${sess}&track=${track}&device=${drv}`;
      setStatus('Conectare...');
      const socket = new WebSocket(url);
      wsRef.current = socket;

      socket.onopen  = () => { setStatus(`● LIVE ${simRef.current ? 'SIMULATOR' : 'GPS'}`); flushRetry(); };
      socket.onerror = () => setStatus('Eroare WS – reconectare...');
      socket.onclose = () => {
        if (runRef.current) {
          setStatus(`Buffer(${retryBuf.current.length}) – reconectare...`);
          recoTmo = setTimeout(connect, 1500);
        }
      };
    };

    // ── init sesiune ──────────────────────────────────────────────────────────
    const cleanTag = (driverName.trim() || defaultDriver).replace(/[^a-zA-Z0-9]/g, '_');
    sessionRef.current = `ses_${cleanTag}_${Date.now()}`;
    imuBuf.current  = [];
    retryBuf.current = [];
    ptsCnt.current   = 0;
    simStep.current  = 0;
    setPoints(0);

    // pre-init GPS cu primul waypoint în mod simulator (evită speed=0 la start)
    if (simMode) {
      const w0 = SIM_WAYPOINTS[0];
      const w1 = SIM_WAYPOINTS[1];
      const dl = w1.lon - w0.lon;
      const y  = Math.sin(dl) * Math.cos(w1.lat);
      const x  = Math.cos(w0.lat) * Math.sin(w1.lat) - Math.sin(w0.lat) * Math.cos(w1.lat) * Math.cos(dl);
      gpsRef.current = { lat: w0.lat, lon: w0.lon, speed: w0.spd / 3.6, bearing: (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 };
    }

    activateKeepAwakeAsync().catch(() => {});
    connect();

    // ── mod SIMULATOR ─────────────────────────────────────────────────────────
    if (simMode) {
      simInt = setInterval(() => {
        if (!runRef.current) return;
        const N   = SIM_WAYPOINTS.length;
        const idx = Math.floor(simStep.current) % N;
        const nxt = (idx + 1) % N;
        const p   = simStep.current - Math.floor(simStep.current);
        const w1  = SIM_WAYPOINTS[idx];
        const w2  = SIM_WAYPOINTS[nxt];

        const lat  = w1.lat + (w2.lat - w1.lat) * p;
        const lon  = w1.lon + (w2.lon - w1.lon) * p;
        const spdK = w1.spd + (w2.spd - w1.spd) * p;
        const spdM = spdK / 3.6;
        const dl   = w2.lon - w1.lon;
        const y    = Math.sin(dl) * Math.cos(w2.lat);
        const x    = Math.cos(w1.lat) * Math.sin(w2.lat) - Math.sin(w1.lat) * Math.cos(w2.lat) * Math.cos(dl);
        const brg  = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;

        gpsRef.current = { lat, lon, speed: spdM, bearing: brg };

        const gL  = w1.gL + (w2.gL - w1.gL) * p + (Math.random() - 0.5) * 0.08;
        const gB  = w1.gB + (w2.gB - w1.gB) * p;

        imuBuf.current.push({
          ts: Date.now(),
          ax: +gL.toFixed(3),
          ay: +(gB > 0 ? -gB : 0.35).toFixed(3),
          az: 0.98,
          gx: 0, gy: 0,
          gz: +(gL * 0.45).toFixed(3),
        });

        setSpeed(Math.round(spdK));
        setGForce(+Math.abs(gL).toFixed(2));
        simStep.current += 0.08;
      }, 80);

    // ── mod GPS REAL ──────────────────────────────────────────────────────────
    } else {
      (async () => {
        const { status: s } = await Location.requestForegroundPermissionsAsync();
        if (s !== 'granted') {
          Alert.alert('Permisiune refuzată', 'GPS-ul este necesar pentru telemetrie.');
          setRunning(false); return;
        }
        locSub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 100, distanceInterval: 0 },
          (loc) => {
            if (!loc?.coords) return;
            const spd = loc.coords.speed > 0 ? loc.coords.speed : 0;
            gpsRef.current = {
              lat:     loc.coords.latitude,
              lon:     loc.coords.longitude,
              speed:   spd,
              bearing: loc.coords.heading || 0,
            };
            setSpeed(Math.round(spd * 3.6));
          }
        );

        DeviceMotion.setUpdateInterval(20);
        motSub = DeviceMotion.addListener((m) => {
          if (!m) return;
          const G = 9.80665;
          let ax = 0, ay = 0, az = 0;
          const hasL = m.acceleration && typeof m.acceleration.x === 'number';
          const hasG = m.accelerationIncludingGravity && typeof m.accelerationIncludingGravity.x === 'number';

          if (hasL && hasG) {
            const gx = m.accelerationIncludingGravity.x - m.acceleration.x;
            const gy = m.accelerationIncludingGravity.y - m.acceleration.y;
            const gz = m.accelerationIncludingGravity.z - m.acceleration.z;
            const gN = Math.sqrt(gx*gx + gy*gy + gz*gz) || G;
            const ux = gx/gN, uy = gy/gN, uz = gz/gN;
            const aV = m.acceleration.x*ux + m.acceleration.y*uy + m.acceleration.z*uz;
            ax = (m.acceleration.x - aV*ux) / G;
            ay = (m.acceleration.y - aV*uy) / G;
            az = (m.acceleration.z - aV*uz) / G;
          } else if (hasG) {
            ax = (m.accelerationIncludingGravity.x || 0) / G;
            ay = (m.accelerationIncludingGravity.y || 0) / G;
            az = (m.accelerationIncludingGravity.z || 0) / G;
          }

          imuBuf.current.push({
            ts: Date.now(),
            ax: +ax.toFixed(4), ay: +ay.toFixed(4), az: +az.toFixed(4),
            gx: 0, gy: 0, gz: 0,
          });
          if (imuBuf.current.length > 500) imuBuf.current.shift();
          setGForce(+Math.abs(ax).toFixed(2));
        });
      })();
    }

    // ── interval trimitere (200ms) ────────────────────────────────────────────
    sendInt = setInterval(() => {
      if (imuBuf.current.length === 0 && retryBuf.current.length === 0) return;
      if (imuBuf.current.length > 0) {
        const batch = [...imuBuf.current];
        imuBuf.current = [];
        sendMsg(makePayload(batch));
      }
      flushRetry();
    }, 200);

    // ── cleanup ───────────────────────────────────────────────────────────────
    return () => {
      clearInterval(simInt);
      clearInterval(sendInt);
      clearTimeout(recoTmo);
      if (locSub) locSub.remove();
      if (motSub) motSub.remove();
    };
  }, [running]);

  const stopAll = () => {
    if (wsRef.current) {
      try {
        wsRef.current.send(JSON.stringify({
          session_id: sessionRef.current,
          device_id:  driverName,
          event_type: 'STOP_SESSION',
          timestamp:  new Date().toISOString(),
          unit: 'event', value: 'session_completed',
        }));
      } catch (_) {}
      wsRef.current.close();
      wsRef.current = null;
    }
    deactivateKeepAwake();
    setStatus('Sesiune salvată ✓ ' + APP_VERSION);
    setSpeed(0); setGForce(0);
  };

  const fmt = (s) => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;

  // ── UI ────────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={S.root}>
      <StatusBar barStyle="light-content" backgroundColor="#0d0e12" />
      <KeyboardAvoidingView behavior={isIOS ? 'padding' : 'height'} style={S.kav}>
        <ScrollView contentContainerStyle={S.scroll} keyboardShouldPersistTaps="handled">

          {/* HEADER */}
          <View style={S.header}>
            <Text style={S.title}>🏎 F1 TELEMETRY</Text>
            <Text style={S.sub}>{isIOS ? '🍎 iOS' : '🤖 Android'} · {APP_VERSION}</Text>
            <View style={[S.badge, running ? S.badgeOn : S.badgeOff]}>
              <Text style={[S.badgeTxt, running && { color: '#00e676' }]}>{status}</Text>
            </View>
          </View>

          {/* HUD – vizibil doar când rulează */}
          {running && (
            <View style={S.hud}>
              <View style={S.hudCol}>
                <Text style={S.hudBig}>{fmt(elapsed)}</Text>
                <Text style={S.hudLbl}>TIMP</Text>
              </View>
              <View style={S.sep} />
              <View style={S.hudCol}>
                <Text style={S.hudBig}>{speed}</Text>
                <Text style={S.hudLbl}>KM/H</Text>
              </View>
              <View style={S.sep} />
              <View style={S.hudCol}>
                <Text style={S.hudBig}>{gForce}G</Text>
                <Text style={S.hudLbl}>G-FORCE</Text>
              </View>
              <View style={S.sep} />
              <View style={S.hudCol}>
                <Text style={S.hudBig}>{points}</Text>
                <Text style={S.hudLbl}>MOSTRE</Text>
              </View>
            </View>
          )}

          {/* FORMULAR */}
          <View style={S.card}>
            <Text style={S.lbl}>PILOT</Text>
            <TextInput
              style={[S.inp, running && S.inpLocked]}
              value={driverName} onChangeText={setDriverName}
              editable={!running} placeholderTextColor="#555"
              placeholder="Ex: Cristi - iPhone"
            />

            {!running && (
              <View style={S.presets}>
                {['Cristi - iPhone','Alex - S23','Juriu - Pilot 1'].map(n => (
                  <TouchableOpacity key={n} style={[S.pre, driverName===n && S.preOn]} onPress={() => setDriverName(n)}>
                    <Text style={[S.preTxt, driverName===n && S.preTxtOn]}>{n.split(' - ')[0]}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            <Text style={[S.lbl,{marginTop:16}]}>CIRCUIT</Text>
            <TextInput
              style={[S.inp, running && S.inpLocked]}
              value={trackName} onChangeText={setTrackName}
              editable={!running} placeholderTextColor="#555"
              placeholder="Circuit-Cluj"
            />

            {!running && (
              <View style={S.modeBox}>
                <Text style={S.lbl}>MOD TELEMETRIE</Text>
                <View style={S.modeRow}>
                  <TouchableOpacity style={[S.modeBtn,!simMode&&S.modeBtnOn]} onPress={() => setSimMode(false)}>
                    <Text style={[S.modeTxt,!simMode&&S.modeTxtOn]}>📱 Senzori Reali</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[S.modeBtn,simMode&&S.modeBtnOn]} onPress={() => setSimMode(true)}>
                    <Text style={[S.modeTxt,simMode&&S.modeTxtOn]}>🏎️ Simulator F1</Text>
                  </TouchableOpacity>
                </View>
                <Text style={S.modeHint}>
                  {simMode ? 'Simulare GPS Circuit Cluj – fără telefon pe mașină.' : 'GPS + giroscop real – telefon pe mașină.'}
                </Text>
              </View>
            )}
          </View>

        </ScrollView>

        {/* BUTON START / STOP */}
        <TouchableOpacity
          style={[S.btn, running ? S.btnStop : S.btnStart]}
          onPress={() => setRunning(r => !r)}
          activeOpacity={0.85}
        >
          <Text style={S.btnTxt}>{running ? '⏹ STOP TELEMETRIE' : '▶ START TELEMETRIE'}</Text>
        </TouchableOpacity>

      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  root:       { flex:1, backgroundColor:'#0d0e12' },
  kav:        { flex:1, justifyContent:'space-between', paddingHorizontal:18, paddingBottom: Platform.OS==='ios'?12:20 },
  scroll:     { paddingTop:12, paddingBottom:16 },
  header:     { alignItems:'center', marginBottom:14 },
  title:      { color:'#fff', fontSize:22, fontWeight:'900', letterSpacing:3 },
  sub:        { color:'#00e5ff', fontSize:11, fontWeight:'700', letterSpacing:1, marginTop:2, marginBottom:8 },
  badge:      { paddingHorizontal:16, paddingVertical:6, borderRadius:20 },
  badgeOn:    { backgroundColor:'rgba(0,230,118,0.12)', borderWidth:1, borderColor:'#00e676' },
  badgeOff:   { backgroundColor:'#1b1d24' },
  badgeTxt:   { color:'#8e92a4', fontSize:12, fontWeight:'700' },
  hud:        { flexDirection:'row', backgroundColor:'#141721', borderRadius:14, paddingVertical:14, paddingHorizontal:8, marginBottom:14, borderWidth:1, borderColor:'#23293a', alignItems:'center', justifyContent:'space-around' },
  hudCol:     { alignItems:'center', flex:1 },
  hudBig:     { color:'#fff', fontSize:20, fontWeight:'900' },
  hudLbl:     { color:'#656a80', fontSize:9, fontWeight:'700', letterSpacing:0.8, marginTop:2 },
  sep:        { width:1, height:28, backgroundColor:'#23293a' },
  card:       { backgroundColor:'#141721', padding:18, borderRadius:16, borderWidth:1, borderColor:'#23293a' },
  lbl:        { color:'#7b8098', fontSize:10, fontWeight:'800', letterSpacing:1.2, marginBottom:7 },
  inp:        { backgroundColor:'#1c202e', color:'#fff', paddingHorizontal:14, paddingVertical:12, borderRadius:10, fontSize:15, fontWeight:'600', borderWidth:1, borderColor:'#2d344a' },
  inpLocked:  { opacity:0.4 },
  presets:    { flexDirection:'row', gap:7, marginTop:9 },
  pre:        { flex:1, backgroundColor:'#1c202e', paddingVertical:8, borderRadius:8, alignItems:'center', borderWidth:1, borderColor:'#2d344a' },
  preOn:      { borderColor:'#00e5ff', backgroundColor:'rgba(0,229,255,0.1)' },
  preTxt:     { color:'#aaa', fontSize:11, fontWeight:'700' },
  preTxtOn:   { color:'#00e5ff' },
  modeBox:    { marginTop:16, paddingTop:14, borderTopWidth:1, borderTopColor:'#23293a' },
  modeRow:    { flexDirection:'row', gap:9 },
  modeBtn:    { flex:1, backgroundColor:'#1c202e', paddingVertical:11, borderRadius:9, alignItems:'center', borderWidth:1, borderColor:'#2d344a' },
  modeBtnOn:  { backgroundColor:'rgba(0,230,118,0.1)', borderColor:'#00e676' },
  modeTxt:    { color:'#8e92a4', fontSize:12, fontWeight:'700' },
  modeTxtOn:  { color:'#00e676' },
  modeHint:   { color:'#4a5068', fontSize:10, fontStyle:'italic', marginTop:7 },
  btn:        { height:70, borderRadius:16, justifyContent:'center', alignItems:'center', marginTop:10 },
  btnStart:   { backgroundColor:'#00c853', shadowColor:'#00c853', shadowOffset:{width:0,height:4}, shadowOpacity:0.4, shadowRadius:8, elevation:6 },
  btnStop:    { backgroundColor:'#ff1744', shadowColor:'#ff1744', shadowOffset:{width:0,height:4}, shadowOpacity:0.4, shadowRadius:8, elevation:6 },
  btnTxt:     { color:'#fff', fontSize:19, fontWeight:'900', letterSpacing:2 },
});
