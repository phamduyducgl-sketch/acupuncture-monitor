'use strict';

// ══════════════════════════════════════════════════════════════════════════════
//  Acupuncture Monitor — camera toàn màn hình, nhận diện kim theo hình dạng,
//  tự chốt kết quả khi kim đứng yên, ghi buổi luyện tập và xuất kết quả.
// ══════════════════════════════════════════════════════════════════════════════

const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ── Lưu cài đặt trên máy ──────────────────────────────────────────────────────
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

// Thông báo không chặn (alert() có thể làm video camera đứng hình trên iOS Safari).
const toastEl = $('toast');
let toastTimer = null;
function notify(msg) {
  toastEl.textContent = msg;
  toastEl.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 4000);
}

// ── Hằng số & trạng thái ──────────────────────────────────────────────────────
const ZOOM_MAX    = 8;
const SEARCH_LONG = 960;   // cạnh dài canvas khi quét toàn khung
const TRACK_LONG  = 640;   // cạnh dài canvas khi đã zoom vào kim
const HOLD_FRAMES = 10;    // số khung giữ kết quả cũ khi mất dấu tạm thời
const REST_MS     = 1000;  // kim đứng yên bao lâu thì chốt kết quả
const REST_RANGE  = 0.06;  // dao động độ sâu tối đa (cm) vẫn coi là đứng yên
const MIN_DEPTH   = 0.15;  // độ sâu tối thiểu (cm) để tính là một lần châm
const EMA_TAU     = 0.15;  // hằng số thời gian làm mượt số hiển thị (giây) — theo thời gian, không theo số khung
const HIST_MS     = 20000; // giữ mẫu độ sâu thô bao lâu để tính tốc độ châm

const detector       = new NeedleDetector();
const searchDetector = new NeedleDetector();   // dò ngầm toàn khung khi mất dấu
const offCanvas      = document.createElement('canvas');
const offCtx         = offCanvas.getContext('2d', { willReadFrequently: true });

const video  = $('video');
const canvas = $('canvas');
const ctx    = canvas.getContext('2d', { willReadFrequently: true });

let opencvReady = false;
let streaming   = false;
let loopHandle  = null;
let lastFrameT  = 0;
let srcW        = 0;
let focusInfo   = '';
let tapMode     = null;    // null | 'skin' | 'region'
let drag        = null;    // khung đang kéo khi khoanh vùng
let suppressClick = false;

let needleLenCm = clamp(store.get('needleLen', 5.1), 1, 20);   // đỉnh cán → mũi kim (cm)

// Mọi toạ độ đo đạc quy về pixel của khung hình camera gốc ("src") → zoom / dời khung không ảnh hưởng.
const view = {
  zoom: clamp(store.get('zoom', 2.5), 1, ZOOM_MAX),
  cx: 0.5, cy: 0.5,        // tâm vùng quan sát (tỉ lệ 0–1 của khung gốc)
  mode: 'search',          // 'search' = toàn khung, 'track' = đã zoom
  auto: true, hits: 0, lost: 0,
};
const geo = {
  tiltDeg: clamp(store.get('tilt', 60), 20, 90),  // góc nghiêng điện thoại so với mặt bàn
  rollDeg: clamp(store.get('roll', 0), -20, 20),  // nghiêng ngang trái/phải (từ cảm biến)
  fovDeg:  clamp(store.get('fov', 63), 30, 130),  // góc nhìn camera theo cạnh dài khung hình
  dist:    store.get('dist', null),               // khoảng cách camera → điểm châm (cm), từ hiệu chuẩn
  skin:   store.get('skin', null),                // điểm châm trên da {fx, fy}
  region: store.get('region', null),              // vùng tìm kim {x0, y0, x1, y1} (tỉ lệ 0–1)
};
let roi = { x: 0, y: 0, w: 1, h: 1 };
const track  = { top: null, bottom: null, dir: null, deg: 90, misses: 0, tip: null, tipAge: 99 };
const TIP_HOLD = 3;       // số khung còn tin điểm cuối kim sau lần dò được gần nhất
const tipValid = () => !!track.tip && track.tipAge <= TIP_HOLD;
const live   = { ema: null, shown: null, vel: 0, lastT: 0 };
const att    = { phase: 'ready', buf: [], hist: [] };
let poseNow  = null;       // tư thế kim của khung hiện tại (Geo.pose) hoặc null
const vwatch = { t: -1, since: 0, seen: false, tried: false, busy: false };
const opts   = { flash: store.get('optFlash', true), voice: store.get('optVoice', false) };
let session  = store.get('session', null);   // {id, start, end, records: [{n, t, depth, speed, angle}]}
const practicing = () => !!session && !session.end;

// ── DOM ───────────────────────────────────────────────────────────────────────
const stuId = $('stu-id'), cvStatus = $('cv-status'), btnCam = $('btn-cam');
const btnAuto = $('btn-auto'), btnSkin = $('btn-skin'), btnRegion = $('btn-region');
const zoomEl = $('zoom'), zoomLbl = $('zoom-lbl');
const tapHint = $('tap-hint'), noDetect = $('no-detect'), flashEl = $('flash');
const liveEl = $('live'), lastEl = $('last');
const btnPractice = $('btn-practice'), btnLast = $('btn-last');
const camSelect = $('cam-select'), camInfo = $('cam-info');
const tiltEl = $('tilt'), distEl = $('cam-dist'), fovEl = $('fov'), lenEl = $('needle-len');

// ── OpenCV ────────────────────────────────────────────────────────────────────
// @techstark/opencv-js trả về Promise — resolve để lấy module thực
function onOpenCvScriptLoaded() {
  cv.then(instance => {
    window.cv = instance;
    opencvReady = true;
    cvStatus.className = 'dot';
    cvStatus.title = 'OpenCV sẵn sàng';
  }).catch(onOpenCvError);
}
function onOpenCvError() {
  cvStatus.className = 'dot err';
  notify('Không tải được OpenCV — hãy tải lại trang.');
}

// ── Hình học ──────────────────────────────────────────────────────────────────
/** Mô hình camera lỗ kim cho khung hình hiện tại (xem geometry.js). */
function cam() {
  return Geo.camera(video.videoWidth, video.videoHeight, geo.fovDeg, geo.tiltDeg, geo.rollDeg);
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
/** Vùng khoanh quy về pixel canvas hiện tại, hoặc null nếu chưa khoanh. */
function regionCanvas() {
  if (!geo.region || !video.videoWidth) return null;
  const vw = video.videoWidth, vh = video.videoHeight;
  const a = srcToCanvas(geo.region.x0 * vw, geo.region.y0 * vh);
  const b = srcToCanvas(geo.region.x1 * vw, geo.region.y1 * vh);
  return [a[0], a[1], b[0], b[1]];
}
/**
 * Tư thế kim khung hiện tại: độ sâu (phần kim dưới mặt da, đo dọc theo kim), góc, mũi kim dự đoán.
 * Cần điểm mặt da + hiệu chuẩn; thiếu thì trả null.
 *
 * Hai cách đo:
 *  'visible' — thấy cả cây kim tới điểm đâm vào da: độ sâu = chiều dài kim − phần còn nhìn thấy.
 *              Không phụ thuộc việc đâm trúng chấm xanh.
 *  'top'     — chỉ thấy cán kim (thân kim quá mờ / bị che): suy từ đỉnh cán + chiều dài kim,
 *              giả định kim đâm tại chấm xanh.
 * Nếu việc dò thân kim dừng sớm (bị che, mất tương phản) thì 'visible' cho độ sâu lớn giả; khi hai
 * cách lệch nhau quá MODE_GAP cm thì tin cách 'top'.
 */
const MODE_GAP = 0.8;
function computePose() {
  const s = skinSrc();
  if (!s || !geo.dist || !track.top) return null;
  const c  = cam();
  const pt = track.dir ? Geo.pose(c, s, geo.dist, track.top, track.dir, needleLenCm) : null;
  const pv = tipValid() ? Geo.poseVisible(c, s, geo.dist, track.top, track.tip, needleLenCm) : null;
  if (pt) pt.mode = 'top';
  if (!pv) return pt;
  pv.mode = 'visible';
  if (pv.raw <= 0.05) return pv;                         // thấy trọn chiều dài kim → chắc chắn chưa châm
  return pt && Math.abs(pv.raw - pt.raw) > MODE_GAP ? pt : pv;
}

function setDist(cm, persist = true) {
  geo.dist = cm > 0 ? cm : null;
  distEl.value = geo.dist ? geo.dist.toFixed(1) : '';
  if (persist) store.set('dist', geo.dist);
  live.ema = null; resetAttempt();
}
function setTilt(deg) {
  geo.tiltDeg = clamp(deg, 20, 90);
  tiltEl.value = geo.tiltDeg;
  store.set('tilt', geo.tiltDeg);
}
function setRoll(deg) {
  geo.rollDeg = clamp(deg, -20, 20);
  store.set('roll', geo.rollDeg);
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
  tapHint.textContent = mode === 'skin'   ? 'Chạm vào điểm châm trên mặt da'
                      : mode === 'region' ? 'Kéo ngón tay vẽ khung quanh kim' : '';
  canvas.style.touchAction = mode === 'region' ? 'none' : 'manipulation';
  if (mode !== 'region') drag = null;
  btnRegion.textContent = geo.region ? 'BỎ VÙNG' : 'VÙNG';
  btnRegion.classList.toggle('on', mode === 'region' || !!geo.region);
}

// ── Camera ────────────────────────────────────────────────────────────────────
function openStream(deviceId) {
  const v = { width: { ideal: 1920 }, height: { ideal: 1080 } };   // độ phân giải cao để còn chi tiết khi zoom số
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
  const trk = stream.getVideoTracks()[0];
  focusInfo = 'trình duyệt không cho điều khiển — giữ máy cách kim 25–30 cm';
  try {
    const caps = trk.getCapabilities ? trk.getCapabilities() : {};
    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      await trk.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      focusInfo = 'tự động liên tục';
    }
  } catch (_) {}
  const opt = [...camSelect.options].find(o => o.textContent === trk.label);
  camSelect.value = opt && store.get('camLabel', '') ? opt.value : '';
  camInfo.dataset.label = trk.label || 'camera';
  srcW = 0;   // buộc cập nhật thông tin khi có khung hình đầu tiên
}

async function startCamera(deviceId = null) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    notify('Trình duyệt không hỗ trợ camera. Trên iOS hãy dùng Safari qua HTTPS.');
    return;
  }
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
    $('cam-placeholder').style.display = 'none';
    btnCam.classList.add('on');
    if (view.auto) setAuto(true);
    if (!loopHandle) loopHandle = setTimeout(frameStep, 35);
  } catch (err) {
    notify('Không thể mở camera: ' + err.message + '\nTrên iOS: dùng Safari và mở qua HTTPS.');
  }
}

function stopCamera() {
  streaming = false;
  if (loopHandle) { clearTimeout(loopHandle); loopHandle = null; }
  const stream = video.srcObject;
  if (stream) stream.getTracks().forEach(t => t.stop());
  video.srcObject = null;
  track.top = null;
  live.ema = null; live.shown = null;
  vwatch.t = -1; vwatch.seen = false;
  resetAttempt();
  setTapMode(null);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  $('cam-placeholder').style.display = 'block';
  btnCam.classList.remove('on');
  noDetect.style.display = 'none';
  liveEl.style.display = 'none';
}

btnCam.addEventListener('click', () => { if (streaming) stopCamera(); else startCamera(); });
$('cam-placeholder').addEventListener('click', () => startCamera());

camSelect.addEventListener('change', async () => {
  const id = camSelect.value;
  store.set('camLabel', id ? camSelect.selectedOptions[0].textContent : '');
  if (!streaming) return;
  stopCamera();
  await startCamera(id || null);
});

// Tự khôi phục khi hình camera bị đứng
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
  if (stuck > 1200 && !vwatch.tried) { vwatch.tried = true; video.play().catch(() => {}); }
  else if (stuck > 3500) recoverCamera();
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

/** Gọi khi kích thước khung hình gốc thay đổi (mở camera / đổi ống kính). */
function onSourceSize(vw, vh) {
  srcW = vw;
  camInfo.textContent = `${camInfo.dataset.label || 'camera'} · ${vw}×${vh} · lấy nét: ${focusInfo}`;
}

// ── Vòng lặp khung hình ───────────────────────────────────────────────────────
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
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
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
    if (raw.tipOk) {                             // điểm cuối nhìn thấy của cây kim (mũi kim / điểm đâm vào da)
      const tip = canvasToSrc(raw.tip[0], raw.tip[1]);
      track.tip = cont && tipValid() ? mix(track.tip, tip) : tip;
      track.tipAge = 0;
    } else {
      track.tipAge++;
    }

    const dx = bottom[0] - top[0], dy = bottom[1] - top[1];
    const n  = Math.hypot(dx, dy) || 1;
    let d = [dx / n, dy / n];                    // hướng thân kim, từ đỉnh xuống mũi
    if (cont && track.dir) {
      d = mix(track.dir, d);
      const m = Math.hypot(d[0], d[1]) || 1;
      d = [d[0] / m, d[1] / m];
    }
    track.dir = d;
    const deg = Geo.angleOnly(cam(), track.top, track.dir);
    if (deg !== null) track.deg = cont ? track.deg + a * (deg - track.deg) : deg;
    track.misses = 0;
  } else {
    track.misses++;
    track.tipAge++;
    if (track.misses > 60) track.top = null;     // mất hẳn → bỏ gợi ý vị trí
  }
  return { found: !!track.top && track.misses <= HOLD_FRAMES, fresh: raw.found };
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
      const dt  = (now - lastFrameT) / 1000;
      lastFrameT = now;
      watchVideo(now);
      if (vw !== srcW) onSourceSize(vw, vh);
      layoutView(vw, vh);
      ctx.drawImage(video, roi.x, roi.y, roi.w, roi.h, 0, 0, canvas.width, canvas.height);

      const sk = skinSrc();
      const r  = trackUpdate(detector.detect(canvas, {
        hint:   track.top ? srcToCanvas(track.top[0], track.top[1]) : null,
        skin:   sk ? srcToCanvas(sk[0], sk[1]) : null,
        region: regionCanvas(),
      }));

      drawRegion();
      drawSkin();
      poseNow = r.found ? computePose() : null;
      if (r.found) {
        drawNeedle();
        updateLive(now, dt);
        if (r.fresh) attemptStep(now);
        noDetect.style.display = 'none';
      } else {
        noDetect.textContent = geo.region ? 'Không tìm thấy kim trong vùng'
                                          : 'Không tìm thấy kim — bấm VÙNG để khoanh quanh kim';
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

// ── Số đo hiện tại (bên trái), đã làm mượt ────────────────────────────────────
/**
 * Làm mượt theo thời gian thực (không theo số khung, để máy chậm hay nhanh đều trễ như nhau),
 * chỉ đổi số khi lệch đủ ~0,1 cm và tối đa 4 lần/giây để kim rung không làm số nhảy.
 */
function updateLive(now, dt) {
  const d = poseNow ? poseNow.depth : null;
  if (d === null) {                      // chưa đặt mặt da / chưa hiệu chuẩn → chỉ hiện góc
    live.ema = null; live.shown = null;
    if (now - live.lastT >= 250) {
      live.lastT = now;
      $('live-depth').textContent = '—';
      $('live-speed').textContent = '—';
      $('live-angle').textContent = Math.round(track.deg);
      liveEl.style.display = 'block';
    }
    return;
  }
  if (live.ema === null || dt <= 0 || dt > 0.5) {
    live.ema = d; live.vel = 0;
  } else {
    const prev = live.ema;
    const k = 1 - Math.exp(-dt / EMA_TAU);
    live.ema += k * (d - live.ema);
    live.vel += k * (Math.abs(live.ema - prev) / dt - live.vel);
  }
  if (now - live.lastT < 250) return;
  live.lastT = now;
  if (live.shown === null || Math.abs(live.ema - live.shown) >= 0.07) {
    live.shown = Math.round(live.ema * 10) / 10;
  }
  $('live-depth').textContent = live.shown.toFixed(1);
  $('live-speed').textContent = (live.vel < 0.15 ? 0 : live.vel).toFixed(1);
  $('live-angle').textContent = Math.round(poseNow.angle);
  liveEl.style.display = 'block';
}

// ── Tự chốt kết quả khi kim đứng yên ──────────────────────────────────────────
function resetAttempt() { att.phase = 'ready'; att.buf = []; att.hist = []; }

/**
 * ready  → kim còn ở ngoài da.
 * moving → kim đã qua mặt da và đang di chuyển; đứng yên REST_MS thì chốt.
 * done   → đã chốt; chờ rút kim ra (độ sâu về 0) để sẵn sàng cho lần sau.
 *
 * Chuyển pha dựa trên số đã làm mượt (chống nhiễu). Giá trị CHỐT lấy trung vị các mẫu THÔ
 * trong giây đứng yên; tốc độ tính từ mẫu thô (xem Geo.strokeSpeed) vì số làm mượt đến trễ.
 */
function attemptStep(now) {
  const d = live.ema;
  if (d === null || !poseNow) return;

  att.hist.push({ t: now, d: poseNow.depth });
  while (att.hist.length > 2 && now - att.hist[0].t > HIST_MS) att.hist.shift();
  att.buf.push({ t: now, d, raw: poseNow.depth, ang: poseNow.angle });
  while (att.buf.length > 1 && now - att.buf[1].t >= REST_MS) att.buf.shift();

  if (att.phase === 'ready') {
    if (d > MIN_DEPTH) att.phase = 'moving';
    return;
  }
  if (att.phase === 'done') {
    if (d <= 0.08) att.phase = 'ready';
    return;
  }
  // moving
  if (d <= 0.05) { att.phase = 'ready'; return; }
  if (att.buf.length < 5 || now - att.buf[0].t < REST_MS) return;
  let lo = Infinity, hi = -Infinity;
  for (const s of att.buf) { if (s.d < lo) lo = s.d; if (s.d > hi) hi = s.d; }
  if (hi - lo >= REST_RANGE) return;

  const depth = Geo.median(att.buf.map(s => s.raw));
  if (depth < MIN_DEPTH) return;
  const sp = Geo.strokeSpeed(att.hist, depth);
  att.phase = 'done';
  report({
    depth: Math.round(depth * 10) / 10,
    speed: sp ? Math.round(sp.speed * 10) / 10 : null,   // null = không đo được (tay che kim lúc đâm)
    angle: Math.round(Geo.median(att.buf.map(s => s.ang))),
  });
}

const fmtSpeed = v => v == null ? '—' : v.toFixed(1);

function report(res) {
  $('val-len').textContent   = res.depth.toFixed(1);
  $('val-avg').textContent   = fmtSpeed(res.speed);
  $('val-angle').textContent = res.angle;
  lastEl.style.display = 'block';

  if (practicing()) {
    session.records.push({ n: session.records.length + 1, t: new Date().toISOString(), ...res });
    store.set('session', session);
  }
  updatePracticeUI();

  if (opts.flash) {
    flashEl.innerHTML = `<b>${res.depth.toFixed(1)} cm</b><span>${fmtSpeed(res.speed)} cm/s · ${res.angle}°</span>`;
    flashEl.style.display = 'block';
    clearTimeout(report._t);
    report._t = setTimeout(() => { flashEl.style.display = 'none'; }, 2500);
  }
  if (opts.voice) {
    beep();
    speak(`Sâu ${res.depth.toFixed(1).replace('.', ' phẩy ')} xăng ti mét, góc ${res.angle} độ`);
  }
}

// ── Âm thanh ──────────────────────────────────────────────────────────────────
let audioCtx = null;
/** Gọi trong một thao tác chạm để iOS cho phép phát âm thanh sau đó. */
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  } catch (_) {}
}
function beep() {
  try {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.2, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t); o.stop(t + 0.2);
  } catch (_) {}
}
function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'vi-VN'; u.rate = 1.05;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (_) {}
}

// ── Tự dò tìm & căn khung ─────────────────────────────────────────────────────
function outOfView([x, y]) {
  const m = 0.04;
  return x < roi.x + roi.w * m || x > roi.x + roi.w * (1 - m) ||
         y < roi.y + roi.h * m || y > roi.y + roi.h * (1 - m);
}

function updateView(r, vw, vh) {
  if (!view.auto || att.phase === 'moving') return;   // đang châm → giữ nguyên khung

  if (view.mode === 'search') {      // chưa có khung: hiện toàn cảnh cho tới khi thấy kim
    if (!r.fresh) { view.hits = 0; return; }
    if (++view.hits >= 3) frameOn(track.top, vw, vh);
    return;
  }
  if (r.found) {
    view.lost = 0;
    if (r.fresh && outOfView(track.top)) frameOn(track.top, vw, vh);
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
  const sk = skinSrc(), g = geo.region;
  const raw = searchDetector.detect(offCanvas, {
    skin:   sk ? [sk[0] * s, sk[1] * s] : null,
    region: g ? [g.x0 * w, g.y0 * h, g.x1 * w, g.y1 * h] : null,
  });
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
    const hi = geo.dist ? Geo.aboveSkinPx(cam(), s, geo.dist, 1.15 * needleLenCm) : null;
    if (hi) topY = Math.min(topY, hi[1]);
    topY = Math.max(0, topY);
    const spanY = s[1] - topY;
    const spanX = Math.abs(top[0] - s[0]);
    const h = Math.max(spanY / 0.6, (2 * spanX / 0.8) * vh / vw);   // chừa chỗ cho thanh nút trên/dưới
    zoom = clamp(vh / h, 1, ZOOM_MAX);
    cx = s[0];
    cy = (topY + s[1]) / 2;
  } else {
    cx = top[0];
    cy = top[1] + 0.2 * vh / zoom;
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

// ── Chạm / kéo trên hình ──────────────────────────────────────────────────────
/** Toạ độ chạm → pixel canvas (canvas hiển thị kiểu object-fit: cover). */
function eventToCanvas(e) {
  const r  = canvas.getBoundingClientRect();
  const s  = Math.max(r.width / canvas.width, r.height / canvas.height);
  const ox = (r.width  - canvas.width  * s) / 2;
  const oy = (r.height - canvas.height * s) / 2;
  return [
    clamp((e.clientX - r.left - ox) / s, 0, canvas.width  - 1),
    clamp((e.clientY - r.top  - oy) / s, 0, canvas.height - 1),
  ];
}

btnSkin.addEventListener('click', () => {
  if (!streaming) { notify('Hãy bật camera trước.'); return; }
  setTapMode(tapMode === 'skin' ? null : 'skin');
});

btnRegion.addEventListener('click', () => {
  if (geo.region) {                       // đang có vùng → bỏ
    geo.region = null;
    store.set('region', null);
    track.top = null;
    setTapMode(null);
    return;
  }
  if (!streaming) { notify('Hãy bật camera trước.'); return; }
  setTapMode(tapMode === 'region' ? null : 'region');
});

canvas.addEventListener('pointerdown', e => {
  if (tapMode !== 'region' || !streaming) return;
  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  const p = canvasToSrc(...eventToCanvas(e));
  drag = { a: p, b: p };
});
canvas.addEventListener('pointermove', e => {
  if (drag) drag.b = canvasToSrc(...eventToCanvas(e));
});
canvas.addEventListener('pointercancel', () => { drag = null; });
canvas.addEventListener('pointerup', () => {
  if (!drag) return;
  const { a, b } = drag;
  drag = null;
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 400);
  const vw = video.videoWidth, vh = video.videoHeight;
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  if (x1 - x0 < roi.w * 0.04 || y1 - y0 < roi.h * 0.04) {
    notify('Kéo ngón tay trên hình để vẽ khung bao quanh kim.');
    return;
  }
  geo.region = { x0: x0 / vw, y0: y0 / vh, x1: x1 / vw, y1: y1 / vh };
  store.set('region', geo.region);
  track.top = null;                       // tìm lại kim trong vùng mới
  setTapMode(null);
});

canvas.addEventListener('click', e => {
  if (!streaming || !video.videoWidth) return;
  if (suppressClick || tapMode === 'region') return;
  const [x, y] = canvasToSrc(...eventToCanvas(e));
  const vw = video.videoWidth, vh = video.videoHeight;

  if (tapMode === 'skin') {
    geo.skin = { fx: x / vw, fy: y / vh };
    store.set('skin', geo.skin);
    setTapMode(null);
    // Điểm châm mới ở khoảng cách khác → tỉ lệ cũ không còn đúng, buộc hiệu chuẩn lại.
    if (geo.dist) notify('Đã đổi điểm châm — hãy HIỆU CHUẨN lại (mũi kim chạm da tại chấm xanh).');
    setDist(null);
    if (view.auto) setAuto(true);          // căn lại khung theo điểm da mới
  } else if (att.phase !== 'moving') {
    view.cx = x / vw; view.cy = y / vh;    // chạm để dời tâm
    if (view.auto) setAuto(false);
    view.mode = 'track';
  }
});

// ── Hiệu chuẩn tỉ lệ & góc nghiêng ────────────────────────────────────────────
$('btn-calib').addEventListener('click', () => {
  if (!track.top || track.misses > HOLD_FRAMES) { notify('Chưa nhận diện được kim.'); return; }
  // Thấy được mũi kim → lấy luôn mũi kim làm điểm châm (chính xác hơn chạm tay); không thì dùng chấm xanh đã đặt.
  const auto = tipValid();
  const s = auto ? track.tip.slice() : skinSrc();
  if (!s) { notify('Chưa thấy mũi kim — hãy bấm MẶT DA và chạm vào điểm mũi kim chạm da trước.'); return; }
  if (Math.hypot(track.top[0] - s[0], track.top[1] - s[1]) < 20) {
    notify('Đỉnh kim quá gần điểm mặt da — kiểm tra lại vị trí.'); return;
  }
  const c = Geo.calibrate(cam(), s, track.top, needleLenCm);
  if (!c || !(c.dist > 3 && c.dist < 300)) { notify('Không hiệu chuẩn được — kiểm tra góc nghiêng máy và điểm mặt da.'); return; }
  if (auto) {
    geo.skin = { fx: s[0] / video.videoWidth, fy: s[1] / video.videoHeight };
    store.set('skin', geo.skin);
  }
  setDist(c.dist);
  // Căn lại khung một lần theo tỉ lệ mới để thấy trọn kim cả khi nhấc lên.
  if (view.auto) frameOn(track.top, video.videoWidth, video.videoHeight);
  notify(`Đã hiệu chuẩn với kim ${needleLenCm} cm: camera cách điểm châm ${c.dist.toFixed(1)} cm (đo thước để đối chiếu).` +
         (auto ? '' : '\nKhông thấy rõ mũi kim nên dùng chấm xanh đã đặt.') +
         (c.angle < 83 ? `\n⚠ Kim đang nghiêng ${Math.round(90 - c.angle)}° — giữ kim thẳng đứng rồi hiệu chuẩn lại.` : ''));
});

// Đo chiều dài một cây kim mới: mũi kim chạm mặt da (bất kỳ chỗ nào), app thấy cả cây kim.
$('btn-len').addEventListener('click', () => {
  const s = skinSrc();
  if (!s || !geo.dist) { notify('Hãy HIỆU CHUẨN một lần với kim đã biết chiều dài trước.'); return; }
  if (!track.top || track.misses > HOLD_FRAMES || !tipValid()) {
    notify('Chưa thấy trọn cây kim (cần thấy vòng xanh ngọc ở mũi kim). Đặt mũi kim chạm mặt da, buông tay khỏi thân kim.');
    return;
  }
  const p = Geo.poseVisible(cam(), s, geo.dist, track.top, track.tip, 0);
  if (!p || !(p.exposed >= 1 && p.exposed <= 20)) { notify('Không đo được chiều dài kim.'); return; }
  needleLenCm = Math.round(p.exposed * 10) / 10;
  store.set('needleLen', needleLenCm);
  lenEl.value = needleLenCm;
  live.ema = null; resetAttempt();
  notify(`Kim dài ${needleLenCm.toFixed(1)} cm (đo lúc mũi kim chạm da).`);
});

// Đổi góc máy / góc nhìn làm thay đổi mô hình camera → hiệu chuẩn cũ không còn khớp.
function geometryChanged() {
  if (geo.dist) notify('Đã đổi thông số camera — hãy HIỆU CHUẨN lại.');
  setDist(null);
}
tiltEl.addEventListener('change', () => {
  const v = parseFloat(tiltEl.value);
  if (isNaN(v)) { tiltEl.value = geo.tiltDeg; return; }
  setTilt(v); setRoll(0);                  // nhập tay: coi như máy cân ngang
  geometryChanged();
});
fovEl.addEventListener('change', () => {
  const v = parseFloat(fovEl.value);
  if (v >= 30 && v <= 130) { geo.fovDeg = v; store.set('fov', v); geometryChanged(); }
  fovEl.value = geo.fovDeg;
});
lenEl.addEventListener('change', () => {
  const v = parseFloat(lenEl.value);
  if (v >= 1 && v <= 20 && v !== needleLenCm) { needleLenCm = v; store.set('needleLen', v); geometryChanged(); }
  lenEl.value = needleLenCm;
});
distEl.addEventListener('change', () => {
  const v = parseFloat(distEl.value);
  if (v > 3 && v < 300) setDist(v); else distEl.value = geo.dist ? geo.dist.toFixed(1) : '';
});

$('btn-tilt').addEventListener('click', async () => {
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
    const g = e.gamma == null || Math.abs(e.gamma) > 20 ? 0 : e.gamma;   // nghiêng ngang (máy cầm dọc)
    setRoll(Math.round(g * 10) / 10);
    geometryChanged();
    notify(`Góc nghiêng máy: ${geo.tiltDeg}° · lệch ngang ${geo.rollDeg}°\nHãy HIỆU CHUẨN lại.`);
  };
  const timer = setTimeout(() => {
    window.removeEventListener('deviceorientation', onOri);
    notify('Không đọc được cảm biến — hãy nhập góc bằng tay.');
  }, 2000);
  window.addEventListener('deviceorientation', onOri);
});

$('opt-flash').addEventListener('change', e => { opts.flash = e.target.checked; store.set('optFlash', opts.flash); });
$('opt-voice').addEventListener('change', e => {
  opts.voice = e.target.checked; store.set('optVoice', opts.voice);
  if (opts.voice) { unlockAudio(); beep(); speak('Đã bật giọng nói'); }
});

// ── Vẽ lên hình ───────────────────────────────────────────────────────────────
function drawRegion() {
  let r = null, liveDrag = false;
  if (drag) {
    const a = srcToCanvas(drag.a[0], drag.a[1]), b = srcToCanvas(drag.b[0], drag.b[1]);
    r = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    liveDrag = true;
  } else {
    r = regionCanvas();
  }
  if (!r) return;
  ctx.save();
  ctx.strokeStyle = liveDrag ? '#ffd33d' : '#58a6ff';
  ctx.lineWidth = liveDrag ? 2 : 1.5;
  ctx.setLineDash([6, 5]);
  ctx.strokeRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
  ctx.restore();
}

/** Đường mặt da và điểm châm đã đặt. */
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

/** Đỉnh kim (chấm đỏ), thân kim (đường vàng) và mũi kim dự đoán (vòng tròn vàng). */
function drawNeedle() {
  const [tx, ty] = srcToCanvas(track.top[0], track.top[1]);
  const tip = poseNow ? poseNow.tipPx : null;
  const end = tip || track.bottom;       // chưa hiệu chuẩn → chỉ vẽ phần nhìn thấy
  if (end) {
    const [ex, ey] = srcToCanvas(end[0], end[1]);
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(ex, ey);
    ctx.strokeStyle = '#ffd33d'; ctx.lineWidth = 2; ctx.stroke();
    if (tip) {
      ctx.beginPath(); ctx.arc(ex, ey, 6, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffd33d'; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.arc(ex, ey, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd33d'; ctx.fill();
    }
  }
  if (tipValid()) {                        // điểm cuối nhìn thấy của kim (xanh ngọc): mũi kim / điểm đâm vào da
    const [vx, vy] = srcToCanvas(track.tip[0], track.tip[1]);
    ctx.beginPath(); ctx.arc(vx, vy, 4, 0, Math.PI * 2);
    ctx.strokeStyle = '#39d0d8'; ctx.lineWidth = 2; ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(tx, ty, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#ff4444';
  ctx.fill();
}

// ── Buổi luyện tập ────────────────────────────────────────────────────────────
function updatePracticeUI() {
  const on = practicing();
  const n  = session ? session.records.length : 0;
  btnPractice.textContent = on ? `KẾT THÚC LUYỆN TẬP · ${n} lần` : 'BẮT ĐẦU LUYỆN TẬP';
  btnPractice.classList.toggle('active', on);
  stuId.disabled = on;
  btnLast.style.display = !on && session && n > 0 ? 'block' : 'none';
  $('val-count').textContent = on ? `LẦN ${n}` : 'KẾT QUẢ';
}

btnPractice.addEventListener('click', () => {
  if (practicing()) {
    session.end = new Date().toISOString();
    store.set('session', session);
    updatePracticeUI();
    if (session.records.length) openResults();
    else notify('Buổi luyện tập kết thúc — chưa có lần châm nào được ghi.');
    return;
  }
  const id = stuId.value.trim();
  if (!id)             { notify('Hãy nhập MSSV ở góc trên trái trước.'); stuId.focus(); return; }
  if (!streaming)      { notify('Hãy bật camera trước.'); return; }
    if (!geo.skin || !geo.dist) { notify('Hãy HIỆU CHUẨN trước (kim thẳng đứng, mũi kim chạm mặt da).'); return; }
  unlockAudio();
  store.set('mssv', id);
  session = { id, start: new Date().toISOString(), end: null, records: [] };
  store.set('session', session);
  resetAttempt();
  lastEl.style.display = 'none';
  updatePracticeUI();
  notify('Bắt đầu ghi. Châm kim, buông tay 1 giây để chốt kết quả.');
});

btnLast.addEventListener('click', openResults);
stuId.addEventListener('change', () => store.set('mssv', stuId.value.trim()));

// ── Kết quả: biểu đồ, tải ảnh, CSV, chia sẻ ───────────────────────────────────
const METRICS = [
  { key: 'depth', name: 'Độ sâu',  unit: 'cm',   color: '#1a7f37' },
  { key: 'speed', name: 'Tốc độ',  unit: 'cm/s', color: '#0969da' },
  { key: 'angle', name: 'Góc kim', unit: 'độ',   color: '#bc4c00' },
];
let resBlob = null;

function stats(vals) {
  const n = vals.length;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, sd, min: Math.min(...vals), max: Math.max(...vals) };
}
const fmtTime = iso => new Date(iso).toLocaleString('vi-VN', { hour12: false });
function fileBase() {
  const d = new Date(session.start), p = v => String(v).padStart(2, '0');
  const safe = session.id.replace(/[^\w.-]+/g, '_');
  return `chamkim_${safe}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Vẽ toàn bộ kết quả (tiêu đề + 3 biểu đồ) lên một ảnh nền trắng để xem và tải về. */
function renderResults() {
  const c = $('res-canvas'), W = 1080, PH = 400, top = 190;
  c.width = W; c.height = top + METRICS.length * (PH + 40) + 20;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);

  const recs = session.records;
  g.fillStyle = '#1f2328'; g.textBaseline = 'alphabetic';
  g.font = 'bold 44px -apple-system, Arial, sans-serif';
  g.fillText('Kết quả luyện tập châm kim', 50, 70);
  g.font = '30px -apple-system, Arial, sans-serif';
  g.fillStyle = '#57606a';
  g.fillText(`MSSV: ${session.id}   ·   ${recs.length} lần châm`, 50, 118);
  g.fillText(`${fmtTime(session.start)}  →  ${fmtTime(session.end || new Date().toISOString())}`, 50, 158);

  METRICS.forEach((m, i) => {
    const y0 = top + i * (PH + 40);
    const vals  = recs.map(r => r[m.key]);
    const valid = vals.filter(v => v != null);
    const L = 110, R = W - 50, T = y0 + 70, B = y0 + PH - 40;

    g.fillStyle = '#1f2328'; g.font = 'bold 32px -apple-system, Arial, sans-serif';
    g.textAlign = 'left';
    g.fillText(`${m.name} (${m.unit})`, 50, y0 + 38);
    if (!valid.length) {
      g.fillStyle = '#57606a'; g.font = '28px -apple-system, Arial, sans-serif';
      g.fillText('Không đo được (kim bị che trong lúc đâm).', 50, y0 + 110);
      return;
    }
    const st = stats(valid);
    g.fillStyle = '#57606a'; g.font = '28px -apple-system, Arial, sans-serif';
    g.textAlign = 'right';
    g.fillText(`TB ${st.mean.toFixed(2)} ± ${st.sd.toFixed(2)}   ·   ${st.min}–${st.max}`, R, y0 + 38);
    g.textAlign = 'left';

    let lo = st.min, hi = st.max;
    if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
    if (m.key !== 'angle') lo = Math.max(0, lo);
    const X = k => recs.length === 1 ? (L + R) / 2 : L + (R - L) * k / (recs.length - 1);
    const Y = v => B - (B - T) * (v - lo) / (hi - lo);

    g.strokeStyle = '#d0d7de'; g.lineWidth = 1; g.fillStyle = '#57606a';
    g.font = '24px -apple-system, Arial, sans-serif'; g.textAlign = 'right';
    for (let k = 0; k <= 4; k++) {
      const v = lo + (hi - lo) * k / 4, y = Y(v);
      g.beginPath(); g.moveTo(L, y); g.lineTo(R, y); g.stroke();
      g.fillText(v.toFixed(m.key === 'angle' ? 0 : 1), L - 12, y + 8);
    }
    g.textAlign = 'center';
    const step = Math.max(1, Math.ceil(recs.length / 10));
    for (let k = 0; k < recs.length; k += step) g.fillText(String(k + 1), X(k), B + 32);
    g.textAlign = 'left';

    g.strokeStyle = m.color; g.globalAlpha = 0.5; g.setLineDash([10, 8]); g.lineWidth = 2;
    g.beginPath(); g.moveTo(L, Y(st.mean)); g.lineTo(R, Y(st.mean)); g.stroke();
    g.setLineDash([]); g.globalAlpha = 1;

    g.lineWidth = 3; g.beginPath();
    let pen = false;                                   // lần không đo được → ngắt đường nối
    vals.forEach((v, k) => {
      if (v == null) { pen = false; return; }
      if (pen) g.lineTo(X(k), Y(v)); else g.moveTo(X(k), Y(v));
      pen = true;
    });
    g.stroke();
    g.fillStyle = m.color;
    vals.forEach((v, k) => { if (v != null) { g.beginPath(); g.arc(X(k), Y(v), 7, 0, Math.PI * 2); g.fill(); } });
  });
}

function buildCSV() {
  const rows = [
    ['MSSV', session.id], ['Bắt đầu', fmtTime(session.start)],
    ['Kết thúc', session.end ? fmtTime(session.end) : ''], [],
    ['Lần', 'Thời điểm', 'Độ sâu (cm)', 'Tốc độ (cm/s)', 'Góc kim (độ)'],
    ...session.records.map(r => [r.n, fmtTime(r.t), r.depth, r.speed ?? '', r.angle]),
  ];
  const esc = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
  return '﻿' + rows.map(r => r.map(esc).join(',')).join('\r\n');   // BOM để Excel đọc đúng tiếng Việt
}
function summaryText() {
  const lines = [`Kết quả luyện tập châm kim — MSSV ${session.id}`,
                 `${fmtTime(session.start)} · ${session.records.length} lần châm`];
  METRICS.forEach(m => {
    const vals = session.records.map(r => r[m.key]).filter(v => v != null);
    if (!vals.length) { lines.push(`${m.name}: không đo được`); return; }
    const st = stats(vals);
    lines.push(`${m.name}: TB ${st.mean.toFixed(2)} ± ${st.sd.toFixed(2)} ${m.unit} (${st.min}–${st.max})`);
  });
  return lines.join('\n');
}

function openResults() {
  if (!session || !session.records.length) { notify('Chưa có dữ liệu luyện tập.'); return; }
  renderResults();
  resBlob = null;
  $('res-canvas').toBlob(b => { resBlob = b; }, 'image/png');   // chuẩn bị sẵn để nút Chia sẻ chạy ngay trong thao tác chạm
  $('result-modal').style.display = 'flex';
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const csvBlob = () => new Blob([buildCSV()], { type: 'text/csv;charset=utf-8' });

$('btn-png').addEventListener('click', () => {
  if (resBlob) download(resBlob, fileBase() + '.png');
  else notify('Ảnh đang được tạo, hãy bấm lại sau giây lát.');
});
$('btn-csv').addEventListener('click', () => download(csvBlob(), fileBase() + '.csv'));
$('btn-share').addEventListener('click', async () => {
  const title = `Kết quả châm kim — ${session.id}`, text = summaryText();
  const files = [new File([csvBlob()], fileBase() + '.csv', { type: 'text/csv' })];
  if (resBlob) files.unshift(new File([resBlob], fileBase() + '.png', { type: 'image/png' }));
  try {
    if (navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files, title, text });     // bảng chia sẻ của máy: Mail, Zalo, AirDrop…
    } else if (navigator.share) {
      await navigator.share({ title, text });
    } else {
      // Không có bảng chia sẻ → mở thư mới với phần tóm tắt; tệp cần tải về rồi đính kèm.
      location.href = 'mailto:?subject=' + encodeURIComponent(title) + '&body=' +
        encodeURIComponent(text + '\n\n(Tải ảnh và CSV từ ứng dụng rồi đính kèm vào thư.)');
    }
  } catch (e) {
    if (e.name !== 'AbortError') notify('Không chia sẻ được: ' + e.message);
  }
});

// ── Bảng nổi ──────────────────────────────────────────────────────────────────
$('btn-settings').addEventListener('click', () => { $('settings-modal').style.display = 'flex'; });
$('btn-help').addEventListener('click', () => { $('help-modal').style.display = 'flex'; });
document.querySelectorAll('.modal').forEach(m => {
  m.addEventListener('click', e => {
    if (e.target === m || e.target.closest('[data-close]')) m.style.display = 'none';
  });
});

// ── Khởi tạo ──────────────────────────────────────────────────────────────────
(function init() {
  stuId.value  = practicing() ? session.id : store.get('mssv', '');
  tiltEl.value = geo.tiltDeg;
  lenEl.value  = needleLenCm;
  zoomEl.value = view.zoom;
  $('opt-flash').checked = opts.flash;
  $('opt-voice').checked = opts.voice;
  fovEl.value  = geo.fovDeg;
  distEl.value = geo.dist ? geo.dist.toFixed(1) : '';
  setTapMode(null);
  updatePracticeUI();
  // Lần đầu dùng: mở hướng dẫn.
  if (!store.get('seenHelp', false)) {
    store.set('seenHelp', true);
    $('help-modal').style.display = 'flex';
  }
})();
