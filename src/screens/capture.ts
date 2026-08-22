// Capture screen: dual-camera photo capture flow (back camera then selfie), composite stitching, preview with optional caption/location, and post submission.
import { MAX_POSTS_PER_TRIGGER, isIOS, isPwaInstalled } from '../state';
import { getAuthState } from '../api/auth';
import { postMeenow, type PostProgress } from '../api/pixelfed';
import { CAT_EARS_SHUTTER, SAVE_ICON, CHECK_ICON } from '../icons';
import { saveImage, dateFilename } from '../share';
import { insertExif } from '../exif';
import {
  getPhysicalAngle,
  onPhysicalAngleChange,
  requestOrientationPermission,
  startOrientationTracking,
} from '../orientation';

const CAMERA_SWITCH_DELAY_MS = 600; // browser needs time to release back camera before front opens

type Step = 'start' | 'back' | 'switching' | 'front' | 'preview' | 'uploading' | 'error';

let activeStreams: MediaStream[] = [];

export function stopCaptureStreams(): void {
  activeStreams.forEach(s => s.getTracks().forEach(t => t.stop()));
  activeStreams = [];
}

async function openCamera(
  video: HTMLVideoElement,
  facingMode: 'environment' | 'user',
): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facingMode }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    audio: false,
  });
  activeStreams.push(stream);
  video.srcObject = stream;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Camera timed out')), 15_000);
    video.onloadedmetadata = () => {
      clearTimeout(timeout);
      video.play().then(resolve).catch(reject);
    };
  });
  return stream;
}

// Rotate the video element for correct viewfinder framing when the stream is
// landscape but the device is portrait. Applied purely to display — does not
// affect the pixels captured by captureFrame.
function applyViewfinderTransform(video: HTMLVideoElement): void {
  if (video.videoWidth <= video.videoHeight) return; // stream is already portrait
  const type = screen.orientation?.type ?? '';
  if (!type.startsWith('portrait')) return; // device is landscape or unknown
  const deg = screen.orientation.angle === 180 ? -90 : 90;
  video.style.width = '100vh';
  video.style.height = '100vw';
  video.style.position = 'absolute';
  video.style.left = '50%';
  video.style.top = '50%';
  video.style.objectFit = 'cover';
  video.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;
}

// Thumb-height shutter anchor (issue #72): bottom-center in portrait; in
// landscape the browser rotates the layout, so anchor to the side edge the
// bottom rotated to (landscape-primary → right, landscape-secondary → left)
// and the button stays physically under the thumb.
function shutterPositionClasses(): string {
  const type = screen.orientation?.type ?? '';
  if (type === 'landscape-secondary') {
    return 'absolute left-[max(3rem,calc(env(safe-area-inset-left,0px)+1rem))] top-1/2 -translate-y-1/2';
  }
  if (type.startsWith('landscape')) {
    return 'absolute right-[max(3rem,calc(env(safe-area-inset-right,0px)+1rem))] top-1/2 -translate-y-1/2';
  }
  return 'absolute bottom-[max(3rem,calc(env(safe-area-inset-bottom,0px)+1rem))] left-1/2 -translate-x-1/2';
}

// CCW angle screen.orientation reports for the current layout.
function layoutAngle(): number {
  const type = screen.orientation?.type ?? '';
  if (type === 'landscape-primary') return 90;
  if (type === 'portrait-secondary') return 180;
  if (type === 'landscape-secondary') return 270;
  return 0;
}

// How far the phone is physically rotated relative to its (possibly
// rotation-locked) layout — 0 whenever the layout follows the device.
function physicalVsLayoutDeg(): number {
  return (getPhysicalAngle() - layoutAngle() + 360) % 360;
}

// Keeps an element's icon upright for the user when the layout is rotation-
// locked, mimicking native camera apps. Self-cleans once the element leaves
// the DOM.
function keepUpright(target: Element | null): void {
  if (!(target instanceof HTMLElement) && !(target instanceof SVGElement)) return;
  const el = target;
  el.style.transition = 'transform 0.2s';
  const apply = () => { el.style.transform = `rotate(${physicalVsLayoutDeg()}deg)`; };
  apply();
  const off = onPhysicalAngleChange(() => {
    if (!el.isConnected) { off(); return; }
    apply();
  });
}

// Applies the orientation-aware anchor and keeps it updated while the button
// is mounted; the listener removes itself once the button leaves the DOM
// (same self-cleanup pattern as the feed-header countdown).
function positionShutter(btn: HTMLElement, baseClasses: string): void {
  const apply = () => { btn.className = `${shutterPositionClasses()} ${baseClasses}`; };
  apply();
  const target: EventTarget = screen.orientation ?? window;
  const event = screen.orientation ? 'change' : 'orientationchange';
  const onChange = () => {
    if (!btn.isConnected) { target.removeEventListener(event, onChange); return; }
    apply();
  };
  target.addEventListener(event, onChange);
}

// Grab the current preview frame so the photo matches the viewfinder exactly —
// no still-pipeline lag or AE/AWB shift (issue #76). Orientation is corrected
// using the *physical* device angle at capture time (accelerometer, falling
// back to screen.orientation): with the OS rotation lock on the layout stays
// portrait and the stream stays sensor-native, but a phone held sideways
// should still produce an upright landscape photo.
async function captureFrame(video: HTMLVideoElement): Promise<Blob> {
  const W = video.videoWidth;
  const H = video.videoHeight;
  const layoutPortrait = (screen.orientation?.type ?? '').startsWith('portrait');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  // Landscape layout: the browser already rotated stream and layout together —
  // draw as-is (pre-existing behavior). Portrait layout: the stream is
  // sensor-native; a landscape stream needs +90° when the phone is physically
  // portrait, and the physical angle shifts that correction (0° when held
  // landscape-primary, etc.). With no sensor data getPhysicalAngle mirrors
  // screen.orientation, reproducing the old ±90° behavior exactly.
  const base = W > H && layoutPortrait ? 90 : 0;
  const deg = layoutPortrait ? (base - getPhysicalAngle() + 360) % 360 : 0;

  if (deg === 90 || deg === 270) {
    canvas.width = H;
    canvas.height = W;
  } else {
    canvas.width = W;
    canvas.height = H;
  }
  if (deg === 90) { ctx.translate(H, 0); ctx.rotate(Math.PI / 2); }
  else if (deg === 180) { ctx.translate(W, H); ctx.rotate(Math.PI); }
  else if (deg === 270) { ctx.translate(0, W); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(video, 0, 0, W, H);

  return new Promise((resolve, reject) =>
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('Canvas toBlob failed')), 'image/jpeg', 0.92),
  );
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

async function stitchPhotos(back: Blob, front: Blob): Promise<Blob> {
  const [bi, fi] = await Promise.all([loadImage(back), loadImage(front)]);
  const W = bi.naturalWidth;
  const H = bi.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  ctx.drawImage(bi, 0, 0, W, H);

  // Fit the selfie into 35% of both canvas dimensions so a portrait selfie
  // cannot overflow a landscape main photo (and vice versa).
  const scale = Math.min((W * 0.35) / fi.naturalWidth, (H * 0.35) / fi.naturalHeight);
  const insetW = Math.round(fi.naturalWidth * scale);
  const insetH = Math.round(fi.naturalHeight * scale);
  const pad = Math.round(W * 0.03);
  const r = Math.round(insetW * 0.08);

  ctx.fillStyle = '#ffffff';
  roundRect(ctx, pad - 5, pad - 5, insetW + 10, insetH + 10, r + 5);
  ctx.fill();

  ctx.save();
  roundRect(ctx, pad, pad, insetW, insetH, r);
  ctx.clip();
  ctx.drawImage(fi, pad, pad, insetW, insetH);
  ctx.restore();

  return new Promise((resolve, reject) =>
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('Stitch failed')), 'image/jpeg', 0.92),
  );
}

function cameraErrorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') {
      // Installed iOS web apps get their own Settings entry (iOS 16.4+).
      if (isIOS()) {
        return isPwaInstalled()
          ? 'Camera access denied. Go to Settings → meenow → Camera.'
          : 'Camera access denied. Go to Settings → Safari → Camera.';
      }
      return 'Camera access denied. Go to Settings → Apps → [Browser] → Permissions → Camera.';
    }
    if (err.name === 'NotFoundError') return 'No camera found on this device.';
  }
  return err instanceof Error ? err.message : 'Could not access camera.';
}

export function renderCapture(
  postCount: number,
  onPosted: () => void,
  onDone: () => void,
  onCancel: () => void,
): HTMLElement {
  const root = document.createElement('div');
  root.id = 'screen-capture';

  let closing = false;
  // Track physical orientation for the whole capture flow; also self-cleans
  // via the change subscription if the screen is unmounted externally.
  const stopTracking = startOrientationTracking();
  const offTrackerCleanup = onPhysicalAngleChange(() => {
    if (!root.isConnected) { offTrackerCleanup(); stopTracking(); }
  });
  let backBlob: Blob | null = null;
  let frontBlob: Blob | null = null;
  let compositeBlob: Blob | null = null;
  let previewUrl: string | null = null;
  let statusText = '';
  let locationText = '';
  let progress: PostProgress = {};
  let captureDate = new Date();
  let coords: { lat: number; lon: number; alt?: number } | null = null;
  let saveBlob: Blob | null = null;
  let saveBlobKey = '';

  function exifKey(): string {
    return JSON.stringify([statusText.trim(), coords]);
  }

  // Pre-compute the EXIF-tagged copy for "Save to device" so the save tap can
  // usually call navigator.share without a preceding await (Safari drops the
  // transient user activation after long waits); a stale cache (caption edited
  // since) is rebuilt in handleSave — milliseconds of in-memory work. EXIF goes
  // only into the saved copy, never into the upload: the app deliberately
  // shares location as city-level text only.
  async function buildSaveBlob(): Promise<Blob | null> {
    const source = compositeBlob;
    if (!source) { saveBlob = null; return null; }
    const key = exifKey();
    const b = await insertExif(source, {
      date: captureDate,
      description: statusText.trim() || undefined,
      ...(coords ?? {}),
    });
    if (compositeBlob === source) { saveBlob = b; saveBlobKey = key; }
    return b;
  }

  function show(step: Step, message = '', detail = ''): void {
    stopCaptureStreams();
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    root.className = step === 'back' || step === 'front' || step === 'preview'
      ? 'fixed inset-0 bg-black'
      // 'start' reserves bottom space for its absolutely anchored shutter (portrait only).
      : step === 'start' ? 'screen gap-8 text-center relative pb-40 landscape:pb-0'
      : 'screen gap-8 text-center';
    root.innerHTML = '';

    if (step === 'start') root.appendChild(makeStart());
    else if (step === 'back') root.appendChild(makeBackCamera());
    else if (step === 'switching') root.appendChild(makeMessage('Switching to selfie…'));
    else if (step === 'front') root.appendChild(makeFrontCamera());
    else if (step === 'preview') root.appendChild(makePreview());
    else if (step === 'uploading') root.appendChild(makeSpinner());
    else root.appendChild(makeError(message, detail));

    // Exit route on every non-transient step — iOS has no hardware back
    // button (issue #71). Hidden while switching (~600ms) and uploading.
    if (step !== 'switching' && step !== 'uploading') root.appendChild(makeCancel(step));
  }

  function makeCancel(step: Step): HTMLElement {
    const dark = step === 'back' || step === 'front' || step === 'preview';
    const btn = document.createElement('button');
    // fixed, not absolute: on cream steps root is not a positioned ancestor.
    btn.className = `fixed top-[max(1rem,calc(env(safe-area-inset-top,0px)+0.5rem))] left-4 w-10 h-10 flex items-center justify-center rounded-full text-2xl leading-none ${
      dark ? 'bg-black/50 text-white' : 'text-ink/40 hover:text-gold transition-colors'
    }`;
    btn.textContent = '×';
    btn.setAttribute('aria-label', 'Cancel');
    btn.addEventListener('click', () => {
      closing = true;
      stopCaptureStreams();
      stopTracking();
      onCancel();
    });
    return btn;
  }

  function makeStart(): HTMLElement {
    const count = postCount;
    const isSecond = count === MAX_POSTS_PER_TRIGGER - 1;
    const d = document.createElement('div');
    d.className = 'flex flex-col items-center gap-8';
    d.innerHTML = `
      <div class="space-y-2">
        <p class="text-xs text-ink/40 uppercase tracking-widest">${count + 1} of ${MAX_POSTS_PER_TRIGGER}</p>
        <h2 class="text-2xl font-semibold text-ink">${isSecond ? 'One more meenow!' : "It's meenow time!"}</h2>
        <p class="text-sm text-ink/60 max-w-xs leading-relaxed">
          ${isSecond ? 'Go again — surroundings first, then your face.' : 'First your surroundings, then your selfie.'}
        </p>
      </div>
    `;
    const btn = document.createElement('button');
    positionShutter(btn, 'w-20 h-20 text-ink hover:text-gold transition-colors active:scale-95');
    btn.setAttribute('aria-label', 'Start camera');
    btn.innerHTML = CAT_EARS_SHUTTER;
    keepUpright(btn.firstElementChild);
    btn.addEventListener('click', () => {
      // iOS requires a user gesture for motion-sensor permission; elsewhere no-op.
      void requestOrientationPermission();
      show('back');
    });
    d.appendChild(btn);

    const note = document.createElement('div');
    note.className = 'text-xs text-center max-w-xs leading-relaxed space-y-2 border border-ink/10 rounded-xl px-4 py-3';
    note.innerHTML = `
      <p class="text-ink/60">Your followers on Pixelfed will see each photo you post. meenow uses <strong>followers-only</strong> visibility.</p>
      <p class="text-ink/50">On Pixelfed, photos are archived automatically after the next daily trigger — hidden from followers, but still visible to you.</p>
    `;
    d.appendChild(note);
    return d;
  }

  function makeBackCamera(): HTMLElement {
    const d = document.createElement('div');
    d.className = 'w-full h-full relative flex items-center justify-center';
    const video = document.createElement('video');
    video.id = 'cam-video';
    video.className = 'w-full h-full object-cover';
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    d.appendChild(video);

    const hint = document.createElement('p');
    hint.className = 'absolute top-[max(2rem,calc(env(safe-area-inset-top,0px)+0.5rem))] left-1/2 -translate-x-1/2 text-white/70 text-sm bg-black/30 rounded-full px-4 py-1.5';
    hint.textContent = 'Point at your surroundings';
    d.appendChild(hint);

    const btn = document.createElement('button');
    positionShutter(btn, 'w-20 h-20 text-white drop-shadow-lg active:scale-95');
    btn.setAttribute('aria-label', 'Capture');
    btn.innerHTML = CAT_EARS_SHUTTER;
    keepUpright(btn.firstElementChild);
    btn.addEventListener('click', () => captureBack(video));
    d.appendChild(btn);

    openCamera(video, 'environment')
      .then(() => applyViewfinderTransform(video))
      .catch(err => show('error', cameraErrorMessage(err)));
    return d;
  }

  function cancelled(): boolean {
    return closing || !root.isConnected;
  }

  async function captureBack(video: HTMLVideoElement): Promise<void> {
    captureDate = new Date();
    backBlob = await captureFrame(video).catch(() => null);
    if (cancelled()) return;
    if (!backBlob) { show('error', 'Failed to capture.'); return; }
    stopCaptureStreams();
    show('switching');
    await new Promise(r => setTimeout(r, CAMERA_SWITCH_DELAY_MS));
    if (cancelled()) return;
    show('front');
    startFront();
  }

  function makeFrontCamera(): HTMLElement {
    const d = document.createElement('div');
    d.className = 'w-full h-full relative flex items-center justify-center';
    const video = document.createElement('video');
    video.id = 'front-video';
    video.className = 'w-full h-full object-cover';
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    d.appendChild(video);

    const countdownEl = document.createElement('div');
    countdownEl.id = 'selfie-countdown';
    countdownEl.className = 'absolute inset-0 flex items-center justify-center text-white text-9xl font-bold drop-shadow-2xl';
    keepUpright(countdownEl);
    d.appendChild(countdownEl);

    return d;
  }

  async function startFront(): Promise<void> {
    const video = document.getElementById('front-video') as HTMLVideoElement | null;
    if (!video) return;
    try {
      await openCamera(video, 'user');
      applyViewfinderTransform(video);
      const t = video.style.transform;
      video.style.transform = t ? `${t} scaleX(-1)` : 'scaleX(-1)';
    } catch (err) {
      if (cancelled()) return;
      show('error', cameraErrorMessage(err));
      return;
    }
    if (cancelled()) return;
    const countdownEl = document.getElementById('selfie-countdown');
    for (let i = 3; i >= 1; i--) {
      if (countdownEl) countdownEl.textContent = String(i);
      await new Promise(r => setTimeout(r, 1000));
      if (cancelled()) return;
    }
    if (countdownEl) countdownEl.textContent = '';
    frontBlob = await captureFrame(video).catch(() => null);
    if (cancelled()) return;
    if (!frontBlob) { show('error', 'Failed to capture selfie.'); return; }
    stopCaptureStreams();
    compositeBlob = await stitchPhotos(backBlob!, frontBlob).catch(() => null);
    if (cancelled()) return;
    if (!compositeBlob) { show('error', 'Failed to stitch photos.'); return; }
    progress = {};
    void buildSaveBlob();
    show('preview');
  }

  function makePreview(): HTMLElement {
    const d = document.createElement('div');
    d.className = 'w-full h-full flex flex-col';

    const imgWrapper = document.createElement('div');
    imgWrapper.className = 'relative flex-1 min-h-0 flex items-center justify-center overflow-hidden';
    previewUrl = URL.createObjectURL(compositeBlob!);
    const img = document.createElement('img');
    img.src = previewUrl;
    img.className = 'max-w-full max-h-full object-contain';
    img.alt = 'Your meenow photo';
    imgWrapper.appendChild(img);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'absolute top-[max(1rem,calc(env(safe-area-inset-top,0px)+0.5rem))] right-4 w-10 h-10 flex items-center justify-center rounded-full bg-black/50 text-white [&>svg]:size-5 active:scale-95';
    saveBtn.setAttribute('aria-label', 'Save to device');
    saveBtn.innerHTML = SAVE_ICON;
    saveBtn.addEventListener('click', () => void handleSave(saveBtn));
    imgWrapper.appendChild(saveBtn);

    d.appendChild(imgWrapper);

    const bar = document.createElement('div');
    bar.className = 'shrink-0 bg-cream px-4 pt-3 pb-5 safe-area-bottom flex flex-col gap-2.5';

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Add a message… (optional)';
    textarea.className = 'w-full rounded-xl border border-ink/15 bg-cream px-3 py-2 text-sm text-ink placeholder:text-ink/30 resize-none focus:outline-none focus:ring-1 focus:ring-gold/50';
    textarea.rows = 2;
    textarea.value = statusText;
    textarea.addEventListener('input', () => { statusText = textarea.value; });
    bar.appendChild(textarea);

    const locRow = document.createElement('div');
    locRow.className = 'flex items-center';
    const locBtn = document.createElement('button');
    locBtn.type = 'button';

    function renderLocBtn(): void {
      if (locationText) {
        locBtn.className = 'text-xs text-gold border border-gold/30 rounded-full px-3 py-1.5 max-w-full truncate';
        locBtn.textContent = locationText;
        locBtn.title = 'Tap to clear location';
        locBtn.onclick = () => { locationText = ''; coords = null; void buildSaveBlob(); renderLocBtn(); };
      } else {
        locBtn.className = 'text-xs text-ink/40 hover:text-gold transition-colors border border-ink/15 rounded-full px-3 py-1.5';
        locBtn.textContent = 'Add location';
        locBtn.title = '';
        locBtn.onclick = () => void doFetchLocation();
      }
    }

    async function doFetchLocation(): Promise<void> {
      locBtn.textContent = 'Getting location…';
      locBtn.disabled = true;
      locBtn.onclick = null;
      coords = null;
      try {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10_000 })
        );
        coords = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          alt: pos.coords.altitude ?? undefined,
        };
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${coords.lat}&lon=${coords.lon}&zoom=10`,
            { headers: { 'Accept-Language': 'en' } }
          );
          if (!res.ok) throw new Error('Geocoding failed');
          const data = await res.json() as { address?: { city?: string; town?: string; village?: string; country?: string } };
          const city = data.address?.city ?? data.address?.town ?? data.address?.village;
          const country = data.address?.country;
          locationText = `📍 ${[city, country].filter(Boolean).join(', ')}`;
        } catch {
          // Offline or geocoder unreachable: keep the fix as raw coordinates.
          locationText = `📍 ${coords.lat.toFixed(2)}, ${coords.lon.toFixed(2)}`;
        }
      } catch {
        locationText = '';
      }
      void buildSaveBlob();
      locBtn.disabled = false;
      renderLocBtn();
    }

    renderLocBtn();
    locRow.appendChild(locBtn);
    bar.appendChild(locRow);

    const btnRow = document.createElement('div');
    btnRow.className = 'flex gap-3';

    const retakeBtn = document.createElement('button');
    retakeBtn.className = 'flex-1 border border-ink/20 text-ink rounded-full py-3 text-sm font-medium';
    retakeBtn.textContent = 'Retake';
    retakeBtn.addEventListener('click', () => {
      backBlob = null; frontBlob = null; compositeBlob = null; saveBlob = null;
      progress = {};
      show('start'); // show() revokes previewUrl
    });
    btnRow.appendChild(retakeBtn);

    const postBtn = document.createElement('button');
    postBtn.className = 'flex-1 btn-primary';
    postBtn.textContent = 'Post';
    postBtn.addEventListener('click', () => upload()); // show('uploading') inside upload() revokes previewUrl
    btnRow.appendChild(postBtn);

    bar.appendChild(btnRow);
    d.appendChild(bar);
    return d;
  }

  async function upload(): Promise<void> {
    show('uploading');
    const auth = getAuthState();
    if (!auth) { show('error', 'Not logged in.'); return; }
    try {
      const parts = [statusText.trim(), locationText.trim()].filter(Boolean);
      await postMeenow(auth, compositeBlob!, backBlob!, frontBlob!, parts.join('\n') || undefined, progress);
      statusText = '';
      locationText = '';
      progress = {};
      stopTracking();
      onPosted();
      onDone();
    } catch (err) {
      if (err instanceof TypeError) {
        show('error', 'Network problem — your photo is safe.', err.message);
      } else {
        show('error', err instanceof Error ? err.message : 'Upload failed.');
      }
    }
  }

  async function handleSave(btn: HTMLButtonElement): Promise<void> {
    const cached = saveBlob && saveBlobKey === exifKey() ? saveBlob : null;
    const blob = cached ?? (await buildSaveBlob()) ?? compositeBlob;
    if (!blob) return;
    btn.disabled = true;
    const result = await saveImage(blob, dateFilename('meenow', captureDate));
    if ((result === 'shared' || result === 'downloaded') && btn.isConnected) {
      btn.innerHTML = CHECK_ICON;
      setTimeout(() => { btn.innerHTML = SAVE_ICON; btn.disabled = false; }, 1500);
    } else {
      btn.innerHTML = SAVE_ICON;
      btn.disabled = false;
    }
  }

  function makeMessage(text: string): HTMLElement {
    const d = document.createElement('div');
    const p = document.createElement('p');
    p.className = 'text-ink/60 text-sm';
    p.textContent = text;
    d.appendChild(p);
    return d;
  }

  function makeSpinner(): HTMLElement {
    const d = document.createElement('div');
    d.className = 'flex flex-col items-center gap-4';
    d.innerHTML = `
      <div class="w-12 h-12 spinner"></div>
      <p class="text-sm text-ink/60">Posting your meenow…</p>
    `;
    return d;
  }

  function makeError(message: string, detail = ''): HTMLElement {
    const d = document.createElement('div');
    d.className = 'flex flex-col items-center gap-6 max-w-xs';
    const p = document.createElement('p');
    p.className = 'text-sm text-ink/70 leading-relaxed';
    p.textContent = message;
    d.appendChild(p);
    if (detail) {
      const dp = document.createElement('p');
      dp.className = 'text-xs text-ink/40';
      dp.textContent = detail;
      d.appendChild(dp);
    }
    const btn = document.createElement('button');
    btn.className = 'btn-primary';
    btn.textContent = 'Try again';
    // A completed photo means the failure was in the upload: retry the post
    // with the same blobs instead of restarting the camera flow.
    if (compositeBlob) {
      btn.addEventListener('click', () => void upload());
      d.appendChild(btn);
      const backBtn = document.createElement('button');
      backBtn.className = 'border border-ink/20 text-ink rounded-full py-3 px-6 text-sm font-medium';
      backBtn.textContent = 'Back to preview';
      backBtn.addEventListener('click', () => show('preview'));
      d.appendChild(backBtn);
    } else {
      btn.addEventListener('click', () => show('start'));
      d.appendChild(btn);
    }
    return d;
  }

  show('start');
  return root;
}
