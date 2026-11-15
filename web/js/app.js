'use strict';

// ── Module instances ──────────────────────────────────────────────────────────
const detector   = new NeedleDetector();
const calculator = new NeedleCalculator();
const recorder   = new DataRecorder();

// ── State ─────────────────────────────────────────────────────────────────────
let opencvReady = false;
let streaming   = false;
let loopHandle  = null;
let lastResult  = null;
let isSet       = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const video      = document.getElementById('video');
const canvas     = document.getElementById('canvas');
const ctx        = canvas.getContext('2d', { willReadFrequently: true });
const noDetect   = document.getElementById('no-detect');
const setPill    = document.getElementById('set-pill');

const cvStatus   = document.getElementById('cv-status');
const camStatus  = document.getElementById('cam-status');
const saveMsg    = document.getElementById('save-msg');

const btnCam     = document.getElementById('btn-cam');
const btnSet     = document.getElementById('btn-set');
const btnDisplay = document.getElementById('btn-display');
const btnSave    = document.getElementById('btn-save');
const btnExport  = document.getElementById('btn-export');

// ── OpenCV lifecycle ──────────────────────────────────────────────────────────
function onOpenCvReady() {
  opencvReady = true;
  cvStatus.textContent = '✅ OpenCV';
  cvStatus.className   = 'badge badge-ok';
}
// @techstark/opencv-js trả về Promise — resolve để lấy module thực
function onOpenCvScriptLoaded() {
  cv.then(instance => {
    window.cv = instance;   // thay thế Promise bằng module thật
    onOpenCvReady();
  }).catch(() => onOpenCvError());
}
function onOpenCvError() {
  cvStatus.textContent = '❌ OpenCV';
  cvStatus.style.background = '#4a1616';
  cvStatus.style.color      = '#ff7b7b';
}

// ── Persistent settings ───────────────────────────────────────────────────────
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('acup_' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch (_) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('acup_' + key, JSON.stringify(value)); } catch (_) {}
  },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Thông báo không chặn. Không dùng alert(): trên iOS Safari hộp thoại alert
// có thể làm video camera bị tạm dừng (hình đứng).
const toastEl = document.getElementById('toast');
let toastTimer = null;
function notify(msg) {
  toastEl.textContent = msg;
  toastEl.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 4000);
}

// ── View (vùng quan sát) & hình học ───────────────────────────────────────────
// Mọi toạ độ đo đạc đều quy về pixel của khung hình camera gốc ("src"),
// nên zoom / dời khung không làm sai kết quả.
let needleLenCm  = clamp(store.get('needleLen', NEEDLE_TOTAL_CM), 1, 20);  // đỉnh cán → mũi kim (cm)
calculator.setNeedleLength(needleLenCm);
const searchDetector = new NeedleDetector();   // dò ngầm toàn khung khi mất dấu
const offCanvas      = document.createElement('canvas');
const offCtx         = offCanvas.getContext('2d', { willReadFrequently: true });
const HOLD_FRAMES    = 10;   // số khung giữ kết quả cũ khi mất dấu tạm thời
const ZOOM_MAX   = 8;
const SEARCH_LONG = 960;   // cạnh dài canvas khi quét toàn khung
const TRACK_LONG  = 640;   // cạnh dài canvas khi đã zoom vào kim

const view = {
  zoom: clamp(store.get('zoom', 2.5), 1, ZOOM_MAX),
  cx: 0.5, cy: 0.5,        // tâm vùng quan sát (tỉ lệ 0–1 của khung gốc)
  mode: 'search',          // 'search' = toàn khung, 'track' = đã zoom
  auto: true,
  hits: 0, lost: 0,
};
// Trạng thái bám kim (toạ độ khung gốc, đã làm mượt)
const track = { top: null, bottom: null, dir: null, deg: 90, misses: 0 };
const vwatch = { t: -1, since: 0, seen: false, tried: false, busy: false };
const geo = {
  tiltDeg: clamp(store.get('tilt', 75), 20, 90),  // góc nghiêng điện thoại so với mặt bàn
  cmPerPx: null,                                  // cm trên 1 pixel khung gốc
  skin: store.get('skin', null),                  // điểm châm trên da {fx, fy}
};
let roi         = { x: 0, y: 0, w: 1, h: 1 };
let srcW        = 0;
let tapMode     = null;    // null | 'skin' | 'color'
let pendingPick = null;
let lastFrameT  = 0;
let focusInfo   = '';

const zoomEl    = document.getElementById('zoom');
const zoomLbl   = document.getElementById('zoom-lbl');
const btnAuto   = document.getElementById('btn-auto');
const btnSkin   = document.getElementById('btn-skin');
const tapHint   = document.getElementById('tap-hint');
const camSelect = document.getElementById('cam-select');
const camInfo   = document.getElementById('cam-info');
const tiltEl    = document.getElementById('tilt');
const scaleEl   = document.getElementById('px-scale');
const lenEl     = document.getElementById('needle-len');

/** Hệ số co ngắn theo chiều dọc ảnh do camera nhìn chúc xuống. */
function cosPitch() {
  return Math.max(0.2, Math.sin(geo.tiltDeg * Math.PI / 180));
}
function canvasToSrc(u, v) {
  return [roi.x + u * roi.w / canvas.width, roi.y + v * roi.h / canvas.height];
}
function srcToCanvas(x, y) {
  return [(x - roi.x) * canvas.width / roi.w, (y - roi.y) * canvas.height / roi.h];
}
function skinSrc() {
  if (!geo.skin || !video.videoWidth) return null;
  return [geo.skin.fx * video.videoWidth, geo.skin.fy * video.videoHeight];
}
/** src px → "pixel chuẩn" của NeedleCalculator (đã bù nghiêng và tỉ lệ). */
function toNorm([x, y]) {
  const f = geo.cmPerPx / PIXEL_TO_CM;
  return [x * f, y / cosPitch() * f];
}
/** Góc kim so với mặt da, bù co ngắn chiều dọc. */
function correctAngle(inclineDeg) {
  if (inclineDeg >= 89.5) return 90;
  const t = Math.tan(inclineDeg * Math.PI / 180) / cosPitch();
  return Math.atan(t) * 180 / Math.PI;
}

function setScale(cmPerPx, persist = true) {
  geo.cmPerPx = cmPerPx;
  scaleEl.value = cmPerPx ? cmPerPx.toFixed(5) : '';
  if (persist && cmPerPx && video.videoWidth) {
    store.set('scale2', { cmPerPx, w: video.videoWidth });
  }
}
function setTilt(deg) {
  geo.tiltDeg = clamp(deg, 20, 90);
  tiltEl.value = geo.tiltDeg;
  store.set('tilt', geo.tiltDeg);
}
function setAuto(on) {
  view.auto = on;
  btnAuto.classList.toggle('on', on);
  if (on) { view.mode = 'search'; view.hits = 0; view.lost = 0; track.top = null; }
}
function setTapMode(mode) {
  tapMode = mode;
  btnSkin.classList.toggle('on', mode === 'skin');
  tapHint.style.display = mode ? 'block' : 'none';
  tapHint.textContent = mode === 'skin'  ? 'Chạm vào điểm châm trên mặt da'
                      : mode === 'color' ? 'Chạm vào cán kim để lấy màu' : '';
}

// ── Camera ────────────────────────────────────────────────────────────────────
function openStream(deviceId) {
  // Độ phân giải cao để còn chi tiết sau khi zoom số.
  const v = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  if (deviceId) v.deviceId = { exact: deviceId };
  else          v.facingMode = { ideal: 'environment' };
  return navigator.mediaDevices.getUserMedia({ video: v, audio: false });
}

async function listCameras() {
  let cams = [];
  try {
    cams = (await navigator.mediaDevices.enumerateDevices())
      .filter(d => d.kind === 'videoinput' && d.label);
  } catch (_) {}
  camSelect.innerHTML = '<option value="">Mặc định (camera sau)</option>';
  cams.forEach(d => {
    const o = document.createElement('option');
    o.value = d.deviceId; o.textContent = d.label;
    camSelect.appendChild(o);
  });
  return cams;
}

async function attachStream(stream) {
  video.srcObject = stream;
  await video.play();

  const track = stream.getVideoTracks()[0];
  focusInfo = 'trình duyệt không cho điều khiển — giữ máy cách kim 25–30 cm';
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      focusInfo = 'tự động liên tục';
    }
  } catch (_) {}

  const opt = [...camSelect.options].find(o => o.textContent === track.label);
  camSelect.value = opt && store.get('camLabel', '') ? opt.value : '';
  camInfo.dataset.label = track.label || 'camera';
  srcW = 0;   // buộc cập nhật thông tin khi có khung hình đầu tiên
}

async function startCamera(deviceId = null) {
  try {
    let stream = await openStream(deviceId);
    const cams = await listCameras();
    if (!deviceId) {
      // Khôi phục ống kính đã chọn lần trước (so theo tên vì deviceId có thể đổi).
      const wanted = store.get('camLabel', '');
      const pick   = wanted && cams.find(d => d.label === wanted);
      if (pick && pick.label !== stream.getVideoTracks()[0].label) {
        stream.getTracks().forEach(t => t.stop());
        try { stream = await openStream(pick.deviceId); }
        catch (_) { stream = await openStream(null); }
      }
    }
    await attachStream(stream);

    streaming = true;
    document.getElementById('cam-placeholder').style.display = 'none';
    btnCam.textContent = 'TẮT CAMERA';
    btnCam.classList.add('active');
    camStatus.textContent = '📷 Bật';
    camStatus.className   = 'badge badge-cam';

    if (view.auto) setAuto(true);
    startLoop();
  } catch (err) {
    notify('Không thể mở camera: ' + err.message
      + '\n\nTrên iOS: dùng Safari và mở qua HTTPS hoặc localhost.');
  }
}

function stopCamera() {
  streaming = false;
  stopLoop();
  const stream = video.srcObject;
  if (stream) stream.getTracks().forEach(t => t.stop());
  video.srcObject = null;
  lastResult = null;
  track.top = null;
  vwatch.t = -1; vwatch.seen = false;
  setTapMode(null);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  document.getElementById('cam-placeholder').style.display = 'flex';
  btnCam.textContent = 'BẬT CAMERA';
  btnCam.classList.remove('active');
  camStatus.textContent = '📷 Tắt';
  camStatus.className   = 'badge';
  noDetect.style.display = 'none';
}

btnCam.addEventListener('click', () => {
  if (streaming) stopCamera(); else startCamera();
});

// ── Tự khôi phục khi hình camera bị đứng ──────────────────────────────────────
video.addEventListener('pause', () => {
  if (streaming && video.srcObject) video.play().catch(() => {});
});

function watchVideo(now) {
  const ct = video.currentTime;
  if (ct !== vwatch.t) {
    if (vwatch.t >= 0) vwatch.seen = true;
    vwatch.t = ct; vwatch.since = now; vwatch.tried = false;
    return;
  }
  if (!vwatch.seen || vwatch.busy) return;
  const stuck = now - vwatch.since;
  if (stuck > 1200 && !vwatch.tried) {
    vwatch.tried = true;
    video.play().catch(() => {});
  } else if (stuck > 3500) {
    recoverCamera();
  }
}

async function recoverCamera() {
  vwatch.busy = true;
  try {
    const old = video.srcObject;
    if (old) old.getTracks().forEach(t => t.stop());
    await attachStream(await openStream(camSelect.value || null));
  } catch (e) {
    console.error('recoverCamera error:', e);
  } finally {
    vwatch.busy = false; vwatch.t = -1; vwatch.seen = false;
    vwatch.since = performance.now();
  }
}

camSelect.addEventListener('change', async () => {
  const id = camSelect.value;
  store.set('camLabel', id ? camSelect.selectedOptions[0].textContent : '');
  if (!streaming) return;
  stopCamera();
  await startCamera(id || null);
});

/** Gọi khi kích thước khung hình gốc thay đổi (mở camera / đổi ống kính). */
function onSourceSize(vw, vh) {
  srcW = vw;
  camInfo.textContent =
    `${camInfo.dataset.label || 'camera'} · ${vw}×${vh} · lấy nét: ${focusInfo}`;
  // Tỉ lệ đã hiệu chuẩn được lưu kèm bề rộng khung → quy đổi nếu độ phân giải khác.
  const saved = store.get('scale2', null);
  if (saved && saved.cmPerPx > 0 && saved.w > 0) {
    setScale(saved.cmPerPx * saved.w / vw, false);
  }
}

// ── Frame loop ────────────────────────────────────────────────────────────────
function startLoop() {
  if (loopHandle) return;
  loopHandle = setTimeout(frameStep, 35);
}
function stopLoop() {
  if (loopHandle) { clearTimeout(loopHandle); loopHandle = null; }
}

/** Tính vùng cắt trên khung gốc và kích thước canvas xử lý. */
function layoutView(vw, vh) {
  const z = view.mode === 'search' ? 1 : view.zoom;
  const w = vw / z, h = vh / z;
  roi = {
    x: clamp(view.cx * vw - w / 2, 0, vw - w),
    y: clamp(view.cy * vh - h / 2, 0, vh - h),
    w, h,
  };
  const long = view.mode === 'search' ? SEARCH_LONG : TRACK_LONG;
  const s    = Math.min(1, long / Math.max(vw, vh));
  const cw   = Math.round(vw * s), ch = Math.round(vh * s);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw; canvas.height = ch;
  }
  zoomLbl.textContent = z.toFixed(1) + '×';
  if (view.mode === 'track' && document.activeElement !== zoomEl) zoomEl.value = view.zoom;
}

/** Làm mượt kết quả thô và giữ kết quả cũ trong vài khung khi mất dấu. */
function trackUpdate(raw) {
  if (raw.found) {
    const top    = canvasToSrc(raw.top[0], raw.top[1]);
    const bottom = canvasToSrc(raw.bottom[0], raw.bottom[1]);
    const cont = track.top && track.misses <= HOLD_FRAMES &&
      Math.hypot(top[0] - track.top[0], top[1] - track.top[1]) < roi.h * 0.25;
    const a   = cont ? 0.6 : 1;
    const mix = (o, n) => [o[0] + a * (n[0] - o[0]), o[1] + a * (n[1] - o[1])];
    track.top    = cont ? mix(track.top, top) : top;
    track.bottom = cont && track.bottom ? mix(track.bottom, bottom) : bottom;
    if (raw.axisOk && raw.lengthPx > 12) {
      // Hướng thân kim (từ đỉnh xuống mũi), chỉ cập nhật khi thấy đủ dài để tin cậy.
      const dx = bottom[0] - top[0], dy = bottom[1] - top[1];
      const n  = Math.hypot(dx, dy) || 1;
      let d = [dx / n, dy / n];
      if (cont && track.dir) {
        d = mix(track.dir, d);
        const m = Math.hypot(d[0], d[1]) || 1;
        d = [d[0] / m, d[1] / m];
      }
      track.dir = d;
    }
    if (raw.axisOk) {
      const deg = correctAngle(raw.incline);
      track.deg = cont ? track.deg + a * (deg - track.deg) : deg;
    }
    track.misses = 0;
  } else {
    track.misses++;
    if (track.misses > 60) track.top = null;   // mất hẳn → bỏ gợi ý vị trí
  }
  return {
    found:   !!track.top && track.misses <= HOLD_FRAMES,
    fresh:   raw.found,
    src:     track.top,
    realDeg: track.deg,
    realRad: track.deg * Math.PI / 180,
    vertices: raw.vertices,
  };
}

function frameStep() {
  if (!streaming) return;

  let delay = 35;
  try {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!opencvReady || video.readyState < 2 || !vw || !vh) {
      delay = 100;
    } else {
      const now = performance.now();
      watchVideo(now);
      if (vw !== srcW) onSourceSize(vw, vh);
      layoutView(vw, vh);
      ctx.drawImage(video, roi.x, roi.y, roi.w, roi.h, 0, 0, canvas.width, canvas.height);

      if (pendingPick) { pickColor(pendingPick); pendingPick = null; }

      const hint = track.top ? srcToCanvas(track.top[0], track.top[1]) : null;
      const sk   = skinSrc();
      const r    = trackUpdate(detector.detect(canvas, hint, sk ? srcToCanvas(sk[0], sk[1]) : null));
      lastResult = r;

      const dt = (now - lastFrameT) / 1000;
      lastFrameT = now;

      drawSkin();
      if (r.found) {
        drawNeedle(r);
        if (r.fresh && geo.cmPerPx && dt > 0 && dt < 0.5) {
          calculator.frameInterval = dt;     // thời gian thực giữa 2 khung
          calculator.update(toNorm(r.src));
        }
        document.getElementById('val-angle').textContent = Math.round(r.realDeg);
        noDetect.style.display = 'none';
      } else {
        noDetect.style.display = 'block';
      }

      updateView(r, vw, vh);
    }
  } catch (e) {
    console.error('frameStep error:', e);
  } finally {
    if (streaming) loopHandle = setTimeout(frameStep, delay);
  }
}

// ── Mũi kim dự đoán & độ sâu ──────────────────────────────────────────────────
/** Vị trí mũi kim = đỉnh cán + chiều dài kim dọc theo hướng thân kim (đã bù nghiêng). */
function tipSrc() {
  if (!geo.cmPerPx || !track.top || !track.dir) return null;
  const [dx, dy] = track.dir;
  const t = needleLenCm / (geo.cmPerPx * Math.hypot(dx, dy / cosPitch()));
  return [track.top[0] + dx * t, track.top[1] + dy * t];
}

/**
 * Độ sâu = phần thân kim nằm dưới đường mặt da, đo dọc theo kim
 * (tức đoạn đường vàng vượt qua đường đứt nét xanh).
 * Kim gần nằm ngang (<10°) thì dùng: chiều dài kim − khoảng cách đỉnh kim → điểm châm.
 */
function depthCm() {
  const s = skinSrc();
  if (!s || !geo.cmPerPx || !track.top) return null;
  const cp  = cosPitch();
  const tip = tipSrc();
  let depth;
  if (tip) {
    const rx = track.dir[0], ry = track.dir[1] / cp;
    const sinA = ry / (Math.hypot(rx, ry) || 1);
    if (sinA > 0.17) depth = (tip[1] - s[1]) / cp * geo.cmPerPx / sinA;
  }
  if (depth === undefined) {
    const d = Math.hypot(track.top[0] - s[0], (track.top[1] - s[1]) / cp) * geo.cmPerPx;
    depth = needleLenCm - d;
  }
  return clamp(Math.round(depth * 10) / 10, 0, needleLenCm);
}

// ── Tự dò tìm & căn khung ─────────────────────────────────────────────────────
function outOfView([x, y]) {
  const m = 0.04;
  return x < roi.x + roi.w * m || x > roi.x + roi.w * (1 - m) ||
         y < roi.y + roi.h * m || y > roi.y + roi.h * (1 - m);
}

function updateView(r, vw, vh) {
  if (!view.auto || isSet) return;   // đang đo → giữ nguyên khung

  if (view.mode === 'search') {      // chưa có khung: hiện toàn cảnh cho tới khi thấy kim
    if (!r.fresh) { view.hits = 0; return; }
    if (++view.hits >= 3) frameOn(r.src, vw, vh);
    return;
  }

  if (r.found) {
    view.lost = 0;
    if (r.fresh && outOfView(r.src)) frameOn(r.src, vw, vh);   // kim ra khỏi khung → căn lại
    return;
  }
  // Mất dấu lâu: dò ngầm trên toàn khung, KHÔNG đổi hình đang hiển thị.
  if (++view.lost > 60 && view.lost % 12 === 0) backgroundSearch(vw, vh);
}

function backgroundSearch(vw, vh) {
  const s = Math.min(1, SEARCH_LONG / Math.max(vw, vh));
  const w = Math.round(vw * s), h = Math.round(vh * s);
  if (offCanvas.width !== w || offCanvas.height !== h) { offCanvas.width = w; offCanvas.height = h; }
  offCtx.drawImage(video, 0, 0, w, h);
  const sk  = skinSrc();
  const raw = searchDetector.detect(offCanvas, null, sk ? [sk[0] * s, sk[1] * s] : null);
  if (!raw.found) return;
  const top = [raw.top[0] / s, raw.top[1] / s];
  if (outOfView(top)) { track.top = null; frameOn(top, vw, vh); }
}

/**
 * Đặt vùng quan sát. Khi đã có điểm mặt da (và tỉ lệ), khung được tính từ
 * điểm da + chiều dài kim nên gần như cố định, không phụ thuộc vị trí kim từng lúc.
 */
function frameOn(top, vw, vh) {
  const s = skinSrc();
  let zoom = view.zoom, cx, cy;

  if (s && s[1] - top[1] > vh * 0.03) {
    let topY = top[1];
    if (geo.cmPerPx) {
      topY = Math.min(topY, s[1] - 1.15 * needleLenCm / geo.cmPerPx * cosPitch());
    }
    topY = Math.max(0, topY);
    const spanY = s[1] - topY;
    const spanX = Math.abs(top[0] - s[0]);
    const h = Math.max(spanY / 0.8, (2 * spanX / 0.8) * vh / vw);
    zoom = clamp(vh / h, 1, ZOOM_MAX);
    cx = s[0];
    cy = (topY + s[1]) / 2;
  } else {
    cx = top[0];
    cy = top[1] + 0.3 * vh / zoom;   // đỉnh kim ở ~20% từ trên
  }
  view.zoom = zoom;
  view.cx = cx / vw; view.cy = cy / vh;
  view.mode = 'track';
  view.hits = 0; view.lost = 0;
}

btnAuto.addEventListener('click', () => setAuto(!view.auto));

zoomEl.addEventListener('input', () => {
  view.zoom = clamp(parseFloat(zoomEl.value) || 1, 1, ZOOM_MAX);
  store.set('zoom', view.zoom);
  if (view.auto) setAuto(false);     // chỉnh tay → tắt tự căn
  view.mode = 'track';
});

btnSkin.addEventListener('click', () => {
  if (!streaming) { notify('Hãy bật camera trước.'); return; }
  setTapMode(tapMode === 'skin' ? null : 'skin');
});

function eventToCanvas(e) {
  const r  = canvas.getBoundingClientRect();
  const s  = Math.min(r.width / canvas.width, r.height / canvas.height);
  const ox = (r.width  - canvas.width  * s) / 2;
  const oy = (r.height - canvas.height * s) / 2;
  return [
    clamp((e.clientX - r.left - ox) / s, 0, canvas.width  - 1),
    clamp((e.clientY - r.top  - oy) / s, 0, canvas.height - 1),
  ];
}

canvas.addEventListener('click', e => {
  if (!streaming || !video.videoWidth) return;
  const [u, v] = eventToCanvas(e);
  const [x, y] = canvasToSrc(u, v);
  const vw = video.videoWidth, vh = video.videoHeight;

  if (tapMode === 'skin') {
    geo.skin = { fx: x / vw, fy: y / vh };
    store.set('skin', geo.skin);
    setTapMode(null);
    if (view.auto && !isSet) setAuto(true);   // căn lại khung theo điểm da mới
  } else if (tapMode === 'color') {
    pendingPick = [u, v];
    setTapMode(null);
  } else if (!isSet) {
    view.cx = x / vw; view.cy = y / vh;       // chạm để dời tâm
    view.mode = 'track';
    if (view.auto) setAuto(false);
    view.mode = 'track';
  }
});

// ── Lấy màu đầu kim bằng cách chạm ────────────────────────────────────────────
function pickColor([u, v]) {
  const R  = 5;
  const x0 = clamp(Math.round(u) - R, 0, canvas.width  - 1);
  const y0 = clamp(Math.round(v) - R, 0, canvas.height - 1);
  const w  = Math.min(2 * R + 1, canvas.width  - x0);
  const h  = Math.min(2 * R + 1, canvas.height - y0);
  const d  = ctx.getImageData(x0, y0, w, h).data;

  const H = [], S = [], V = [];
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), df = mx - mn;
    let hue = 0;
    if (df > 0) {
      if (mx === r)      hue = 60 * (((g - b) / df) % 6);
      else if (mx === g) hue = 60 * ((b - r) / df + 2);
      else               hue = 60 * ((r - g) / df + 4);
      if (hue < 0) hue += 360;
    }
    H.push(hue / 2);                       // thang H của OpenCV: 0–179
    S.push(mx ? df / mx * 255 : 0);
    V.push(mx);
  }
  const med = a => a.sort((p, q) => p - q)[a.length >> 1];
  const h0 = med(H), s0 = med(S), v0 = med(V);

  const lower = [Math.round(clamp(h0 - 22, 0, 179)),
                 Math.round(clamp(s0 * 0.45, 40, 255)),
                 Math.round(clamp(v0 * 0.35, 30, 255))];
  const upper = [Math.round(clamp(h0 + 22, 0, 179)), 255, 255];
  applyHSV(lower, upper);
  if (view.auto) setAuto(true);
}

function applyHSV(lower, upper) {
  detector.setHSVRange(lower, upper);
  searchDetector.setHSVRange(lower, upper);
  store.set('hsv2', { lower, upper });
  ['lh', 'ls', 'lv'].forEach((k, i) => { document.getElementById('hsv-' + k).value = lower[i]; });
  ['uh', 'us', 'uv'].forEach((k, i) => { document.getElementById('hsv-' + k).value = upper[i]; });
}

document.getElementById('btn-pick').addEventListener('click', () => {
  if (!streaming) { notify('Hãy bật camera trước.'); return; }
  setTapMode('color');
  canvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// ── Góc nghiêng & hiệu chuẩn tỉ lệ ────────────────────────────────────────────
tiltEl.addEventListener('change', () => {
  const v = parseFloat(tiltEl.value);
  setTilt(isNaN(v) ? geo.tiltDeg : v);
});

document.getElementById('btn-tilt').addEventListener('click', async () => {
  if (typeof DeviceOrientationEvent === 'undefined') {
    notify('Thiết bị không có cảm biến nghiêng — hãy nhập góc bằng tay.');
    return;
  }
  try {
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const p = await DeviceOrientationEvent.requestPermission();
      if (p !== 'granted') { notify('Chưa được cấp quyền cảm biến chuyển động.'); return; }
    }
  } catch (_) { notify('Không xin được quyền cảm biến.'); return; }

  const onOri = e => {
    if (e.beta == null) return;
    window.removeEventListener('deviceorientation', onOri);
    clearTimeout(timer);
    const b = Math.abs(e.beta);              // máy dựng đứng = 90°, nằm ngửa = 0°
    setTilt(Math.round(b > 90 ? 180 - b : b));
  };
  const timer = setTimeout(() => {
    window.removeEventListener('deviceorientation', onOri);
    notify('Không đọc được cảm biến — hãy nhập góc bằng tay.');
  }, 2000);
  window.addEventListener('deviceorientation', onOri);
});

document.getElementById('btn-calib').addEventListener('click', () => {
  const s = skinSrc();
  if (!s) { notify('Hãy bấm MẶT DA và chạm vào điểm châm trước.'); return; }
  if (!lastResult?.found) { notify('Chưa nhận diện được kim.'); return; }
  const [mx, my] = lastResult.src;
  const d = Math.hypot(mx - s[0], (my - s[1]) / cosPitch());
  if (d < 20) { notify('Đỉnh kim quá gần điểm mặt da — kiểm tra lại vị trí.'); return; }
  setScale(needleLenCm / d);
  // Căn lại khung một lần theo tỉ lệ mới để thấy trọn kim cả khi nhấc lên.
  if (view.auto && !isSet && track.top) frameOn(track.top, video.videoWidth, video.videoHeight);
  applyMsg.style.color = '#3fb950';
  applyMsg.textContent = `✓ Đã hiệu chuẩn: ${geo.cmPerPx.toFixed(5)} cm/px.`;
});

// ── Drawing ───────────────────────────────────────────────────────────────────
function drawNeedle(r) {
  if (r.fresh && r.vertices) {
    ctx.beginPath();
    ctx.moveTo(r.vertices[0].x, r.vertices[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(r.vertices[i].x, r.vertices[i].y);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255,68,68,0.6)';
    ctx.lineWidth   = 1;
    ctx.stroke();
  }
  const [tx, ty] = srcToCanvas(track.top[0], track.top[1]);
  const tip = tipSrc();
  const end = tip || track.bottom;       // chưa hiệu chuẩn → chỉ vẽ phần cán nhìn thấy
  if (end) {
    const [ex, ey] = srcToCanvas(end[0], end[1]);
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(ex, ey);
    ctx.strokeStyle = '#ffd33d'; ctx.lineWidth = 2; ctx.stroke();
    if (tip) {                           // dấu mũi kim dự đoán
      ctx.beginPath(); ctx.arc(ex, ey, 6, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffd33d'; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.arc(ex, ey, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd33d'; ctx.fill();
      const depth = depthCm();
      if (depth !== null) {
        const label = `sâu ${depth.toFixed(1)} cm`;
        ctx.font = 'bold 15px -apple-system, Arial, sans-serif';
        const w  = ctx.measureText(label).width + 10;
        const lx = clamp(ex + 12, 2, canvas.width - w - 2);
        const ly = clamp(ey - 10, 20, canvas.height - 6);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(lx, ly - 16, w, 22);
        ctx.fillStyle = '#ffd33d';
        ctx.fillText(label, lx + 5, ly);
      }
    }
  }
  ctx.beginPath();
  ctx.arc(tx, ty, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#ff4444';
  ctx.fill();
}

/** Vẽ đường mặt da và điểm châm đã đặt. */
function drawSkin() {
  const s = skinSrc();
  if (!s) return;
  const [u, v] = srcToCanvas(s[0], s[1]);
  if (v < 0 || v > canvas.height) return;
  ctx.save();
  ctx.strokeStyle = '#3fb950';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([8, 6]);
  ctx.beginPath(); ctx.moveTo(0, v); ctx.lineTo(canvas.width, v); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(u, v, 5, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

// ── SET button ────────────────────────────────────────────────────────────────
btnSet.addEventListener('click', () => {
  if (!lastResult?.found) {
    notify('Chưa nhận diện được kim. Hãy hướng camera vào đầu kim.');
    return;
  }
  const s = skinSrc();
  if (!s || !geo.cmPerPx) {
    notify('Cần đặt MẶT DA và HIỆU CHUẨN tỉ lệ (trong Cài đặt) trước khi đo.');
    return;
  }
  // Calculator giả định mặt da nằm cách đáy khung NEEDLE_D_PX → truyền "đáy khung" tương đương.
  const skinY = toNorm(s)[1];
  calculator.setStart(toNorm(lastResult.src), lastResult.realRad, skinY + NEEDLE_D_PX);
  isSet = true;

  btnSet.textContent = 'SET ✓';
  btnSet.classList.add('active');
  setPill.style.display = 'block';
  noDetect.style.display = 'none';
});

// ── DISPLAY button ────────────────────────────────────────────────────────────
btnDisplay.addEventListener('click', () => {
  if (!lastResult?.found) {
    notify('Chưa nhận diện được kim.');
    return;
  }
  if (!isSet) {
    notify('Hãy nhấn SET VỊ TRÍ trước khi châm.');
    return;
  }

  const snap = calculator.getSnapshot(
    toNorm(lastResult.src), Math.round(lastResult.realDeg), lastResult.realRad
  );
  // Độ sâu tính trực tiếp từ đỉnh kim tới điểm châm trên da (không cộng dồn từ lúc SET).
  const depth = depthCm();
  if (depth !== null) {
    snap.lengthCm    = depth;
    snap.remainingCm = Math.round((needleLenCm - depth) * 10) / 10;
  }
  renderSnapshot(snap);

  try {
    recorder.record(snap.avgVelocity, snap.angleDeg, snap.lengthCm);
  } catch (_) {
    saveMsg.style.color = '#e3b341';
    saveMsg.textContent = '⚠ Chưa lưu MSSV — kết quả không được ghi.';
  }

  // Reset trạng thái SET
  isSet = false;
  btnSet.textContent = 'SET VỊ TRÍ';
  btnSet.classList.remove('active');
  setPill.style.display = 'none';
});

// ── SAVE (student ID) ─────────────────────────────────────────────────────────
btnSave.addEventListener('click', () => {
  const id = document.getElementById('stu-id').value.trim();
  if (!id) { saveMsg.textContent = '⚠ Hãy nhập MSSV trước.'; return; }
  recorder.createSession(id);
  calculator.reset();
  isSet = false;
  btnSet.textContent = 'SET VỊ TRÍ';
  btnSet.classList.remove('active');
  setPill.style.display = 'none';
  saveMsg.textContent = `✓ Session: ${id}`;
  clearMetrics();
});

// ── EXPORT CSV ────────────────────────────────────────────────────────────────
btnExport.addEventListener('click', () => {
  if (!recorder.studentId) {
    notify('Chưa có dữ liệu. Hãy nhập MSSV và thực hiện châm kim trước.');
    return;
  }
  if (recorder.count === 0) {
    notify('Chưa có lần đo nào được ghi. Nhấn HIỂN THỊ KQ sau mỗi lần châm.');
    return;
  }
  recorder.downloadCSV();
});

// ── UI helpers ────────────────────────────────────────────────────────────────
function renderSnapshot(snap) {
  document.getElementById('val-avg').textContent   = snap.avgVelocity;
  document.getElementById('val-len').textContent   = snap.lengthCm;
  document.getElementById('val-check').textContent = snap.remainingCm;
  document.getElementById('val-angle').textContent = snap.angleDeg;

  const [v1, v2, v3] = snap.velocityHistory;
  const [d1, d2, d3] = snap.distanceHistory;
  document.getElementById('v1').textContent = v1;
  document.getElementById('v2').textContent = v2;
  document.getElementById('v3').textContent = v3;
  document.getElementById('d1').textContent = d1;
  document.getElementById('d2').textContent = d2;
  document.getElementById('d3').textContent = d3;
}

function clearMetrics() {
  ['val-avg','val-len','val-check','val-angle',
   'v1','v2','v3','d1','d2','d3']
    .forEach(id => { document.getElementById(id).textContent = '—'; });
}

// ── Settings panel ────────────────────────────────────────────────────────────
const btnSettings    = document.getElementById('btn-settings');
const settingsPanel  = document.getElementById('settings-panel');
const btnApply       = document.getElementById('btn-apply');
const applyMsg       = document.getElementById('apply-msg');

btnSettings.addEventListener('click', () => {
  const open = settingsPanel.style.display === 'none';
  settingsPanel.style.display = open ? 'block' : 'none';
  btnSettings.classList.toggle('open', open);
});

// ── Theme toggle ──────────────────────────────────────────────────────────────
const btnTheme = document.getElementById('btn-theme');

function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    btnTheme.textContent = 'Tối';
  } else {
    document.documentElement.removeAttribute('data-theme');
    btnTheme.textContent = 'Sáng';
  }
  btnTheme.dataset.current = theme;
}

(function initTheme() {
  const saved = localStorage.getItem('acupTheme');
  const systemLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(saved || (systemLight ? 'light' : 'dark'));
})();

btnTheme.addEventListener('click', () => {
  const next = btnTheme.dataset.current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem('acupTheme', next);
  if (lcChart) {
    const tab = document.querySelector('.ctab.active');
    if (tab) renderChart(parseInt(tab.dataset.idx, 10), tab.dataset.unit);
  }
});

// ── Chart ─────────────────────────────────────────────────────────────────────
let lcChart = null;
const chartModal = document.getElementById('chart-modal');

async function loadChartJs() {
  if (window.Chart) return;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

document.getElementById('btn-chart').addEventListener('click', async () => {
  if (!recorder.studentId || recorder.count === 0) {
    notify('Chưa có dữ liệu. Nhập MSSV, thực hiện châm kim và nhấn HIỂN THỊ KQ trước.');
    return;
  }
  document.getElementById('chart-title').textContent =
    `Đường cong học tập — ${recorder.studentId}`;
  chartModal.style.display = 'flex';
  await loadChartJs();
  const tab = document.querySelector('.ctab.active');
  renderChart(parseInt(tab.dataset.idx, 10), tab.dataset.unit);
});

document.getElementById('btn-chart-close').addEventListener('click', () => {
  chartModal.style.display = 'none';
});

document.getElementById('chart-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.ctab');
  if (!tab || !window.Chart) return;
  document.querySelectorAll('.ctab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  renderChart(parseInt(tab.dataset.idx, 10), tab.dataset.unit);
});

function movingAvg(arr, w) {
  return arr.map((_, i) => {
    const s  = Math.max(0, i - Math.floor(w / 2));
    const e  = Math.min(arr.length, i + Math.ceil(w / 2));
    const sl = arr.slice(s, e);
    return sl.reduce((a, b) => a + b, 0) / sl.length;
  });
}

function renderChart(metricIdx, unit) {
  const records = recorder.getRecords();
  const n = records.length;
  if (n === 0) return;

  const yVals  = records.map(r => r[metricIdx]);
  const raw    = yVals.map((y, i) => ({ x: i + 1, y }));
  const w      = Math.min(15, Math.max(3, Math.round(n / 8)));
  const maVals = movingAvg(yVals, w);
  const maData = maVals.map((y, i) => ({ x: i + 1, y: Math.round(y * 100) / 100 }));

  const mean = Math.round(yVals.reduce((a, b) => a + b, 0) / n * 100) / 100;
  const std  = Math.round(
    Math.sqrt(yVals.reduce((a, b) => a + (b - mean) ** 2, 0) / n) * 100
  ) / 100;

  const isDark    = document.documentElement.getAttribute('data-theme') !== 'light';
  const dotColor  = isDark ? 'rgba(201,209,217,0.5)'  : 'rgba(0,0,0,0.45)';
  const lineColor = isDark ? '#58a6ff' : '#0969da';
  const dashColor = isDark ? 'rgba(88,166,255,0.45)'  : 'rgba(9,105,218,0.4)';
  const axisColor = isDark ? '#8b949e' : '#57606a';
  const gridColor = isDark ? 'rgba(48,54,61,0.9)'     : 'rgba(208,215,222,0.6)';

  const canvas = document.getElementById('lc-canvas');
  if (lcChart) { lcChart.destroy(); lcChart = null; }

  lcChart = new Chart(canvas, {
    data: {
      datasets: [
        {
          type: 'line', label: 'TB',
          data: [{ x: 1, y: mean }, { x: n, y: mean }],
          borderColor: dashColor, borderWidth: 1.5,
          borderDash: [6, 4], pointRadius: 0, fill: false, order: 4,
        },
        {
          type: 'line', label: 'Trung bình động',
          data: maData,
          borderColor: lineColor, borderWidth: 2.5,
          tension: 0.4, pointRadius: 0, fill: false, order: 3,
        },
        {
          type: 'scatter', label: 'Lần đo',
          data: raw,
          backgroundColor: dotColor,
          pointRadius: 4.5, pointHoverRadius: 6, order: 1,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 250 },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => `${ctx.parsed.y} ${unit}` } },
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Lần châm', color: axisColor, font: { size: 11 } },
          grid: { color: gridColor }, ticks: { color: axisColor, maxTicksLimit: 8 },
        },
        y: {
          title: { display: true, text: unit, color: axisColor, font: { size: 11 } },
          grid: { color: gridColor }, ticks: { color: axisColor },
        },
      },
    },
  });

  const names = ['Vận tốc', 'Góc châm', 'Chiều dài'];
  document.getElementById('chart-info').textContent =
    `${names[metricIdx]}: TB = ${mean} ${unit}   SD = ±${std} ${unit}   n = ${n} lần`;
}

btnApply.addEventListener('click', () => {
  const lh = parseInt(document.getElementById('hsv-lh').value, 10);
  const ls = parseInt(document.getElementById('hsv-ls').value, 10);
  const lv = parseInt(document.getElementById('hsv-lv').value, 10);
  const uh = parseInt(document.getElementById('hsv-uh').value, 10);
  const us = parseInt(document.getElementById('hsv-us').value, 10);
  const uv = parseInt(document.getElementById('hsv-uv').value, 10);
  const scaleTxt = scaleEl.value.trim();
  const scale    = scaleTxt === '' ? null : parseFloat(scaleTxt);

  if ([lh,ls,lv,uh,us,uv].some(isNaN) || (scale !== null && !(scale > 0))) {
    applyMsg.style.color = '#ff7b7b';
    applyMsg.textContent = '⚠ Giá trị không hợp lệ.';
    return;
  }

  applyHSV([lh, ls, lv], [uh, us, uv]);
  if (scale !== null) setScale(scale);   // cm trên 1 pixel khung hình camera gốc
  const tilt = parseFloat(tiltEl.value);
  if (!isNaN(tilt)) setTilt(tilt);
  const len = parseFloat(lenEl.value);
  if (len >= 1 && len <= 20 && len !== needleLenCm) {
    needleLenCm = len;
    store.set('needleLen', len);
    calculator.setNeedleLength(len);
  }

  applyMsg.style.color = '#3fb950';
  applyMsg.textContent = '✓ Đã áp dụng.';
  setTimeout(() => { applyMsg.textContent = ''; }, 2500);
});

// ── Khôi phục cài đặt đã lưu ──────────────────────────────────────────────────
(function restoreSettings() {
  tiltEl.value = geo.tiltDeg;
  zoomEl.value = view.zoom;
  const hsv = store.get('hsv2', null);
  if (hsv && hsv.lower && hsv.upper) applyHSV(hsv.lower, hsv.upper);
  lenEl.value = needleLenCm;
  const saved = store.get('scale2', null);
  if (saved && saved.cmPerPx > 0) scaleEl.value = saved.cmPerPx.toFixed(5);
})();
