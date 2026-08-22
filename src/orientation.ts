// Physical device orientation from the accelerometer. With the OS rotation
// lock on, screen.orientation never leaves portrait, so capture code that
// relies on it produces sideways photos when the phone is held landscape.
// This tracker reads deviceorientation events instead; when no sensor data is
// available (desktop, permission denied) callers fall back to screen.orientation.

// Counterclockwise rotation from natural portrait: 0, 90 (top points left),
// 180 (upside down), 270 (top points right).
export type PhysicalAngle = 0 | 90 | 180 | 270;

let sensorAngle: PhysicalAngle | null = null;
let listeners = new Set<(angle: PhysicalAngle) => void>();
let tracking = 0;

// Enter a new orientation only past 50°, keep it until clearly back below 40°
// (dead zone between the thresholds) so the value does not flap around 45°.
function derive(beta: number, gamma: number, current: PhysicalAngle): PhysicalAngle {
  if (gamma <= -50) return 90;
  if (gamma >= 50) return 270;
  if (beta <= -50) return 180;
  if (Math.abs(gamma) < 40 && beta > -40) return 0;
  return current;
}

function onDeviceOrientation(e: DeviceOrientationEvent): void {
  if (e.beta == null || e.gamma == null) return;
  const next = derive(e.beta, e.gamma, sensorAngle ?? 0);
  if (next !== sensorAngle) {
    sensorAngle = next;
    listeners.forEach(cb => cb(next));
  }
}

// Reference-counted so overlapping capture screens cannot detach each other's
// listener. Returns a stop function; calling it twice is a no-op.
export function startOrientationTracking(): () => void {
  if (tracking++ === 0) window.addEventListener('deviceorientation', onDeviceOrientation);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--tracking === 0) {
      window.removeEventListener('deviceorientation', onDeviceOrientation);
      sensorAngle = null;
      listeners.clear();
    }
  };
}

export function onPhysicalAngleChange(cb: (angle: PhysicalAngle) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Sensor-derived angle, falling back to screen.orientation so behavior is
// unchanged wherever the sensor is unavailable.
export function getPhysicalAngle(): PhysicalAngle {
  if (sensorAngle !== null) return sensorAngle;
  const type = screen.orientation?.type ?? '';
  if (type === 'landscape-primary') return 90;
  if (type === 'portrait-secondary') return 180;
  if (type === 'landscape-secondary') return 270;
  return 0;
}

// iOS 13+ gates deviceorientation behind an explicit permission that must be
// requested from a user gesture; elsewhere this resolves immediately. A denial
// is swallowed — getPhysicalAngle simply keeps its screen.orientation fallback.
export async function requestOrientationPermission(): Promise<void> {
  const doe = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  if (typeof doe.requestPermission !== 'function') return;
  try { await doe.requestPermission(); } catch { /* fallback path covers denial */ }
}
