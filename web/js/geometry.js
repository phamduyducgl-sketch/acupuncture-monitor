'use strict';

/**
 * Hình học đo kim bằng mô hình camera lỗ kim (phối cảnh thật), không có DOM.
 *
 * Hệ toạ độ camera: x sang phải, y xuống dưới ảnh, z theo trục quang học (ra phía trước).
 * Điểm ảnh p (pixel khung gốc) ứng với tia r = ((px−cx)/f, (py−cy)/f, 1).
 *
 * Một camera không đo được chiều sâu, nên phải có 2 giả định (ghi rõ để biết giới hạn):
 *   (1) Kim nằm trong "mặt phẳng chính diện" Π: mặt phẳng thẳng đứng đi qua điểm châm S và
 *       vuông góc với hướng nhìn ngang của camera. Tức là kim không ngả về phía camera / ra xa
 *       camera, và đâm vào da ở cùng khoảng cách trước–sau với điểm châm đã đặt.
 *   (2) Khoảng cách camera → điểm châm lấy từ HIỆU CHUẨN (mũi kim chạm da tại S, biết chiều dài kim).
 * Kim nghiêng trái/phải và điểm đâm lệch trái/phải được xử lý đúng.
 */
const Geo = (() => {
  const RAD = Math.PI / 180;
  const dot   = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const add   = (a, b, k = 1) => [a[0] + k * b[0], a[1] + k * b[1], a[2] + k * b[2]];
  const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const norm  = a => Math.hypot(a[0], a[1], a[2]);
  const unit  = a => scale(a, 1 / (norm(a) || 1));

  /**
   * @param {number} vw, vh    kích thước khung hình gốc (pixel)
   * @param {number} fovDeg    góc nhìn theo CẠNH DÀI của khung hình (độ)
   * @param {number} tiltDeg   góc nghiêng máy so với mặt bàn (90 = dựng đứng, máy ngả ra sau thì nhỏ hơn)
   * @param {number} rollDeg   nghiêng ngang trái/phải (0 = cân)
   */
  function camera(vw, vh, fovDeg, tiltDeg, rollDeg = 0) {
    const f = Math.max(vw, vh) / 2 / Math.tan(fovDeg * RAD / 2);
    const b = tiltDeg * RAD, g = rollDeg * RAD;
    // Hướng "lên trên" của thế giới trong hệ camera (từ DeviceOrientation: beta = tilt, gamma = roll).
    const up  = unit([-Math.cos(b) * Math.sin(g), -Math.sin(b), -Math.cos(b) * Math.cos(g)]);
    // Hướng nhìn ngang: trục quang học chiếu lên mặt phẳng nằm ngang.
    const fwd = unit(add([0, 0, 1], up, -up[2]));
    return { f, cx: vw / 2, cy: vh / 2, up, fwd };
  }
  const ray     = (cam, p) => [(p[0] - cam.cx) / cam.f, (p[1] - cam.cy) / cam.f, 1];
  const project = (cam, X) => [cam.cx + cam.f * X[0] / X[2], cam.cy + cam.f * X[1] / X[2]];

  /** Giao của tia qua điểm ảnh p với mặt phẳng chính diện có fwd·X = k. */
  function onFrontal(cam, p, k) {
    const r = ray(cam, p), den = dot(r, cam.fwd);
    return den > 0.05 ? scale(r, k / den) : null;
  }

  /**
   * Hiệu chuẩn: mũi kim chạm da tại điểm châm (ảnh skinPx), đỉnh cán ở topPx, kim dài lenCm.
   * @returns {{dist:number, angle:number}|null}  dist = khoảng cách camera → điểm châm (cm),
   *          angle = góc kim so với mặt da lúc hiệu chuẩn (để cảnh báo nếu kim chưa thẳng đứng).
   */
  function calibrate(cam, skinPx, topPx, lenCm) {
    const rs = ray(cam, skinPx), rt = ray(cam, topPx);
    const ds = dot(rs, cam.fwd), dt = dot(rt, cam.fwd);
    if (ds < 0.05 || dt < 0.05) return null;
    const v = add(scale(rt, ds / dt), rs, -1);      // (T − S) / zs
    const m = norm(v);
    if (m < 1e-4) return null;
    const zs = lenCm / m;
    const angle = Math.asin(Math.min(1, Math.abs(dot(v, cam.up)) / m)) / RAD;
    return { dist: zs * norm(rs), angle };
  }

  /** Hướng kim 3D (đơn vị, từ đỉnh xuống mũi) từ đỉnh và hướng trên ảnh; k = fwd·S của mặt phẳng Π. */
  function direction(cam, topPx, dirPx, k) {
    const T  = onFrontal(cam, topPx, k);
    const T2 = onFrontal(cam, [topPx[0] + dirPx[0] * 80, topPx[1] + dirPx[1] * 80], k);
    if (!T || !T2) return null;
    let d = unit(add(T2, T, -1));
    if (dot(d, cam.up) > 0) d = scale(d, -1);
    return { T, d };
  }

  /** Góc kim so với mặt da (độ) chỉ từ ảnh; không cần hiệu chuẩn vì góc không phụ thuộc tỉ lệ. */
  function angleOnly(cam, topPx, dirPx) {
    const o = direction(cam, topPx, dirPx, 1);
    return o ? Math.asin(Math.min(1, -dot(o.d, cam.up))) / RAD : null;
  }

  /**
   * Tư thế kim và độ sâu.
   * @param {number} dist  khoảng cách camera → điểm châm (cm) từ hiệu chuẩn
   * @returns {{depth, raw, angle, exposed, tipPx}|null}
   *   raw   = chiều dài kim − phần kim còn ở trên mặt da, đo dọc theo kim (âm = mũi kim còn trên không)
   *   depth = raw chặn trong [0, chiều dài kim]
   */
  function pose(cam, skinPx, dist, topPx, dirPx, lenCm) {
    const rs = ray(cam, skinPx);
    const S  = scale(rs, dist / norm(rs));
    const o  = direction(cam, topPx, dirPx, dot(S, cam.fwd));
    if (!o) return null;
    const { T, d } = o;
    const sinA    = Math.min(1, -dot(d, cam.up));
    const rel     = add(T, S, -1);
    // Kim gần nằm ngang (<10°): chia cho sinA sẽ khuếch đại nhiễu → dùng khoảng cách đỉnh kim → điểm châm.
    const exposed = sinA > 0.17 ? dot(rel, cam.up) / sinA : norm(rel);
    const raw     = lenCm - exposed;
    const tip     = add(T, d, lenCm);
    return {
      raw,
      depth: Math.min(lenCm, Math.max(0, raw)),
      angle: Math.asin(sinA) / RAD,
      exposed,
      tipPx: tip[2] > 1e-6 ? project(cam, tip) : null,
    };
  }

  /**
   * Tư thế kim khi THẤY CẢ CÂY KIM: đỉnh cán topPx và điểm cuối nhìn thấy endPx.
   * Điểm cuối được coi là nằm trên mặt da (mặt phẳng nằm ngang qua điểm châm đã hiệu chuẩn), nên
   * lấy được vị trí 3D của đúng điểm kim đâm vào — không cần kim đâm trúng chấm xanh.
   * Độ sâu = chiều dài kim − phần kim còn nhìn thấy.
   * Khi kim còn lơ lửng trên không, điểm cuối bị coi là xa hơn thực tế nên phần nhìn thấy tính ra
   * dài hơn kim → raw âm → độ sâu 0 (đúng ý nghĩa: chưa châm).
   * lenCm = 0 để chỉ đo phần nhìn thấy (dùng khi đo chiều dài kim: mũi kim chạm mặt da).
   */
  function poseVisible(cam, skinPx, dist, topPx, endPx, lenCm) {
    const rs = ray(cam, skinPx);
    const S  = scale(rs, dist / norm(rs));
    const re = ray(cam, endPx), den = dot(re, cam.up);
    if (den > -0.03) return null;                       // tia gần song song mặt da → không xác định
    const E = scale(re, dot(S, cam.up) / den);
    const T = onFrontal(cam, topPx, dot(E, cam.fwd));
    if (!T) return null;
    const rel = add(T, E, -1), exposed = norm(rel);
    if (exposed < 1e-6) return null;
    const d    = scale(rel, -1 / exposed);
    const sinA = Math.min(1, -dot(d, cam.up));
    if (sinA <= 0) return null;
    const raw = lenCm - exposed;
    const tip = add(T, d, lenCm || exposed);
    return {
      raw,
      depth: Math.min(lenCm, Math.max(0, raw)),
      angle: Math.asin(sinA) / RAD,
      exposed,
      tipPx: tip[2] > 1e-6 ? project(cam, tip) : null,
    };
  }

  /** Ảnh của điểm nằm cao hơn điểm châm một đoạn hCm theo phương thẳng đứng (dùng để căn khung). */
  function aboveSkinPx(cam, skinPx, dist, hCm) {
    const rs = ray(cam, skinPx);
    const X  = add(scale(rs, dist / norm(rs)), cam.up, hCm);
    return X[2] > 1e-6 ? project(cam, X) : null;
  }

  // ── Phân tích một lần châm từ chuỗi mẫu thô {t (ms), d (cm)} ──────────────────────────────

  function median(vals) {
    if (!vals.length) return null;
    const s = [...vals].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /**
   * Tốc độ châm trung bình = quãng 10% → 90% độ sâu cuối chia cho thời gian đi quãng đó.
   * Dùng mẫu THÔ (chỉ lọc trung vị 3 điểm để bỏ gai), vì mẫu đã làm mượt đến trễ và làm tốc độ thấp giả.
   * Trả null khi không đủ dữ liệu đáng tin: không thấy lúc kim còn ở ngoài da, hoặc mất dấu kim
   * (tay che) quá maxGapMs ngay trong lúc đâm.
   * @returns {{speed:number, dur:number}|null}  speed cm/s, dur giây
   */
  function strokeSpeed(samples, finalDepth, maxGapMs = 400) {
    const n = samples.length;
    if (n < 3 || !(finalDepth > 0)) return null;
    const f = samples.map((s, i) => {
      const a = samples[Math.max(0, i - 1)].d, c = samples[Math.min(n - 1, i + 1)].d;
      return { t: s.t, d: median([a, s.d, c]) };
    });
    const lo = 0.1 * finalDepth, hi = 0.9 * finalDepth;
    let iLo = -1;
    for (let i = n - 1; i >= 0; i--) if (f[i].d <= lo) { iLo = i; break; }
    if (iLo < 0 || iLo >= n - 1) return null;
    let iHi = -1;
    for (let i = iLo + 1; i < n; i++) if (f[i].d >= hi) { iHi = i; break; }
    if (iHi < 0) return null;
    for (let i = iLo; i < iHi; i++) if (f[i + 1].t - f[i].t > maxGapMs) return null;
    const cross = (i, level) => {                       // thời điểm cắt mức level giữa mẫu i và i+1
      const a = f[i], b = f[i + 1];
      return b.d === a.d ? b.t : a.t + (b.t - a.t) * (level - a.d) / (b.d - a.d);
    };
    const dur = (cross(iHi - 1, hi) - cross(iLo, lo)) / 1000;
    if (!(dur > 0.02)) return null;
    return { speed: (hi - lo) / dur, dur };
  }

  /**
   * Tốc độ châm khi tay che kim: số đo tuyệt đối lúc còn tay không đáng tin, nhưng điểm đang được bám
   * (đỉnh cán, hoặc mép ngón tay kẹp kim) chuyển động CỨNG cùng cây kim, nên quãng nó đi xuống là thật.
   * Kim không thể đi xuống quá độ sâu cuối cùng sau khi chạm da, vậy nên `depth` cm đi xuống SAU CÙNG
   * trước khi kim dừng chính là lần châm. Tốc độ = quãng 30% → 90% của đoạn đó chia cho thời gian đi hết.
   * @param samples [{t (ms), r (cm, tăng khi kim đi xuống)}]
   * @returns {{speed:number, dur:number}|null}
   */
  function descentSpeed(samples, depth, vMin = 0.5, vMax = 40, maxGapMs = 400) {
    const n = samples.length;
    if (n < 4 || !(depth > 0)) return null;
    const m = samples.map((s, i) => median([samples[Math.max(0, i - 1)].r, s.r, samples[Math.min(n - 1, i + 1)].r]));
    const down = i => {                                   // bước từ mẫu i-1 đến mẫu i là "đang đi xuống"
      if (i < 1 || i >= n) return false;
      const dt = samples[i].t - samples[i - 1].t;
      const v = dt > 0 ? (m[i] - m[i - 1]) / (dt / 1000) : 0;
      return dt <= maxGapMs && v > vMin && v < vMax;
    };
    // Điểm kim dừng: bước đi xuống cuối cùng (phải có bước liền kề cũng đi xuống để loại nhiễu đơn lẻ).
    let e = -1;
    for (let i = n - 1; i >= 1; i--) if (down(i) && (down(i - 1) || down(i + 1))) { e = i; break; }
    if (e < 2) return null;
    const mEnd = median(m.slice(e, Math.min(n, e + 3)));  // mức của điểm bám khi kim đã dừng
    // Quy về "độ sâu giả" so với mức cuối: d = depth − (mEnd − m). Trước khi châm d ≤ 0, lúc dừng d = depth.
    // Lấy quãng 30% → 90%: mẫu cuối cùng còn ≤ 30% rồi mẫu đầu tiên sau đó đạt ≥ 90%. Mốc dưới đặt cao (30%)
    // để khi độ sâu chốt bị đo dư vài mm, mốc này vẫn rơi vào trong lần châm chứ không lùi về lúc đưa kim tới.
    const d = i => depth - (mEnd - m[i]);
    const lo = 0.3 * depth, hi = 0.9 * depth;
    let iLo = -1;
    for (let i = e; i >= 0; i--) if (d(i) <= lo) { iLo = i; break; }
    if (iLo < 0) return null;                             // không thấy lúc kim còn ở ngoài da
    let iHi = -1;
    for (let i = iLo + 1; i <= Math.min(n - 1, e + 2); i++) if (d(i) >= hi) { iHi = i; break; }
    if (iHi < 0) return null;
    for (let i = iLo; i < iHi; i++) if (samples[i + 1].t - samples[i].t > maxGapMs) return null;   // mất dấu giữa lúc đâm
    const cross = (i, level) => {
      const a = d(i), b2 = d(i + 1), ta = samples[i].t, tb = samples[i + 1].t;
      return b2 === a ? tb : ta + (tb - ta) * (level - a) / (b2 - a);
    };
    const dur = (cross(iHi - 1, hi) - cross(iLo, lo)) / 1000;
    if (!(dur > 0.02)) return null;
    return { speed: (hi - lo) / dur, dur };
  }

  return { camera, ray, project, calibrate, angleOnly, pose, poseVisible, aboveSkinPx, median, strokeSpeed, descentSpeed };
})();

if (typeof module === 'object' && module.exports) module.exports = Geo;
