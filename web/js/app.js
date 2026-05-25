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
function onOpenCvError() {
  cvStatus.textContent = '❌ OpenCV';
  cvStatus.style.background = '#4a1616';
  cvStatus.style.color      = '#ff7b7b';
}

// ── Camera ────────────────────────────────────────────────────────────────────
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',   // camera sau trên điện thoại
        width:  { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    // Đồng bộ kích thước canvas theo video thực tế
    video.addEventListener('loadedmetadata', () => {
      canvas.width  = video.videoWidth  || 640;
      canvas.height = video.videoHeight || 480;
    }, { once: true });

    streaming = true;
    document.getElementById('cam-placeholder').style.display = 'none';
    btnCam.textContent = 'TẮT CAMERA';
    btnCam.classList.add('active');
    camStatus.textContent = '📷 Bật';
    camStatus.className   = 'badge badge-cam';

    startLoop();
  } catch (err) {
    alert('Không thể mở camera: ' + err.message
      + '\n\nTrên iOS: dùng Safari và mở qua HTTPS hoặc localhost.');
  }
}

function stopCamera() {
  streaming = false;
  stopLoop();
  const stream = video.srcObject;
  if (stream) stream.getTracks().forEach(t => t.stop());
  video.srcObject = null;

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

// ── Frame loop ────────────────────────────────────────────────────────────────
function startLoop() {
  if (loopHandle) return;
  loopHandle = setTimeout(frameStep, 35);
}
function stopLoop() {
  if (loopHandle) { clearTimeout(loopHandle); loopHandle = null; }
}

function frameStep() {
  if (!streaming) return;

  let delay = 35;
  try {
    if (!opencvReady || video.readyState < 2) {
      delay = 100;
    } else {
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width  = video.videoWidth  || 640;
        canvas.height = video.videoHeight || 480;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      lastResult = detector.detect(canvas);

      if (lastResult.found) {
        drawBBox(lastResult.vertices);
        drawCenter(lastResult.center);
        calculator.update(lastResult.center);
        document.getElementById('val-angle').textContent = lastResult.angle;
        noDetect.style.display = 'none';
      } else {
        noDetect.style.display = 'block';
      }
    }
  } catch (e) {
    console.error('frameStep error:', e);
  } finally {
    if (streaming) loopHandle = setTimeout(frameStep, delay);
  }
}

// ── Drawing ───────────────────────────────────────────────────────────────────
function drawBBox(vertices) {
  if (!vertices) return;
  ctx.beginPath();
  ctx.moveTo(vertices[0].x, vertices[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(vertices[i].x, vertices[i].y);
  ctx.closePath();
  ctx.strokeStyle = '#ff4444';
  ctx.lineWidth   = 2;
  ctx.stroke();
}

function drawCenter([cx, cy]) {
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#ff4444';
  ctx.fill();
}

// ── SET button ────────────────────────────────────────────────────────────────
btnSet.addEventListener('click', () => {
  if (!lastResult?.found) {
    alert('Chưa nhận diện được kim. Hãy hướng camera vào đầu kim.');
    return;
  }
  calculator.setStart(lastResult.center, lastResult.radian, canvas.height);
  isSet = true;

  btnSet.textContent = 'SET ✓';
  btnSet.classList.add('active');
  setPill.style.display = 'block';
  noDetect.style.display = 'none';
});

// ── DISPLAY button ────────────────────────────────────────────────────────────
btnDisplay.addEventListener('click', () => {
  if (!lastResult?.found) {
    alert('Chưa nhận diện được kim.');
    return;
  }
  if (!isSet) {
    alert('Hãy nhấn SET VỊ TRÍ trước khi châm.');
    return;
  }

  const snap = calculator.getSnapshot(
    lastResult.center, lastResult.angle, lastResult.radian
  );
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
    alert('Chưa có dữ liệu. Hãy nhập MSSV và thực hiện châm kim trước.');
    return;
  }
  if (recorder.count === 0) {
    alert('Chưa có lần đo nào được ghi. Nhấn HIỂN THỊ KQ sau mỗi lần châm.');
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
    alert('Chưa có dữ liệu. Nhập MSSV, thực hiện châm kim và nhấn HIỂN THỊ KQ trước.');
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
  const scale = parseFloat(document.getElementById('px-scale').value);

  if ([lh,ls,lv,uh,us,uv].some(isNaN) || isNaN(scale) || scale <= 0) {
    applyMsg.style.color = '#ff7b7b';
    applyMsg.textContent = '⚠ Giá trị không hợp lệ.';
    return;
  }

  detector.setHSVRange([lh, ls, lv], [uh, us, uv]);
  calculator.setPixelScale(scale);

  applyMsg.style.color = '#3fb950';
  applyMsg.textContent = '✓ Đã áp dụng.';
  setTimeout(() => { applyMsg.textContent = ''; }, 2500);
});
