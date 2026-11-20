import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import car from "@/assets/gt2rs-side.png";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { sessions, selectSession, sessionMetrics, visibleLaps } from "@/lib/telemetry-sessions";


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "911 GT2 RS — Live Track Telemetry" },
      { name: "description", content: "Lap times, speed trace and G-forces for the 911 GT2 RS at Transilvania Motor Ring." },
      { property: "og:title", content: "911 GT2 RS — Live Track Telemetry" },
      { property: "og:description", content: "Lap times, speed trace and G-forces for the 911 GT2 RS." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:image", content: car },
      { name: "twitter:image", content: car },
    ],
  }),
  component: Index,
});

function Index() {
  const [sessionId, setSessionId] = useState("01");
  const [valid, setValid] = useState(false);
  const session = selectSession(sessionId);
  const metrics = sessionMetrics(session);
  const rows = visibleLaps(session, valid);
  const kpis = [
    { label: "Best lap", value: metrics.bestTime, unit: "", sub: `${metrics.bestLap} · session best`, highlight: true },
    { label: "Max speed", value: metrics.maxSpeed.toFixed(1), unit: "km/h", sub: "Session maximum" },
    { label: "Avg speed", value: session.averageSpeed.toFixed(1), unit: "km/h", sub: "", bar: Math.round(session.averageSpeed / metrics.maxSpeed * 100) },
    { label: "Max lateral G", value: metrics.maxLateral.toFixed(2), unit: "G", sub: "Session maximum" },
    { label: "Max braking G", value: metrics.maxBraking.toFixed(2).replace("-", "−"), unit: "G", sub: "Session maximum", negative: true },
  ];
  const gx = 110 + session.lateral * 52;
  const gy = 110 - session.longitudinal * 47;
  return (
    <div className="min-h-screen bg-shell p-3 md:p-8">
      <div className="mx-auto max-w-7xl rounded-[2rem] border border-border bg-background p-5 md:p-10">
        {/* Nav */}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <span className="text-sm font-semibold tracking-[0.35em]">PORSCHE</span>
          <div className="order-last w-full md:order-none md:w-64">
            <Select value={sessionId} onValueChange={setSessionId}>
              <SelectTrigger aria-label="Select session" className="h-11 bg-secondary px-4">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sessions.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <span className="flex items-center gap-2 rounded-full border border-border px-4 py-2 font-mono text-[11px] uppercase tracking-wider">
            <span className="size-2 rounded-full bg-accent" /> Sample sessions
          </span>
        </header>

        {/* Hero */}
        <section className="relative mt-10">
          <div className="relative z-10 flex flex-wrap items-start justify-between gap-6">
            <div>
              <p className="text-[11px] uppercase tracking-[0.25em] text-muted-foreground">Session #{session.id} · {session.condition}</p>
              <h1 className="mt-2 text-5xl font-semibold tracking-tight md:text-6xl">911 GT2 RS</h1>
              <p className="mt-3 text-sm text-muted-foreground">Transilvania Motor Ring · 3,788 m</p>
            </div>
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-[0.25em] text-muted-foreground">Best lap</p>
              <p className="mt-2 text-5xl font-semibold tracking-tight md:text-6xl">{metrics.bestTime}</p>
              <p className="mt-3 text-sm text-muted-foreground">{session.laps.length} laps · {metrics.bestLap} session best</p>
            </div>
          </div>
          <div className="pointer-events-none absolute inset-x-0 top-32 select-none text-center text-[22vw] font-bold leading-none tracking-tighter text-ghost-text md:text-[14rem]">GT2 RS</div>
          <div className="relative mx-auto mt-24 max-w-5xl md:mt-32">
            <div className="absolute inset-x-[8%] bottom-[12%] h-[18%] rounded-[50%] border border-border bg-secondary/40 blur-[1px]" />
            <img src={car} alt="Red 911 GT2 RS side profile" className="relative w-full" />
          </div>
        </section>

        {/* KPIs */}
        <section className="mt-24 grid grid-cols-2 md:mt-32 gap-3 md:grid-cols-5">
          {kpis.map((k) => (
            <div key={k.label} className={`panel p-5 ${k.highlight ? "border-accent/60" : ""}`}>
              <p className="text-xs text-muted-foreground">{k.label}</p>
              <p className={`mt-3 font-mono text-2xl font-semibold ${k.highlight ? "text-accent" : k.negative ? "text-destructive" : ""}`}>
                {k.value} <span className="text-xs font-normal text-muted-foreground">{k.unit}</span>
              </p>
              {k.bar ? (
                <div className="mt-3 h-1 rounded-full bg-secondary"><div className="h-1 rounded-full bg-accent" style={{ width: `${k.bar}%` }} /></div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">{k.sub}</p>
              )}
            </div>
          ))}
        </section>

        {/* Map + G-G */}
        <section className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="panel p-6">
            <div className="flex justify-between"><h2 className="font-medium">Circuit map & speed trace</h2><span className="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">3,788 m</span></div>
            <svg viewBox="0 0 400 220" className="mt-4 w-full">
              <defs>
                <linearGradient id="spd" x1="0" x2="1"><stop offset="0" stopColor="var(--accent)" /><stop offset="1" stopColor="var(--destructive)" /></linearGradient>
              </defs>
              <path d="M60 120 C40 60 90 50 130 60 S200 40 240 50 S330 40 340 80 S300 110 270 105 S220 120 240 150 S200 190 150 185 S80 180 60 120Z" fill="none" stroke="var(--secondary)" strokeWidth="16" strokeLinejoin="round" />
              <path d="M60 120 C40 60 90 50 130 60 S200 40 240 50 S330 40 340 80 S300 110 270 105 S220 120 240 150 S200 190 150 185 S80 180 60 120Z" fill="none" stroke="url(#spd)" strokeWidth="5" strokeLinejoin="round" />
              <circle cx="340" cy="80" r="7" fill="var(--background)" stroke="var(--accent)" strokeWidth="3" />
              {[["T1", 120, 48], ["T3", 240, 38], ["T4", 352, 72], ["T6", 228, 138], ["T8", 150, 202]].map(([t, x, y]) => (
                <text key={t as string} x={x as number} y={y as number} fill="var(--muted-foreground)" fontSize="10" fontFamily="JetBrains Mono">{t}</text>
              ))}
            </svg>
            <div className="mt-3 flex justify-between font-mono text-xs text-muted-foreground"><span>Peak speed <b className="text-foreground">{metrics.maxSpeed.toFixed(1)} km/h</b></span><span>Session <b className="text-foreground">#{session.id}</b></span></div>
          </div>
          <div className="panel p-6">
            <div className="flex justify-between"><h2 className="font-medium">G-G diagram</h2><span className="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">Traction {session.traction.toFixed(1)}%</span></div>
            <svg viewBox="0 0 220 220" className="mx-auto mt-4 w-full max-w-[260px]">
              {[100, 70, 40].map((r) => <circle key={r} cx="110" cy="110" r={r} fill="none" stroke="var(--border)" strokeDasharray="3 3" />)}
              <line x1="10" y1="110" x2="210" y2="110" stroke="var(--border)" />
              <line x1="110" y1="10" x2="110" y2="210" stroke="var(--border)" />
              {Array.from({ length: 40 }).map((_, i) => {
                const a = i * 0.9, r = (20 + ((i * 37) % 70)) * metrics.maxLateral / 1.42;
                return <circle key={i} cx={110 + Math.cos(a) * r} cy={110 + Math.sin(a) * r * 0.9} r="1.6" fill="var(--accent)" opacity="0.45" />;
              })}
              <line x1="110" y1="110" x2={gx} y2={gy} stroke="var(--accent)" strokeWidth="3" />
              <circle cx={gx} cy={gy} r="6" fill="var(--background)" stroke="var(--accent)" strokeWidth="3" />
            </svg>
            <div className="mt-3 flex justify-between font-mono text-xs text-muted-foreground"><span>Lateral <b className="text-accent">+{session.lateral.toFixed(2)} G</b></span><span>Longitudinal <b className="text-destructive">{session.longitudinal.toFixed(2).replace("-", "−")} G</b></span></div>
          </div>
        </section>

        {/* Laps */}
        <section className="panel mt-3 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-medium">Session laps <span className="ml-2 rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">{session.laps.length} total</span></h2>
            <div className="flex rounded-full bg-secondary p-1 text-xs">
              {["All laps", "Valid only"].map((l, i) => (
                <Button key={l} size="sm" variant={valid === (i === 1) ? "default" : "ghost"} aria-pressed={valid === (i === 1)} onClick={() => setValid(i === 1)} className="rounded-full px-4">{l}</Button>
              ))}
            </div>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[600px] font-mono text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">{["Lap", "Lap time", "Delta", "Max speed", "Max lat G", "Max brk G"].map((h) => <th key={h} className="py-3 font-normal">{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => {
                  const best = r[2] === "BEST";
                  return (
                    <tr key={r[0]} className={`border-t border-border ${best ? "bg-secondary" : ""}`}>
                      <td className="py-3">{r[0]}</td>
                      <td className={best ? "text-accent" : ""}>{r[1]}</td>
                      <td>{best ? <span className="rounded bg-accent px-2 py-0.5 text-xs text-accent-foreground">BEST</span> : <span className="text-muted-foreground">{r[2]}</span>}</td>
                      <td>{r[3]} <span className="text-muted-foreground">km/h</span></td>
                      <td>{r[4]} G</td>
                      <td className="text-destructive">{r[5]} G</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
