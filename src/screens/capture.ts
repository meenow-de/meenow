import { markPostedToday, postsToday, MAX_POSTS_PER_TRIGGER } from '../state';

const CAMERA_SWITCH_DELAY_MS = 600; // browser needs time to release back camera before front opens
import { getAuthState } from '../api/auth';
import { postMeenow } from '../api/pixelfed';
import { CAT_EARS_SHUTTER } from '../icons';

type Step = 'start' | 'back' | 'switching' | 'front' | 'preview' | 'uploading' | 'error';

let activeStreams: MediaStream[] = [];

function stopAllStreams(): void {
  activeStreams.forEach(s => s.getTracks().forEach(t => t.stop()));
  activeStreams = [];
}

async function openCamera(
  video: HTMLVideoElement,
  facingMode: 'environment' | 'user',
): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facingMode }, width: { ideal: 1080 }, height: { ideal: 1920 } },
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

async function captureFrame(video: HTMLVideoElement, forcePortrait: boolean): Promise<Blob> {
  const W = video.videoWidth;
  const H = video.videoHeight;
  const canvas = document.createElement('canvas');
  if (forcePortrait && W > H) {
    // Rotate landscape stream 90° counter-clockwise to portrait
    canvas.width = H;
    canvas.height = W;
    const ctx = canvas.getContext('2d')!;
    ctx.translate(0, W);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(video, 0, 0);
  } else {
    canvas.width = W;
    canvas.height = H;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
  }
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

  const insetW = Math.round(W * 0.35);
  const insetH = Math.round(insetW * fi.naturalHeight / fi.naturalWidth);
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
      return /iphone|ipad|ipod/i.test(navigator.userAgent)
        ? 'Camera access denied. Go to Settings → Safari → Camera.'
        : 'Camera access denied. Go to Settings → Apps → [Browser] → Permissions → Camera.';
    }
    if (err.name === 'NotFoundError') return 'No camera found on this device.';
  }
  return err instanceof Error ? err.message : 'Could not access camera.';
}

export function renderCapture(onDone?: () => void): HTMLElement {
  const root = document.createElement('div');
  root.id = 'screen-capture';

  let backBlob: Blob | null = null;
  let frontBlob: Blob | null = null;
  let compositeBlob: Blob | null = null;
  let preferPortrait = true;
  let previewUrl: string | null = null;

  function show(step: Step, message = ''): void {
    stopAllStreams();
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    root.className = step === 'back' || step === 'front' || step === 'preview'
      ? 'fixed inset-0 bg-black'
      : 'screen gap-8 text-center';
    root.innerHTML = '';

    if (step === 'start') root.appendChild(makeStart());
    else if (step === 'back') root.appendChild(makeBackCamera());
    else if (step === 'switching') root.appendChild(makeMessage('Switching to selfie…'));
    else if (step === 'front') root.appendChild(makeFrontCamera());
    else if (step === 'preview') root.appendChild(makePreview());
    else if (step === 'uploading') root.appendChild(makeSpinner());
    else root.appendChild(makeError(message));
  }

  function makeStart(): HTMLElement {
    const count = postsToday();
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
    btn.className = 'w-20 h-20 text-ink hover:text-gold transition-colors active:scale-95';
    btn.setAttribute('aria-label', 'Start camera');
    btn.innerHTML = CAT_EARS_SHUTTER;
    btn.addEventListener('click', () => show('back'));
    d.appendChild(btn);
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
    hint.className = 'absolute top-8 left-1/2 -translate-x-1/2 text-white/70 text-sm bg-black/30 rounded-full px-4 py-1.5';
    hint.textContent = 'Point at your surroundings';
    d.appendChild(hint);

    const orientBtn = document.createElement('button');
    orientBtn.className = 'absolute top-8 right-4 text-white/70 text-xs bg-black/30 rounded-full px-3 py-1.5 backdrop-blur-sm';
    orientBtn.textContent = preferPortrait ? '↕ portrait' : '↔ landscape';
    orientBtn.addEventListener('click', () => {
      preferPortrait = !preferPortrait;
      orientBtn.textContent = preferPortrait ? '↕ portrait' : '↔ landscape';
    });
    d.appendChild(orientBtn);

    const btn = document.createElement('button');
    btn.className = 'absolute bottom-12 left-1/2 -translate-x-1/2 w-20 h-20 text-white drop-shadow-lg active:scale-95';
    btn.setAttribute('aria-label', 'Capture');
    btn.innerHTML = CAT_EARS_SHUTTER;
    btn.addEventListener('click', () => captureBack(video));
    d.appendChild(btn);

    openCamera(video, 'environment').catch(err => show('error', cameraErrorMessage(err)));
    return d;
  }

  async function captureBack(video: HTMLVideoElement): Promise<void> {
    backBlob = await captureFrame(video, preferPortrait).catch(() => null);
    if (!backBlob) { show('error', 'Failed to capture.'); return; }
    stopAllStreams();
    show('switching');
    await new Promise(r => setTimeout(r, CAMERA_SWITCH_DELAY_MS));
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
    d.appendChild(countdownEl);

    return d;
  }

  async function startFront(): Promise<void> {
    const video = document.getElementById('front-video') as HTMLVideoElement | null;
    if (!video) return;
    try {
      await openCamera(video, 'user');
    } catch (err) {
      show('error', cameraErrorMessage(err));
      return;
    }
    const countdownEl = document.getElementById('selfie-countdown');
    for (let i = 3; i >= 1; i--) {
      if (countdownEl) countdownEl.textContent = String(i);
      await new Promise(r => setTimeout(r, 1000));
    }
    if (countdownEl) countdownEl.textContent = '';
    frontBlob = await captureFrame(video, preferPortrait).catch(() => null);
    if (!frontBlob) { show('error', 'Failed to capture selfie.'); return; }
    stopAllStreams();
    compositeBlob = await stitchPhotos(backBlob!, frontBlob).catch(() => null);
    if (!compositeBlob) { show('error', 'Failed to stitch photos.'); return; }
    show('preview');
  }

  function makePreview(): HTMLElement {
    const d = document.createElement('div');
    d.className = 'w-full h-full flex flex-col';

    const imgWrapper = document.createElement('div');
    imgWrapper.className = 'flex-1 min-h-0 flex items-center justify-center overflow-hidden';
    previewUrl = URL.createObjectURL(compositeBlob!);
    const img = document.createElement('img');
    img.src = previewUrl;
    img.className = 'max-w-full max-h-full object-contain';
    img.alt = 'Your meenow photo';
    imgWrapper.appendChild(img);
    d.appendChild(imgWrapper);

    const bar = document.createElement('div');
    bar.className = 'shrink-0 bg-cream px-6 py-5 safe-area-bottom flex gap-3';

    const retakeBtn = document.createElement('button');
    retakeBtn.className = 'flex-1 border border-ink/20 text-ink rounded-full py-3 text-sm font-medium';
    retakeBtn.textContent = 'Retake';
    retakeBtn.addEventListener('click', () => {
      backBlob = null; frontBlob = null; compositeBlob = null;
      show('start'); // show() revokes previewUrl
    });
    bar.appendChild(retakeBtn);

    const postBtn = document.createElement('button');
    postBtn.className = 'flex-1 btn-primary';
    postBtn.textContent = 'Post';
    postBtn.addEventListener('click', () => upload()); // show('uploading') inside upload() revokes previewUrl
    bar.appendChild(postBtn);

    d.appendChild(bar);
    return d;
  }

  async function upload(): Promise<void> {
    show('uploading');
    const auth = getAuthState();
    if (!auth) { show('error', 'Not logged in.'); return; }
    try {
      await postMeenow(auth, compositeBlob!, backBlob!, frontBlob!);
      markPostedToday();
      onDone?.();
    } catch (err) {
      show('error', err instanceof Error ? err.message : 'Upload failed.');
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
      <div class="w-12 h-12 border-4 border-gold/30 border-t-gold rounded-full animate-spin"></div>
      <p class="text-sm text-ink/60">Posting your meenow…</p>
    `;
    return d;
  }

  function makeError(message: string): HTMLElement {
    const d = document.createElement('div');
    d.className = 'flex flex-col items-center gap-6 max-w-xs';
    const p = document.createElement('p');
    p.className = 'text-sm text-ink/70 leading-relaxed';
    p.textContent = message;
    d.appendChild(p);
    const btn = document.createElement('button');
    btn.className = 'btn-primary';
    btn.textContent = 'Try again';
    btn.addEventListener('click', () => show('start'));
    d.appendChild(btn);
    return d;
  }

  show('start');
  return root;
}
