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
const MIN_DEPTH   = 0.15;  // độ sâu tối thiểu (cm) để tính là một lần châm
const EMA_TAU     = 0.15;  // hằng số thời gian làm mượt số hiển thị (giây) — theo thời gian, không theo số khung
const HIST_MS     = 12000; // giữ lịch sử chuyển động của kim bao lâu để tính tốc độ châm
const READY_MS    = 800;   // thấy kim ổn định bao lâu (chưa cắm vào da) thì báo sẵn sàng ("ting")
const READY_DEPTH = 0.2;   // mũi kim chưa sâu quá mức này (cm) mới coi là "chưa châm"
const QUIET_MS    = 500;   // đã bỏ tay: độ sâu đứng yên bao lâu thì chốt ("tong")
const HOLD_LOCK_MS = 2000; // còn tay nhưng độ sâu đứng yên bao lâu thì cũng chốt
const STEADY_CM   = 0.12;  // dao động tối đa (cm) trong khoảng đó vẫn coi là đứng yên
const LOST_MS     = 1500;  // mất dấu kim lâu hơn thế → coi như kim đã rời khung
const CONFIRM_N   = 4;     // vị trí kim nhảy xa phải lặp lại bấy nhiêu khung liên tiếp mới được nhận
// Máy yếu: tự thu nhỏ ảnh xử lý theo các mức này (chỉ giảm, không tăng lại trong một lần mở camera).
const PROC_SCALES = [1, 0.8, 0.65, 0.5];
const SLOW_FPS    = 18;    // app xử lý dưới mức này → thử thu nhỏ ảnh xử lý
const MIN_NEEDLE_PX = 110; // nhưng cây kim trên ảnh xử lý không được ngắn hơn ngần này pixel (giữ độ chính xác độ sâu)
// Mức tương thích theo nhịp app xử lý thật (khung/giây). vmax ≈ 0,27·fps: tốc độ lớn nhất đo được cho cú châm sâu 1 cm.
const PERF_TIERS = [
  { min: 40, name: 'Rất tốt',  cls: 'ok' },
  { min: 24, name: 'Tốt',      cls: 'ok' },
  { min: 15, name: 'Đạt',      cls: 'mid' },
  { min: 10, name: 'Hạn chế',  cls: 'low' },
  { min: 0,  name: 'Không phù hợp đo tốc độ', cls: 'bad' },
];

const detector       = new NeedleDetector();
const searchDetector = new NeedleDetector();   // dò ngầm toàn khung khi mất dấu
const offCanvas      = document.createElement('canvas');
const offCtx         = offCanvas.getContext('2d', { willReadFrequently: true });

const video  = $('video');
const canvas = $('canvas');
// Canvas hiển thị để trình duyệt tự tăng tốc bằng GPU; việc đọc điểm ảnh đi qua grabFrame().
const ctx    = canvas.getContext('2d');

let opencvReady = false;
let streaming   = false;
let loopHandle  = null;
let lastFrameT  = 0;
let lastVideoT  = -1;   // thời điểm (giây) của khung hình camera đã xử lý gần nhất
let srcW        = 0;
let focusInfo   = '';
let torchInfo   = '';
let tapMode     = null;    // null | 'skin' | 'region'
let drag        = null;    // khung đang kéo khi khoanh vùng
let suppressClick = false;

let camMode = store.get('camMode', 'hd') === 'fast' ? 'fast' : 'hd';   // chế độ camera (xem openStream)
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
const track  = { top: null, bottom: null, dir: null, deg: 90, misses: 0, tip: null, tipAge: 99, pend: null };
const TIP_HOLD = 3;       // số khung còn tin điểm cuối kim sau lần dò được gần nhất
const tipValid = () => !!track.tip && track.tipAge <= TIP_HOLD;
const live   = { ema: null, shown: null, vel: 0, lastT: 0 };
const att    = { phase: 'idle', hist: [], win: [], buf: [], lastSeen: 0, outSince: 0, warnAt: 0 };
let wantLearn = false, learnRun = 0;   // ghi nhớ (khoá) cây kim ở khung tới / đếm khung kim đứng một mình
const motion = { bg: null, prev: null, key: '', lastBusy: 0, lastMove: 0, hand: false, handSince: 0 };
let poseNow  = null;       // tư thế kim của khung hiện tại (Geo.pose) hoặc null
const vwatch = { t: -1, since: 0, seen: false, tried: false, busy: false };
const opts   = { flash: store.get('optFlash', true), voice: store.get('optVoice', false), sound: store.get('optSound', true) };
let session  = store.get('session', null);   // {id, start, end, records: [{n, t, depth, speed, angle}]}
const practicing = () => !!session && !session.end;

// ── DOM ───────────────────────────────────────────────────────────────────────
const stuId = $('stu-id'), cvStatus = $('cv-status'), btnCam = $('btn-cam');
const btnAuto = $('btn-auto'), btnSkin = $('btn-skin'), btnRegion = $('btn-region');
const zoomEl = $('zoom'), zoomLbl = $('zoom-lbl');
const tapHint = $('tap-hint'), noDetect = $('no-detect'), flashEl = $('flash');
const liveEl = $('live'), lastEl = $('last'), statePill = $('state-pill'), lockEl = $('lock-pill');
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
  if (pt) { pt.mode = 'top'; pt.topRaw = pt.raw; }
  // Còn tay trong khung: điểm cuối nhìn thấy thường là mép ngón tay che thân kim chứ không phải điểm đâm
  // vào da → không dùng cách 'visible'.
  if (!pv || motion.hand) return pt;
  pv.mode = 'visible'; pv.topRaw = pt ? pt.raw : null;
  // Dò thân kim chỉ có thể sai theo hướng dừng SỚM (bị che) → phần nhìn thấy ngắn giả → độ sâu lớn giả.
  // Vì vậy 'visible' nhỏ hơn thì tin; lớn hơn 'top' quá MODE_GAP thì tin 'top'.
  return pt && pv.raw > pt.raw + MODE_GAP ? pt : pv;
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
/**
 * Hai chế độ camera (chọn trong ⚙):
 *  'hd'   — 1920×1080, thường 30 khung/s: chi tiết hơn khi zoom số.
 *  'fast' — 1280×720, 60 khung/s: đo được cú châm nhanh (≤ 0,05 s) mà ở 30 khung/s lọt giữa hai khung.
 *           Nhiều iPhone chỉ cho 60 khung/s ở 720p. Máy không hỗ trợ thì tự lùi về mức cao nhất có thể.
 */
async function openStream(deviceId) {
  const fast = camMode === 'fast';
  const base = fast ? { width: { ideal: 1280 }, height: { ideal: 720 } }
                    : { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } };
  if (deviceId) base.deviceId = { exact: deviceId };
  else          base.facingMode = { ideal: 'environment' };
  if (fast) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: { ...base, frameRate: { ideal: 60, min: 50 } }, audio: false });
    } catch (_) { /* máy không cho ≥ 50 khung/s → lấy mức cao nhất có thể */ }
    return navigator.mediaDevices.getUserMedia({ video: { ...base, frameRate: { ideal: 60 } }, audio: false });
  }
  return navigator.mediaDevices.getUserMedia({ video: base, audio: false });
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
  await applyTorch();
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
  torchCap = false; torchInfo = '';
  showTorch();
  track.top = null;
  live.ema = null; live.shown = null;
  vwatch.t = -1; vwatch.seen = false;
  resetAttempt();
  forgetNeedle();
  statePill.style.display = 'none';
  setTapMode(null);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  proc.n = 0; proc.t0 = 0; proc.fps = 0; proc.wait = 0; proc.end = 0;
  lastFrameT = 0;
  perfReset();
  resetGrab();                               // luồng camera mới có thể nhanh/chậm khác → thử lại
  $('cam-placeholder').style.display = 'block';
  btnCam.classList.remove('on');
  noDetect.style.display = 'none';
  liveEl.style.display = 'none';
}

btnCam.addEventListener('click', () => { if (streaming) stopCamera(); else startCamera(); });

// ── Đèn flash ─────────────────────────────────────────────────────────────────
// Đủ sáng giúp nhận diện kim, và khi thiếu sáng iPhone kéo dài thời gian chụp mỗi hình nên gửi ít hình hơn.
// Người dùng chọn bật/tắt bằng nút 🔦; lựa chọn được nhớ cho lần sau. Chỉ camera sau có đèn.
let torchOn  = store.get('torch', true);
let torchCap = false;                        // camera đang mở có đèn điều khiển được không
const btnTorch = $('btn-torch');
function showTorch() {
  const live = !!video.srcObject;
  btnTorch.classList.toggle('on', torchOn && (!live || torchCap));
  btnTorch.classList.toggle('off', live && !torchCap);
  btnTorch.setAttribute('aria-pressed', String(torchOn));
  btnTorch.title = live && !torchCap ? 'Máy/trình duyệt này không cho bật đèn flash'
                                     : torchOn ? 'Đèn flash: BẬT (bấm để tắt)' : 'Đèn flash: TẮT (bấm để bật)';
}
async function applyTorch() {
  const trk = video.srcObject && video.srcObject.getVideoTracks()[0];
  torchCap  = false;
  torchInfo = 'không hỗ trợ trên trình duyệt/camera này';
  try {
    const caps = trk && trk.getCapabilities ? trk.getCapabilities() : {};
    if (caps.torch) {
      torchCap = true;
      await trk.applyConstraints({ advanced: [{ torch: torchOn }] });
      torchInfo = torchOn ? 'đang bật' : 'đang tắt (người dùng chọn)';
    }
  } catch (_) { torchInfo = 'không bật được'; }
  showTorch();
}
async function toggleTorch() {
  if (video.srcObject && !torchCap) {
    notify('Máy/trình duyệt này không cho bật đèn flash.\nHãy dùng đèn bàn hoặc đèn LED chiếu vào vùng kim.');
    return;
  }
  torchOn = !torchOn;
  store.set('torch', torchOn);
  if (video.srcObject) await applyTorch();
  else { showTorch(); notify(torchOn ? 'Đèn flash sẽ bật khi mở camera.' : 'Đèn flash sẽ tắt khi mở camera.'); }
  if (diagModal.style.display === 'flex') showDiag();
}
btnTorch.addEventListener('click', toggleTorch);
$('cam-placeholder').addEventListener('click', () => startCamera());

$('cam-mode').addEventListener('change', async e => {
  camMode = e.target.value === 'fast' ? 'fast' : 'hd';
  store.set('camMode', camMode);
  // Đổi độ phân giải (và có thể cả góc nhìn của ống kính) → hiệu chuẩn cũ không còn khớp.
  geometryChanged();
  if (!streaming) return;
  stopCamera();
  await startCamera(camSelect.value || null);
});

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
  showCamInfo();
}
/**
 * Thông tin camera trong ⚙: độ phân giải, nhịp camera gửi, và nhịp app XỬ LÝ được thật
 * (số khung camera mới được xử lý mỗi giây — tốc độ châm chính xác theo nhịp này).
 */
const proc = { n: 0, t0: 0, fps: 0, ms: [0, 0, 0], wait: 0, end: 0 };

/**
 * Mức tương thích của máy. Mỗi điện thoại (iPhone đời cũ, Android các hãng…) xử lý được số khung/giây khác nhau,
 * và tốc độ châm chỉ đo được tới mức nhịp đó cho phép. Theo dõi khoảng cách thật giữa các khung đã xử lý:
 *  - dt  = trung vị khoảng cách (ms) → các ngưỡng thời gian của quy trình ting/tong tự giãn theo máy;
 *  - fps = 1000/dt → xếp mức tương thích, báo cho người dùng, ghi kèm vào từng kết quả;
 *  - máy chậm (fps < SLOW_FPS) → tự thu nhỏ ảnh xử lý từng bậc, miễn cây kim trên ảnh còn đủ dài.
 */
const perf = { dts: [], dt: 33, fps: 0, si: 0, adjAt: 0, since: 0, tier: null, warned: false };
function perfReset() { perf.dts = []; perf.dt = 33; perf.fps = 0; perf.si = 0; perf.adjAt = 0; perf.since = 0; perf.tier = null; perf.warned = false; showPerf(); }
function perfFrame(dtMs, now) {
  if (!perf.since) perf.since = now;
  if (dtMs <= 0 || dtMs > 1500) return;                     // khung đầu tiên / tab bị ẩn
  perf.dts.push(dtMs);
  if (perf.dts.length > 90) perf.dts.shift();
}
const perfScale = () => PROC_SCALES[perf.si];
/** Tốc độ lớn nhất (cm/s) đo được cho cú châm sâu A cm: quãng 10–90% phải trải qua ít nhất 3 khoảng khung (ít hơn thì kết quả thấp hơn thật, hiện “≥”). */
const vMaxAt = A => 0.8 * A / (3 * perf.dt / 1000);
function perfTick(now) {                                     // gọi mỗi giây
  if (perf.dts.length < 10) return;
  perf.dt  = Geo.median(perf.dts);
  perf.fps = Math.round(1000 / perf.dt);
  // Thu nhỏ ảnh xử lý: chỉ khi không đang châm, sau ≥3 s ở mức hiện tại.
  if (perf.fps < SLOW_FPS && perf.si < PROC_SCALES.length - 1 && now - perf.adjAt > 3000 &&
      (att.phase === 'idle' || att.phase === 'done') && grab.method) {
    const next = PROC_SCALES[perf.si + 1] / PROC_SCALES[perf.si];
    const lenPx = track.top && track.bottom
      ? Math.hypot(track.bottom[0] - track.top[0], track.bottom[1] - track.top[1]) * canvas.width / roi.w : 0;
    if (lenPx ? lenPx * next >= MIN_NEEDLE_PX : perf.si < 2) {
      perf.si++; perf.adjAt = now; perf.dts = [];            // đo lại nhịp ở mức mới
      return;
    }
  }
  showPerf();
  // Cảnh báo một lần khi đã ổn định (≥ 5 s) mà máy vẫn yếu.
  if (!perf.warned && now - perf.since > 5000 && now - perf.adjAt > 3000 && perf.fps < 15) {
    perf.warned = true;
    notify(`Máy này chỉ xử lý được ${perf.fps} khung/giây — mức “${perf.tier.name}”.\n` +
           `Độ sâu và góc vẫn đo được; tốc độ châm nhanh hơn ~${vMaxAt(1).toFixed(0)} cm/s (cú 1 cm) chỉ hiện mức tối thiểu “≥”.\n` +
           `Bấm vào nhãn màu ở trên để xem nguyên nhân và cách khắc phục.`);
  }
}
function showPerf() {
  const el = $('perf-pill'), info = $('perf-info'), short = $('perf-short');
  if (!perf.fps) {
    el.style.display = 'none'; info.textContent = '';
    short.textContent = streaming ? 'Mức tương thích: đang đo…' : 'Mức tương thích: đo khi bật camera.';
    return;
  }
  perf.tier = PERF_TIERS.find(t => perf.fps >= t.min);
  el.textContent = `${perf.fps} khung/s · ${perf.tier.name} · Cách khắc phục ›`;
  el.className = 'pill perf ' + perf.tier.cls;
  el.style.display = perf.tier.cls === 'ok' ? 'none' : 'block';   // trên màn hình đo chỉ hiện khi máy chậm
  // Cho người dùng: chỉ mức tương thích, tốc độ đo được; khi máy chậm thì chỉ tới mục CHẨN ĐOÁN.
  short.innerHTML = `<b>Mức tương thích: ${perf.tier.name}</b> — đo tốc độ chính xác tới ≈ ${vMaxAt(1).toFixed(0)} cm/s ` +
    `(cú châm sâu 1 cm); nhanh hơn hiện “≥”.` + (perf.fps < 24 ? '<br>Bấm <b>CHẨN ĐOÁN</b> để xem nguyên nhân và cách khắc phục.' : '');
  // Chi tiết kỹ thuật.
  info.innerHTML = `Mức tương thích theo nhịp xử lý thật: ≥40 Rất tốt · ≥24 Tốt · ≥15 Đạt · ≥10 Hạn chế · dưới 10 Không phù hợp đo tốc độ. ` +
    `Tốc độ tối đa đo chính xác ≈ 0,8·A / (3 khoảng khung): ${vMaxAt(0.5).toFixed(1)} cm/s (A = 0,5 cm), ` +
    `${vMaxAt(1).toFixed(1)} cm/s (A = 1 cm), ${vMaxAt(2).toFixed(1)} cm/s (A = 2 cm).`;
}
/**
 * Chẩn đoán vì sao máy đo chậm, dành cho người dùng không chuyên.
 * Mỗi khung hình gồm 2 phần thời gian:
 *  - app xử lý (đọc ảnh + nhận diện kim + phần còn lại): lớn → máy xử lý chậm;
 *  - chờ camera gửi hình mới: lớn → camera gửi ít hình, thường do THIẾU SÁNG (iPhone kéo dài thời gian chụp
 *    mỗi hình), Chế độ nguồn điện thấp, hoặc máy nóng.
 * Phần nào lớn hơn là nguyên nhân chính; các bước khắc phục xếp theo thứ tự nên thử. Bảng tự cập nhật mỗi giây.
 */
const diagModal = $('diag-modal'), diagBody = $('diag-body');
function diagHtml() {
  if (!streaming) return '<p>Bấm 📷 bật camera, hướng vào kim rồi mở lại mục này. App cần đo vài giây để chẩn đoán.</p>';
  const fps = perf.fps || proc.fps;
  if (!fps || !proc.end) return '<p class="diag-status wait">Đang đo… giữ camera chạy vài giây.</p>';
  const tier = PERF_TIERS.find(t => fps >= t.min);
  let set = {};
  try { set = video.srcObject.getVideoTracks()[0].getSettings(); } catch (_) {}
  const camFps = Math.round(set.frameRate || 30);
  const work = proc.ms[0] + proc.ms[1] + proc.ms[2];
  const wait = Math.max(0, proc.wait);
  const total = Math.max(1, work + wait);
  const bar = (label, ms, cls) =>
    `<span>${label}</span><div class="diag-bar ${cls}" style="width:${(100 * ms / total).toFixed(0)}%"></div><b>${ms.toFixed(0)} ms</b>`;

  let h = `<p class="diag-status ${tier.cls}">Hiện tại: <b>${fps} khung/giây — ${tier.name}</b><br>` +
          `Cần ít nhất 15 (Đạt), tốt nhất từ 24 trở lên.</p>`;
  if (fps >= 24) {
    return h + '<p>✓ Máy đang đo tốt, không cần chỉnh gì thêm. Giữ nguyên ánh sáng và vị trí máy như hiện tại.</p>';
  }
  h += `<h4>Mỗi hình mất bao lâu</h4><div class="diag-bars">` +
       bar('App xử lý', work, '') + bar('Chờ camera gửi hình', wait, 'wait') + `</div>`;

  const steps = [];
  const torchStep = !torchCap
    ? '<b>Chiếu sáng thêm:</b> máy/trình duyệt này không bật được đèn flash — dùng đèn bàn hoặc đèn LED chiếu vào vùng kim.'
    : torchOn
      ? '<b>Chiếu sáng thêm:</b> đèn flash đang bật; nếu vẫn chậm, thêm đèn bàn hoặc đèn LED chiếu vào vùng kim.'
      : '<b>Bật đèn flash</b> (nút 🔦 cạnh nút camera) hoặc dùng đèn bàn chiếu vào vùng kim.' +
        '<br><button class="chip on diag-act" data-act="torch">🔦 BẬT ĐÈN NGAY</button>';
  const lowPower = '<b>Tắt Chế độ nguồn điện thấp:</b> Cài đặt → Pin → tắt (biểu tượng pin màu vàng). ' +
                   'Chế độ này làm chậm cả camera lẫn bộ xử lý. Pin yếu thì cắm sạc.';
  const hot = '<b>Máy nóng?</b> Để máy nguội vài phút, tháo ốp lưng; máy nóng tự giảm tốc độ.';
  const restart = '<b>Tắt camera rồi bật lại</b> (nút 📷). Vẫn chậm thì đóng hẳn Safari rồi mở lại trang.';

  if (wait >= work) {
    h += `<h4>Nguyên nhân chính: camera gửi hình chậm</h4>` +
         `<p>App xử lý xong mỗi hình trong ${work.toFixed(0)} ms nhưng phải chờ camera tới ${wait.toFixed(0)} ms. ` +
         `Camera báo ${camFps} hình/giây nhưng thực tế gửi ít hơn nhiều. Thường gặp nhất là <b>thiếu sáng</b>: ` +
         `khi tối, iPhone tự kéo dài thời gian chụp mỗi hình.</p>`;
    steps.push(torchStep,
               '<b>Tránh ngược sáng:</b> đừng để cửa sổ hay đèn sáng ở phía sau vùng kim.',
               lowPower, hot, restart);
  } else {
    h += `<h4>Nguyên nhân chính: máy xử lý chậm</h4>` +
         `<p>Mỗi hình app cần ${work.toFixed(0)} ms để xử lý (đọc ảnh ${proc.ms[0].toFixed(0)} ms, ` +
         `nhận diện kim ${proc.ms[1].toFixed(0)} ms) — quá chậm so với mức cần (dưới 40 ms).</p>`;
    steps.push(lowPower,
               '<b>Đóng các ứng dụng khác</b> và các tab Safari khác đang mở.',
               '<b>Bấm VÙNG</b> khoanh hẹp quanh kim — app chỉ phải tìm trong vùng nhỏ.');
    if (camMode === 'hd') steps.push('<b>Đổi sang chế độ 720p</b> trong ⚙ → Camera → Chế độ (ảnh nhỏ hơn, đọc nhanh hơn). ' +
                                     'Đổi xong phải bấm HIỆU CHUẨN lại.');
    steps.push(hot, restart);
    if (!torchOn || !torchCap) steps.push(torchStep);
  }
  h += `<h4>Thử lần lượt từng bước</h4><ol>${steps.map(s => `<li>${s}</li>`).join('')}</ol>` +
       `<p class="set-note">Bảng này tự cập nhật mỗi giây: làm xong một bước, chờ vài giây xem số khung/giây có tăng không.</p>` +
       `<p class="set-note">Đã thử hết mà vẫn dưới 10 khung/giây: máy này không phù hợp để đo <b>tốc độ</b> châm ` +
       `(độ sâu và góc vẫn đo được) — nên dùng điện thoại khác.</p>`;
  return h;
}
function showDiag() {
  const h = diagHtml();
  if (diagBody.dataset.h !== h) { diagBody.innerHTML = h; diagBody.dataset.h = h; }   // không vẽ lại khi không đổi
}
function openDiag() { showDiag(); diagModal.style.display = 'flex'; }
$('perf-pill').addEventListener('click', openDiag);
$('btn-diag').addEventListener('click', () => { $('settings-modal').style.display = 'none'; openDiag(); });
diagBody.addEventListener('click', e => { if (e.target.closest('[data-act="torch"]') && !torchOn) toggleTorch(); });

const fmtMs = v => `${v.toFixed(0)} ms`;
/** Bảng chi tiết kỹ thuật (popup), cập nhật mỗi giây khi camera chạy. */
function showCamInfo() {
  const rows = [];
  let set = {};
  try { set = video.srcObject.getVideoTracks()[0].getSettings(); } catch (_) {}
  rows.push(['Ống kính', camInfo.dataset.label || '—']);
  rows.push(['Độ phân giải', video.videoWidth ? `${video.videoWidth}×${video.videoHeight} (${camMode === 'fast' ? '720p' : '1080p'})` : '—']);
  rows.push(['Camera báo', set.frameRate ? `${Math.round(set.frameRate)} khung/s` : '—']);
  rows.push(['App xử lý', proc.fps ? `${proc.fps} khung/s (trung vị khoảng cách ${perf.dt.toFixed(0)} ms)` : '—']);
  if (proc.fps) {
    const st = proc.ms;
    rows.push(['Đọc ảnh', fmtMs(st[0]) + (grab.method ? ` · cách ${grab.method.toUpperCase()} (thử: ${grab.cmp})` : ' · đang thử cách đọc')]);
    rows.push(['Nhận diện kim', fmtMs(st[1])]);
    rows.push(['Phần còn lại', fmtMs(st[2])]);
    rows.push(['Chờ khung mới', fmtMs(proc.wait)]);
  }
  rows.push(['Ảnh xử lý', `${canvas.width}×${canvas.height} px · ${Math.round(perfScale() * 100)}%` + (perf.si ? ' (đã tự thu nhỏ vì máy chậm)' : '')]);
  if (track.top && track.bottom && roi.w > 1) {
    const L = Math.hypot(track.bottom[0] - track.top[0], track.bottom[1] - track.top[1]);
    rows.push(['Kim trên ảnh', `${(L * canvas.width / roi.w).toFixed(0)} px xử lý · ${L.toFixed(0)} px gốc`]);
  }
  rows.push(['Khoá kim', detector.colorLocked ? 'theo đầu kim sơn màu' : detector.locked ? 'theo hình dạng cán' : 'chưa']);
  rows.push(['Bàn tay', motion.hand ? 'có' : 'không']);
  rows.push(['Hình học', `nghiêng ${geo.tiltDeg.toFixed(0)}° · lệch ngang ${geo.rollDeg.toFixed(0)}° · góc nhìn ${geo.fovDeg}° · ` +
                         `kim ${needleLenCm} cm · camera→điểm châm ${geo.dist ? geo.dist.toFixed(1) + ' cm' : 'chưa hiệu chuẩn'}`]);
  rows.push(['Lấy nét', focusInfo || '—']);
  rows.push(['Đèn flash', torchInfo || '—']);
  const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  $('tech-live').innerHTML = rows.map(([k, v]) => `<b>${k}</b><span>${esc(v)}</span>`).join('');
}
/**
 * Lấy khung hình camera (vùng đang xem, thu về cỡ canvas) thành mảng điểm ảnh và hiện lên canvas.
 * Hai cách, tốc độ khác nhau tuỳ máy và tuỳ luồng camera (trên iPhone đo được 23–75 ms/khung với cách cũ):
 *  'cpu' — vẽ lên canvas phụ giữ ảnh trong bộ nhớ CPU rồi đọc; trình duyệt phải chuyển cả khung hình
 *          camera sang CPU trước khi thu nhỏ.
 *  'gpu' — vẽ thẳng lên canvas hiển thị (GPU thu nhỏ), rồi chỉ đọc lại ảnh đã thu nhỏ.
 * 24 khung đầu dùng xen kẽ hai cách, sau đó giữ cách nhanh hơn (trung vị thời gian).
 */
const grab = { method: null, trials: [], cpu: null, cpuCtx: null };
function grabFrame() {
  const W = canvas.width, H = canvas.height;
  const m = grab.method || (grab.trials.length % 2 ? 'gpu' : 'cpu');
  const t = performance.now();
  let frame;
  if (m === 'cpu') {
    if (!grab.cpu) {
      grab.cpu = document.createElement('canvas');
      grab.cpuCtx = grab.cpu.getContext('2d', { willReadFrequently: true });
    }
    if (grab.cpu.width !== W || grab.cpu.height !== H) { grab.cpu.width = W; grab.cpu.height = H; }
    grab.cpuCtx.drawImage(video, roi.x, roi.y, roi.w, roi.h, 0, 0, W, H);
    frame = grab.cpuCtx.getImageData(0, 0, W, H);
    ctx.putImageData(frame, 0, 0);
  } else {
    ctx.drawImage(video, roi.x, roi.y, roi.w, roi.h, 0, 0, W, H);
    frame = ctx.getImageData(0, 0, W, H);
  }
  if (!grab.method) {
    grab.trials.push({ m, ms: performance.now() - t });
    if (grab.trials.length >= 24) {
      const med = k => Geo.median(grab.trials.slice(4).filter(x => x.m === k).map(x => x.ms));   // bỏ vài khung khởi động
      grab.method = med('gpu') < med('cpu') ? 'gpu' : 'cpu';
      grab.cmp = `cpu ${med('cpu').toFixed(0)} / gpu ${med('gpu').toFixed(0)} ms`;
      showCamInfo();
    }
  }
  return frame;
}
function resetGrab() { grab.method = null; grab.trials = []; grab.cmp = ''; }
/** Thời gian trung bình (làm mượt) của từng bước mỗi khung: đọc ảnh, nhận diện kim, phần còn lại. */
function timeStages(...ms) { ms.forEach((v, i) => { proc.ms[i] += 0.1 * (v - proc.ms[i]); }); }
function countProcessed(now) {
  if (!proc.t0) proc.t0 = now;
  proc.n++;
  if (now - proc.t0 >= 1000) {
    proc.fps = Math.round(proc.n * 1000 / (now - proc.t0));
    proc.n = 0; proc.t0 = now;
    perfTick(now);
    showCamInfo();
    if (diagModal.style.display === 'flex') showDiag();
  }
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
  const long = (view.mode === 'search' ? SEARCH_LONG : TRACK_LONG) * perfScale();
  const s    = Math.min(1, long / Math.max(vw, vh));
  const cw   = Math.round(vw * s), ch = Math.round(vh * s);
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  zoomLbl.textContent = z.toFixed(1) + '×';
  if (view.mode === 'track' && document.activeElement !== zoomEl) zoomEl.value = view.zoom;
}

/** Làm mượt kết quả thô và giữ kết quả cũ trong vài khung khi mất dấu. */
function trackUpdate(raw, onRaw) {
  if (onRaw) onRaw(raw);
  autoLearn(raw);
  if (raw.found) {
    const top    = canvasToSrc(raw.top[0], raw.top[1]);
    const bottom = canvasToSrc(raw.bottom[0], raw.bottom[1]);
    // Kim chỉ trượt dọc trục khi châm: vị trí mới nằm trên trục kim cũ thì nhận ngay dù nhảy xa
    // (châm nhanh có thể đi 1–2 cm giữa hai khung hình).
    const alongAxis = track.top && track.dir && track.misses <= HOLD_FRAMES &&
      Math.abs((top[0] - track.top[0]) * track.dir[1] - (top[1] - track.top[1]) * track.dir[0]) < roi.h * 0.03;
    const cont = track.top && track.misses <= HOLD_FRAMES &&
      (alongAxis || Math.hypot(top[0] - track.top[0], top[1] - track.top[1]) < roi.h * 0.12);
    // Đang bám một cây kim mà kết quả mới nhảy xa (thường là ngón tay): chưa nhận ngay, coi như hụt một khung
    // và chỉ đổi sang vị trí mới khi nó lặp lại CONFIRM_N khung liên tiếp.
    if (!cont && track.top && track.misses <= HOLD_FRAMES * 3) {
      const p = track.pend;
      track.pend = p && Math.hypot(top[0] - p.top[0], top[1] - p.top[1]) < roi.h * 0.06 ? { top, n: p.n + 1 } : { top, n: 1 };
      if (track.pend.n < CONFIRM_N) {
        track.misses++; track.tipAge++;
        return { found: track.misses <= HOLD_FRAMES, fresh: false };
      }
    }
    track.pend = null;
    const a   = cont ? 0.6 : 1;
    const mix = (o, n) => [o[0] + a * (n[0] - o[0]), o[1] + a * (n[1] - o[1])];
    // Đỉnh kim KHÔNG làm mượt: làm mượt kéo dãn chuyển động nhanh ra nhiều khung → tốc độ thấp giả.
    // (Số hiển thị đã được làm mượt riêng ở updateLive; kết quả chốt lấy trung vị.)
    track.top    = top;
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
      watchVideo(now);
      // Chưa có khung hình mới từ camera (xử lý nhanh hơn camera) → chờ, không xử lý lại khung cũ:
      // khung trùng tạo các bước "đứng yên" giả trong lịch sử chuyển động, làm sai tốc độ.
      if (video.currentTime === lastVideoT && video.currentTime > 0) { delay = 6; return; }
      lastVideoT = video.currentTime;
      if (proc.end) proc.wait += 0.1 * (now - proc.end - proc.wait);   // thời gian chờ có khung mới từ camera
      countProcessed(now);
      const dt  = (now - lastFrameT) / 1000;
      if (lastFrameT) perfFrame(now - lastFrameT, now);
      lastFrameT = now;
      if (vw !== srcW) onSourceSize(vw, vh);
      layoutView(vw, vh);
      const t0 = performance.now();
      // Đọc điểm ảnh MỘT lần, dùng chung cho dò tay và nhận diện kim (đọc ảnh là bước tốn kém nhất).
      const frame = grabFrame();
      const t1 = performance.now();
      motionStep(now, frame);

      const sk = skinSrc();
      const cs = canvas.width / roi.w;
      const t2 = performance.now();
      const r  = trackUpdate(detector.detect(frame, {
        hint:    track.top ? srcToCanvas(track.top[0], track.top[1]) : null,
        hintDir: track.top && track.dir ? track.dir : null,
        hintLen: track.top && track.bottom ? Math.hypot(track.bottom[0] - track.top[0], track.bottom[1] - track.top[1]) * cs : 0,
        skin:   sk ? srcToCanvas(sk[0], sk[1]) : null,
        region: regionCanvas(),
        scale:  cs,
        learn:  wantLearn,
      }), lastRaw => { if (lastRaw.learned) wantLearn = false; showLock(); });
      const t3 = performance.now();

      drawRegion();
      drawSkin();
      poseNow = r.found ? computePose() : null;
      if (r.found) {
        drawNeedle();
        updateLive(now, dt);
        noDetect.style.display = 'none';
      } else {
        noDetect.textContent = geo.region ? 'Không tìm thấy kim trong vùng'
                                          : 'Không tìm thấy kim — bấm VÙNG để khoanh quanh kim';
        noDetect.style.display = 'block';
      }
      attemptStep(now, r.found && r.fresh);
      updateView(r, vw, vh);
      proc.end = performance.now();
      timeStages(t1 - t0, t3 - t2, proc.end - t0 - (t1 - t0) - (t3 - t2));
    }
  } catch (e) {
    console.error('frameStep error:', e);
  } finally {
    if (streaming) loopHandle = setTimeout(frameStep, delay === 35 ? Math.max(4, 33 - (performance.now() - lastFrameT)) : delay);
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

// ── Khoá nhận diện vào cây kim ────────────────────────────────────────────────
/**
 * Chưa khoá thì tự ghi nhớ cây kim khi thấy nó đứng một mình rõ ràng: không có tay, thấy trọn cây kim
 * từ đỉnh cán tới điểm đâm sát đường mặt da, đường thẳng gọn, ổn định 10 khung liên tiếp.
 * HIỆU CHUẨN cũng ghi nhớ lại (wantLearn).
 */
function autoLearn(raw) {
  if (detector.locked || wantLearn) { learnRun = 0; return; }
  const sk = skinSrc();
  const good = raw.found && raw.tipOk && !motion.hand && sk && raw.quality && raw.quality.rms < 0.8;
  if (!good) { learnRun = 0; return; }
  const endSrc = canvasToSrc(raw.tip[0], raw.tip[1]);
  const nearSkin = Math.abs(endSrc[1] - sk[1]) < 0.05 * video.videoHeight;
  learnRun = nearSkin ? learnRun + 1 : 0;
  if (learnRun >= 10) { wantLearn = true; learnRun = 0; }
}
function forgetNeedle() {
  detector.forget(); wantLearn = false; learnRun = 0;
  showLock();
}
/** Hiện trạng thái khoá: theo đầu kim sơn màu (chắc nhất) hoặc theo bề rộng cán + trục kim. */
function showLock() {
  const t = detector.colorLocked ? '🔒 Khoá theo đầu kim sơn màu' : detector.locked ? '🔒 Đã khoá kim' : '';
  if (lockEl.textContent !== t) lockEl.textContent = t;
  lockEl.style.display = t ? 'block' : 'none';
}

// ── Nhận biết bàn tay trong khung hình ────────────────────────────────────────
/**
 * Tay được nhận biết là một MẢNG LỚN khác với ảnh nền (cảnh khi không có tay), không phải bằng chuyển động
 * giữa hai khung: nhiễu camera, lấy nét và phơi sáng tự động cũng làm ảnh "chuyển động" dù không có ai.
 *  - Ảnh được chia ô và lấy trung bình từng ô (khử nhiễu), chuẩn hoá theo độ sáng trung bình.
 *  - Có tay ⇔ hơn HAND_FRAC số ô lệch khỏi nền. Cây kim quá mảnh nên không bao giờ đạt mức này.
 *  - Nền bám chậm theo ánh sáng khi không có tay; nếu "có tay" mà cảnh đứng im hẳn STALE_MS thì coi là
 *    nền cũ đã sai (dời tấm da, dời máy, nền lấy lúc tay còn trong khung) và lấy lại nền.
 * motion.lastBusy = lần cuối còn thấy tay.
 */
const HAND_FRAC = 0.05, STALE_MS = 4000, HAND_MAX_MS = 20000;
function handStep(cur, now, key) {
  const m = motion, n = cur.length;
  if (!m.bg || m.key !== key || m.bg.length !== n) {       // khung nhìn đổi → lấy nền mới
    m.bg = cur.slice(); m.prev = cur; m.key = key; m.lastMove = now; m.hand = false;
    return;
  }
  let off = 0, moved = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(cur[i] - m.bg[i]) > 14) off++;
    if (Math.abs(cur[i] - m.prev[i]) > 8) moved++;
  }
  if (moved > n * 0.02) m.lastMove = now;
  m.hand = off > n * HAND_FRAC;
  if (m.hand) {
    if (!m.handSince) m.handSince = now;
    // Tay người không thể bất động hoàn toàn: cảnh đứng im hẳn STALE_MS nghĩa là không có tay, chỉ là nền cũ
    // đã sai (cảnh đổi, hoặc nền lấy lúc tay còn trong khung) → lấy lại nền.
    if (now - m.lastMove > STALE_MS || now - m.handSince > HAND_MAX_MS) { m.bg = cur.slice(); m.hand = false; }
  }
  if (m.hand) {
    m.lastBusy = now;
  } else {
    m.handSince = 0;
    for (let i = 0; i < n; i++) m.bg[i] += 0.1 * (cur[i] - m.bg[i]);
  }
  m.prev = cur;
}
/** Gọi ngay sau khi vẽ khung hình camera lên canvas, TRƯỚC khi vẽ đè các đường đánh dấu. */
function motionStep(now, frame) {
  const W = frame.width, H = frame.height, cell = Math.max(4, Math.round(W / 36));
  const gw = Math.floor(W / cell), gh = Math.floor(H / cell);
  const px = frame.data, rowLen = W * 4;
  const cur = new Float32Array(gw * gh);
  let mean = 0;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let sum = 0;
      for (let y = 0; y < cell; y += 2) {                 // lấy mẫu cách 1 điểm: đủ khử nhiễu, nhẹ hơn 4 lần
        let j = (gy * cell + y) * rowLen + gx * cell * 4;
        for (let x = 0; x < cell; x += 2, j += 8) sum += px[j] + 2 * px[j + 1] + px[j + 2];
      }
      mean += cur[gy * gw + gx] = sum;
    }
  }
  mean = mean / cur.length || 1;
  for (let i = 0; i < cur.length; i++) cur[i] *= 128 / mean;     // khử thay đổi phơi sáng toàn khung
  handStep(cur, now, [roi.x, roi.y, roi.w, gw, gh].map(Math.round).join(','));
}

// ── Một lần châm: "ting" → châm → buông tay → "tong" + kết quả ────────────────
const PHASE_TEXT = {
  idle:   'Đặt mũi kim sát da, giữ yên…',
  armed:  'SẴN SÀNG — châm kim',
  moving: 'Đang châm — buông tay để chốt',
  done:   'ĐÃ CHỐT — rút kim ra để đo lần tiếp',
};
function setPhase(p) {
  att.phase = p;
  att.win = []; att.buf = []; att.outSince = 0;
  if (p === 'armed') att.hist = [];
  statePill.textContent = PHASE_TEXT[p];
  statePill.className = 'pill' + (p === 'armed' ? ' ok' : p === 'moving' ? ' info' : '');
}
function resetAttempt() { setPhase('idle'); }

/**
 * idle   → thấy kim ổn định READY_MS và mũi kim CHƯA vào da → "ting". (Kim đang cắm sẵn, đứng một mình,
 *          không bao giờ được "ting" → không tự đo lặp lại khi không có ai châm.)
 * armed  → chờ mũi kim qua mặt da.
 * moving → đang châm. Chốt khi độ sâu đứng yên: QUIET_MS nếu đã bỏ tay, HOLD_LOCK_MS nếu tay vẫn giữ.
 *          Lúc chốt ưu tiên các mẫu lấy khi không còn tay. Kim rút ra trước khi chốt → về armed.
 * done   → giữ nguyên cho tới khi kim được rút ra (độ sâu ≈ 0 hoặc kim rời khung) → idle.
 */
function attemptStep(now, fresh) {
  if (!geo.dist || !geo.skin) { statePill.style.display = 'none'; return; }
  statePill.style.display = 'block';
  const ok   = fresh && !!poseNow;
  const hand = now - motion.lastBusy < 300;
  if (ok) att.lastSeen = now;
  const lost = now - att.lastSeen > LOST_MS;
  const d    = ok ? poseNow.raw : null;
  // Số mẫu cần có trong một khoảng thời gian, theo nhịp khung thật của máy (máy chậm 8 khung/s chỉ có
  // ~4 khung trong 0,5 s — nếu đòi cố định 5 mẫu thì sẽ không bao giờ "ting"/"tong").
  const nIn  = ms => Math.max(3, Math.min(5, Math.floor(0.6 * ms / perf.dt)));

  // Lịch sử vị trí đỉnh cán dọc theo kim, dùng để tính tốc độ châm (xem Geo.descentSpeed).
  if (ok && poseNow.topRaw != null && att.phase !== 'done') att.hist.push({ t: now, r: poseNow.topRaw });
  while (att.hist.length && now - att.hist[0].t > HIST_MS) att.hist.shift();

  if (att.phase === 'idle') {
    att.win.push({ t: now, ok, d, alone: ok && !hand && poseNow.mode === 'visible' });
    while (att.win.length > 1 && now - att.win[0].t > READY_MS) att.win.shift();
    if (now - att.win[0].t < READY_MS * 0.85) return;
    // Kim đứng một mình (không tay) thì chắc chắn đang cắm trên da: không có ai đang châm → không "ting".
    // Nếu phần nhìn thấy dài hơn chiều dài kim đã cài thì chiều dài kim cài sai (đổi loại kim chưa đo lại).
    const alone = att.win.filter(s => s.alone);
    if (alone.length >= 0.8 * att.win.length && Geo.median(alone.map(s => s.d)) < -0.3 && now - att.warnAt > 8000) {
      att.warnAt = now;
      notify(`Kim nhìn thấy dài hơn chiều dài đã cài (${needleLenCm} cm).\nVào ⚙ bấm ĐO cạnh ô Kim dài để đo lại.`);
    }
    const good = att.win.filter(s => s.ok && !s.alone);
    if (good.length < nIn(READY_MS) || good.length < 0.6 * att.win.length) return;
    if (Geo.median(good.map(s => s.d)) > READY_DEPTH) return;    // kim đang cắm sẵn trong da
    setPhase('armed');
    chime('ting');
    return;
  }

  if (att.phase === 'done') {
    if (lost) { setPhase('idle'); return; }
    if (ok && d <= 0.08) {
      if (!att.outSince) att.outSince = now;
      if (now - att.outSince > 300) setPhase('idle');
    } else if (ok) att.outSince = 0;
    return;
  }

  if (lost) { setPhase('idle'); return; }
  if (!ok) return;
  att.buf.push({ t: now, d, ang: poseNow.angle, hand, vis: poseNow.mode === 'visible' });
  while (att.buf.length > 1 && now - att.buf[0].t > HOLD_LOCK_MS + 200) att.buf.shift();

  if (att.phase === 'armed') {
    if (d > MIN_DEPTH) setPhase('moving');
    return;
  }

  // moving
  if (d <= 0.05) { setPhase('armed'); return; }
  const need = Math.max(hand ? HOLD_LOCK_MS : QUIET_MS, 3.5 * perf.dt);   // máy chậm: đủ ≥ 3 khung
  const win  = att.buf.filter(s => now - s.t <= need);
  if (now - att.buf[0].t < need * 0.9 || win.length < nIn(need)) return;
  let lo = Infinity, hi = -Infinity;
  for (const s of win) { if (s.d < lo) lo = s.d; if (s.d > hi) hi = s.d; }
  if (hi - lo > STEADY_CM) return;

  const free = win.filter(s => !s.hand), vis = free.filter(s => s.vis);
  const use  = vis.length >= 3 ? vis : free.length >= 3 ? free : win;
  const raw  = Geo.median(use.map(s => s.d));
  if (raw < MIN_DEPTH) return;
  const depth = Math.min(needleLenCm, raw);
  const sp = Geo.riseSpeed(att.hist, depth, Math.max(400, 4 * perf.dt));
  setPhase('done');
  chime('tong');
  report({
    depth: Math.round(depth * 10) / 10,
    speed: sp ? Math.round(sp.speed * 10) / 10 : null,   // null = không bám được chuyển động của kim lúc đâm
    sf:    sp && sp.floor ? 1 : 0,                       // 1 = châm nhanh hơn khả năng đo (giá trị là mức tối thiểu)
    angle: Math.round(Geo.median(use.map(s => s.ang))),
    fps:   perf.fps || null,                             // nhịp xử lý của máy lúc đo (để so kết quả giữa các máy)
  });
}

const fmtSpeed = (v, floor) => v == null ? '—' : (floor ? '≥' : '') + v.toFixed(1);

function report(res) {
  $('val-len').textContent   = res.depth.toFixed(1);
  $('val-avg').textContent   = fmtSpeed(res.speed, res.sf);
  $('val-angle').textContent = res.angle;
  lastEl.style.display = 'block';

  if (practicing()) {
    session.records.push({ n: session.records.length + 1, t: new Date().toISOString(), ...res });
    store.set('session', session);
  }
  updatePracticeUI();

  if (opts.flash) {
    flashEl.innerHTML = `<b>${res.depth.toFixed(1)} cm</b><span>${fmtSpeed(res.speed, res.sf)} cm/s · ${res.angle}°</span>`;
    flashEl.style.display = 'block';
    clearTimeout(report._t);
    report._t = setTimeout(() => { flashEl.style.display = 'none'; }, 2500);
  }
  if (opts.voice) {
    speak(`Sâu ${res.depth.toFixed(1).replace('.', ' phẩy ')} xăng ti mét, góc ${res.angle} độ`);
  }
}

// ── Âm thanh ──────────────────────────────────────────────────────────────────
let audioCtx = null, audioPrimed = false;

/** Tạo tệp WAV ngắn (sóng sin tắt dần; freq = 0 → im lặng) để phát bằng thẻ <audio>. */
function wavUrl(freq, dur, vol = 0.7) {
  const sr = 22050, n = Math.floor(sr * dur), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 80) * Math.exp(-5 * i / n);
    v.setInt16(44 + i * 2, freq ? Math.sin(2 * Math.PI * freq * i / sr) * env * vol * 32767 : 0, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
const sfx = { ting: new Audio(wavUrl(1568, 0.25)), tong: new Audio(wavUrl(523, 0.55)), keep: new Audio(wavUrl(0, 1)) };
sfx.keep.loop = true;
for (const a of Object.values(sfx)) { a.preload = 'auto'; a.setAttribute('playsinline', ''); }

/**
 * iOS chỉ cho phát âm thanh sau một thao tác chạm, và Web Audio bị tắt tiếng khi gạt nút im lặng.
 * Gọi hàm này trong mọi thao tác chạm cho tới khi mở khoá xong:
 *  - đặt phiên âm thanh kiểu "playback" (iOS 16.4+) để không bị nút im lặng tắt tiếng;
 *  - phát một tệp im lặng lặp liên tục bằng thẻ <audio> (cách cũ cho iOS cũ hơn);
 *  - "mồi" hai thẻ <audio> ting/tong để sau đó phát được ngoài thao tác chạm.
 */
function unlockAudio() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) {}
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state !== 'running') audioCtx.resume();
    const src = audioCtx.createBufferSource();
    src.buffer = audioCtx.createBuffer(1, 1, 22050);
    src.connect(audioCtx.destination); src.start(0);
  } catch (_) {}
  if (!audioPrimed) {
    audioPrimed = true;
    sfx.keep.play().catch(() => { audioPrimed = false; });
    for (const k of ['ting', 'tong']) {
      const a = sfx[k];
      a.muted = true;
      a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; audioPrimed = false; });
    }
    try {
      if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); }
    } catch (_) {}
  }
}
for (const ev of ['touchend', 'click', 'keydown']) document.addEventListener(ev, unlockAudio, { passive: true });

/** "ting" (cao, ngắn) = sẵn sàng đo; "tong" (trầm, ngân) = đã chốt kết quả. */
function chime(kind, force = false) {
  if (!opts.sound && !force) return;
  try {
    if (audioCtx && audioCtx.state === 'running') {
      const [freq, dur] = kind === 'ting' ? [1568, 0.25] : [523, 0.55];
      const t = audioCtx.currentTime;
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.7, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + dur + 0.05);
      return;
    }
  } catch (_) {}
  try { const a = sfx[kind]; a.currentTime = 0; a.play().catch(() => {}); } catch (_) {}   // dự phòng bằng thẻ <audio>
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
  if (!view.auto || att.phase === 'armed' || att.phase === 'moving') return;   // đang châm → giữ nguyên khung

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
  const s = Math.min(1, SEARCH_LONG * perfScale() / Math.max(vw, vh));
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
  } else if (att.phase !== 'armed' && att.phase !== 'moving') {
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
  detector.forget(); wantLearn = true;          // ghi nhớ (khoá) đúng cây kim đang dùng để hiệu chuẩn
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

$('opt-sound').addEventListener('change', e => {
  opts.sound = e.target.checked; store.set('optSound', opts.sound);
  if (opts.sound) testSound();
});
function testSound() { unlockAudio(); chime('ting', true); setTimeout(() => chime('tong', true), 500); }
$('btn-sound').addEventListener('click', testSound);
$('opt-flash').addEventListener('change', e => { opts.flash = e.target.checked; store.set('optFlash', opts.flash); });
$('opt-voice').addEventListener('change', e => {
  opts.voice = e.target.checked; store.set('optVoice', opts.voice);
  if (opts.voice) { unlockAudio(); speak('Đã bật giọng nói'); }
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
  // Khung vùng tìm kim chỉ hiện khi đang khoanh vùng; lúc đo màn hình chỉ có mức da và chấm đỏ.
  if (!r || (!liveDrag && tapMode !== 'region')) return;
  ctx.save();
  ctx.strokeStyle = liveDrag ? '#ffd33d' : '#58a6ff';
  ctx.lineWidth = liveDrag ? 2 : 1.5;
  ctx.setLineDash([6, 5]);
  ctx.strokeRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
  ctx.restore();
}

/** Đường mức da. */
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
  ctx.restore();
}

/** Chỉ vẽ đỉnh kim (chấm đỏ) — thân kim và mũi kim không vẽ để màn hình gọn. */
function drawNeedle() {
  const [tx, ty] = srcToCanvas(track.top[0], track.top[1]);
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
  notify('Bắt đầu ghi. Đưa kim vào, nghe “ting” rồi châm; buông tay ra khỏi khung hình, nghe “tong” là đã chốt.');
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

    // Đường cong xu hướng: trung bình có trọng số Gauss quanh từng vị trí (hồi quy hạt nhân), không nối
    // thẳng từng điểm. Độ rộng hạt nhân tăng theo số lần châm để đường cong mượt mà vẫn theo kịp xu hướng.
    const pts = vals.map((v, k) => v == null ? null : [k, v]).filter(Boolean);
    if (pts.length >= 3) {
      const bw = Math.max(0.9, (recs.length - 1) / 7);
      const trend = x => {
        let sw = 0, sv = 0;
        for (const [k, v] of pts) { const w = Math.exp(-0.5 * ((x - k) / bw) ** 2); sw += w; sv += w * v; }
        return sv / sw;
      };
      const x0 = pts[0][0], x1 = pts[pts.length - 1][0], steps = Math.max(40, (x1 - x0) * 12);
      g.strokeStyle = m.color; g.lineWidth = 5; g.lineJoin = 'round'; g.lineCap = 'round';
      g.beginPath();
      for (let i = 0; i <= steps; i++) {
        const x = x0 + (x1 - x0) * i / steps, y = Y(Math.max(lo, Math.min(hi, trend(x))));
        if (i) g.lineTo(X(x), y); else g.moveTo(X(x), y);
      }
      g.stroke();
    } else if (pts.length === 2) {
      g.strokeStyle = m.color; g.lineWidth = 3; g.globalAlpha = 0.6;
      g.beginPath(); g.moveTo(X(pts[0][0]), Y(pts[0][1])); g.lineTo(X(pts[1][0]), Y(pts[1][1])); g.stroke();
      g.globalAlpha = 1;
    }
    // Từng lần châm: chấm tròn nhạt, viền trắng để nổi trên đường xu hướng.
    vals.forEach((v, k) => {
      if (v == null) return;
      g.beginPath(); g.arc(X(k), Y(v), 7, 0, Math.PI * 2);
      g.globalAlpha = 0.55; g.fillStyle = m.color; g.fill();
      g.globalAlpha = 1; g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
    });
  });
}

function buildCSV() {
  const rows = [
    ['MSSV', session.id], ['Bắt đầu', fmtTime(session.start)],
    ['Kết thúc', session.end ? fmtTime(session.end) : ''], [],
    ['Lần', 'Thời điểm', 'Độ sâu (cm)', 'Tốc độ (cm/s)', 'Góc kim (độ)', 'Khung/s', 'Ghi chú'],
    ...session.records.map(r => [r.n, fmtTime(r.t), r.depth, r.speed ?? '', r.angle, r.fps ?? '',
                                 r.sf ? 'Tốc độ là mức tối thiểu (châm nhanh hơn khả năng đo)' : '']),
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
$('btn-tech').addEventListener('click', () => { showCamInfo(); showPerf(); $('tech-modal').style.display = 'flex'; });
document.querySelectorAll('.modal').forEach(m => {
  m.addEventListener('click', e => {
    if (e.target === m || e.target.closest('[data-close]')) m.style.display = 'none';
  });
});

// ── Khởi tạo ──────────────────────────────────────────────────────────────────
(function init() {
  showTorch();
  stuId.value  = practicing() ? session.id : store.get('mssv', '');
  tiltEl.value = geo.tiltDeg;
  $('cam-mode').value = camMode;
  lenEl.value  = needleLenCm;
  zoomEl.value = view.zoom;
  $('opt-flash').checked = opts.flash;
  $('opt-voice').checked = opts.voice;
  $('opt-sound').checked = opts.sound;
  fovEl.value  = geo.fovDeg;
  distEl.value = geo.dist ? geo.dist.toFixed(1) : '';
  setTapMode(null);
  setPhase('idle');
  updatePracticeUI();
  // Lần đầu dùng: mở hướng dẫn.
  if (!store.get('seenHelp', false)) {
    store.set('seenHelp', true);
    $('help-modal').style.display = 'flex';
  }
})();
