export type Lap = readonly [string, string, string, string, string, string];
export type Session = {
  id: string;
  label: string;
  condition: string;
  averageSpeed: number;
  traction: number;
  lateral: number;
  longitudinal: number;
  laps: readonly Lap[];
};

export const sessions: readonly Session[] = [
  {
    id: "01", label: "Session #01 · Dry", condition: "GT3 Dry",
    averageSpeed: 124.7, traction: 91.4, lateral: 1.12, longitudinal: -0.85,
    laps: [
      ["L1 (Out)", "1:18.410", "—", "168.2", "1.02", "−1.10"],
      ["L2", "1:05.560", "+1.240s", "194.1", "1.28", "−1.42"],
      ["L3", "1:04.320", "BEST", "198.4", "1.34", "−1.48"],
      ["L4", "1:04.732", "+0.412s", "197.8", "1.31", "−1.45"],
      ["L5", "1:05.105", "+0.785s", "196.2", "1.29", "−1.40"],
      ["L6 (YF)", "1:09.840", "+5.520s", "174.5", "1.18", "−1.20"],
      ["L7", "1:05.104", "+0.784s", "197.1", "1.33", "−1.46"],
    ],
  },
  {
    id: "02", label: "Session #02 · Wet", condition: "GT3 Wet",
    averageSpeed: 106.3, traction: 78.6, lateral: 0.84, longitudinal: -0.62,
    laps: [
      ["L1 (Out)", "1:29.810", "—", "145.2", "0.78", "−0.82"],
      ["L2", "1:16.420", "+1.530s", "173.2", "0.98", "−1.05"],
      ["L3", "1:15.260", "+0.370s", "176.5", "1.02", "−1.10"],
      ["L4", "1:14.890", "BEST", "178.6", "1.06", "−1.14"],
      ["L5", "1:15.680", "+0.790s", "175.4", "1.01", "−1.08"],
    ],
  },
  {
    id: "03", label: "Session #03 · Dry", condition: "GT3 Dry",
    averageSpeed: 128.2, traction: 94.2, lateral: 1.24, longitudinal: -0.96,
    laps: [
      ["L1 (Out)", "1:17.200", "—", "171.4", "1.08", "−1.16"],
      ["L2", "1:04.120", "+0.640s", "199.6", "1.36", "−1.50"],
      ["L3", "1:03.820", "+0.340s", "201.2", "1.39", "−1.53"],
      ["L4", "1:03.480", "BEST", "202.1", "1.42", "−1.56"],
      ["L5 (YF)", "1:10.120", "+6.640s", "176.3", "1.20", "−1.24"],
      ["L6", "1:03.960", "+0.480s", "200.4", "1.38", "−1.51"],
    ],
  },
];

export function selectSession(id: string): Session {
  const session = sessions.find((item) => item.id === id) ?? sessions[0];
  if (!session) throw new Error("No telemetry sessions available");
  return session;
}

export function visibleLaps(session: Session, validOnly: boolean) {
  return validOnly ? session.laps.filter((lap) => !lap[0].includes("(")) : session.laps;
}

export function sessionMetrics(session: Session) {
  const best = session.laps.find((lap) => lap[2] === "BEST");
  const maxSpeed = Math.max(...session.laps.map((lap) => Number(lap[3])));
  const maxLateral = Math.max(...session.laps.map((lap) => Number(lap[4])));
  const maxBraking = Math.min(...session.laps.map((lap) => Number(lap[5].replace("−", "-"))));
  return { bestTime: best?.[1] ?? "—", bestLap: best?.[0] ?? "—", maxSpeed, maxLateral, maxBraking };
}