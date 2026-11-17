'use strict';

/**
 * Phát hiện kim châm cứu theo HÌNH DẠNG (không phụ thuộc màu) bằng OpenCV.js.
 *
 * Ý tưởng: kim là vật mảnh, thẳng và dựng đứng so với mặt da.
 *   1. Ảnh xám → top-hat + black-hat: giữ lại các cấu trúc mảnh (sáng hoặc tối hơn nền),
 *      bỏ các mảng lớn và các mép bậc thang (mép bàn, mép mô hình da).
 *   2. Ngưỡng theo thống kê ảnh → HoughLinesP: tìm các đoạn thẳng.
 *   3. Chỉ giữ đoạn đủ dốc (≥ minIncline so với phương ngang); mỗi đoạn là một "hạt giống".
 *   4. Từ mỗi hạt giống dò dọc hai phía theo từng mặt cắt ngang trên ảnh gốc (không qua ngưỡng nhị phân):
 *      bám cả cán lẫn thân kim rất mảnh, từ đỉnh cán tới điểm cuối nhìn thấy được (mũi kim khi kim
 *      còn ở ngoài, hoặc điểm kim đâm vào da khi đã châm), rồi khớp một đường thẳng.
 *   5. Chọn ứng viên dài, liền mạch và THẲNG nhất (ưu tiên gần vị trí/hướng cũ và đi qua điểm châm).
 *      Mép ngón tay (bậc thang một phía) và nếp gấp ngón tay (cong) bị loại ở bước này.
 */
const clamp8 = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

class NeedleDetector {
  /**
   * @param {object} opts
   * @param {number} opts.minIncline - góc tối thiểu so với phương ngang (độ) để coi là kim
   */
  constructor(opts = {}) {
    this.minIncline = opts.minIncline ?? 45;
    this.kernelFrac  = opts.kernelFrac  ?? 0.07;   // bề rộng kernel so với bề rộng ảnh (phải lớn hơn bề dày cán kim)
    this.minContrast = opts.minContrast ?? 10;     // chênh lệch tối thiểu so với nền (0–255)
    this.sigma       = opts.sigma       ?? 1.5;    // ngưỡng = trung bình + sigma × độ lệch chuẩn
    this._kernel = null;
    this._kSize  = 0;
  }

  /**
   * @param   {HTMLCanvasElement} canvas
   * @param   {object} [opts]
   * @param   {[number,number]|null} opts.hint   - đỉnh kim ở khung trước (pixel canvas)
   * @param   {[number,number]|null} opts.hintDir - hướng kim ở khung trước (vector đơn vị, hướng xuống)
   * @param   {number}               opts.hintLen - chiều dài kim trên ảnh ở khung trước (pixel canvas)
   * @param   {[number,number]|null} opts.skin   - điểm châm trên da (pixel canvas)
   * @param   {number[]|null}        opts.region - [x0, y0, x1, y1] vùng khoanh (pixel canvas)
   * @returns {{found, top, bottom, incline, lengthPx, tip, tipOk}}
   *   tip = điểm cuối nhìn thấy của cây kim; tipOk = đoạn cuối đúng là thân kim mảnh (đáng tin)
   */
  detect(canvas, { hint = null, hintDir = null, hintLen = 0, skin = null, region = null } = {}) {
    const result = { found: false, top: null, bottom: null, incline: 90, lengthPx: 0, tip: null, tipOk: false };
    const mats = [];
    const M = m => { mats.push(m); return m; };

    try {
      const W = canvas.width, H = canvas.height;
      let X0 = 0, Y0 = 0, X1 = W, Y1 = H;
      if (region) {
        X0 = Math.max(0, Math.floor(region[0])); Y0 = Math.max(0, Math.floor(region[1]));
        X1 = Math.min(W, Math.ceil(region[2]));  Y1 = Math.min(H, Math.ceil(region[3]));
        if (X1 - X0 < 8 || Y1 - Y0 < 8) return result;      // vùng nằm ngoài khung hiện tại
      }

      const src = M(canvas.data ? cv.matFromImageData(canvas) : cv.imread(canvas));   // RGBA
      const roiRect = new cv.Rect(X0, Y0, X1 - X0, Y1 - Y0);
      const planes  = M(new cv.MatVector());
      cv.split(src, planes);

      // Cấu trúc mảnh hơn kernel (kim, cán kim) được giữ lại; mảng lớn và mép bậc thang bị loại.
      // Tính trên từng kênh màu rồi lấy lớn nhất: kim khác nền về màu vẫn nổi lên dù độ sáng gần bằng nhau.
      const k    = this._getKernel(Math.max(9, Math.round(W * this.kernelFrac) | 1));
      const resp = M(cv.Mat.zeros(roiRect.height, roiRect.width, cv.CV_8UC1));
      const work = M(new cv.Mat()), th = M(new cv.Mat()), bh = M(new cv.Mat());
      for (let c = 0; c < 3; c++) {
        const plane = planes.get(c);
        const view  = plane.roi(roiRect);
        cv.GaussianBlur(view, work, new cv.Size(3, 3), 0);
        cv.morphologyEx(work, th, cv.MORPH_TOPHAT,   k);
        cv.morphologyEx(work, bh, cv.MORPH_BLACKHAT, k);
        cv.max(th, resp, resp);
        cv.max(bh, resp, resp);
        view.delete(); plane.delete();
      }

      const mean = M(new cv.Mat()), std = M(new cv.Mat());
      cv.meanStdDev(resp, mean, std);
      // Chặn trên để vài vật tương phản mạnh trong khung không đẩy ngưỡng vượt quá kim.
      const thr = clamp8(mean.doubleAt(0, 0) + this.sigma * std.doubleAt(0, 0), this.minContrast, 30);
      const bin = M(new cv.Mat());
      cv.threshold(resp, bin, thr, 255, cv.THRESH_BINARY);

      const lines  = M(new cv.Mat());
      const minLen = Math.max(14, Math.round(0.04 * H));
      cv.HoughLinesP(bin, lines, 1, Math.PI / 180, 18, minLen, 5);

      // ── Lọc đoạn đủ dốc ──
      const sinMin = Math.sin(this.minIncline * Math.PI / 180);
      const segs = [];
      const n = Math.min(lines.rows, 500);
      for (let i = 0; i < n; i++) {
        let x1 = lines.data32S[i * 4]     + X0, y1 = lines.data32S[i * 4 + 1] + Y0;
        let x2 = lines.data32S[i * 4 + 2] + X0, y2 = lines.data32S[i * 4 + 3] + Y0;
        if (y2 < y1) { [x1, x2] = [x2, x1]; [y1, y2] = [y2, y1]; }   // (x1,y1) là đầu trên
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len < 1) continue;
        const ux = (x2 - x1) / len, uy = (y2 - y1) / len;            // hướng xuống
        if (uy < sinMin) continue;
        segs.push({ x1, y1, x2, y2, len, ux, uy, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 });
      }

      // ── Kiểm chứng từng ứng viên bằng cách dò mặt cắt trên ảnh gốc ──
      // Đoạn Hough chỉ là "hạt giống". Kim thật là một vệt mảnh HAI PHÍA đều là nền, thẳng tắp và dài;
      // mép ngón tay là bậc thang một phía (bị loại ở mặt cắt), nếp gấp giữa các ngón thì cong và ngắn.
      segs.sort((a, b) => b.len - a.len);
      const diag = Math.hypot(W, H);
      const minExtent = Math.max(24, 0.07 * H);
      const bounds = [X0, Y0, X1, Y1];
      let best = null, bestScore = 0;
      const tried = [];

      // Hạt giống đầu tiên: vị trí và hướng kim ở khung trước (nếu có) — giữ được kim khi tay làm mất đoạn Hough.
      const seeds = [...segs.slice(0, 8), ...this._scanSeeds(src, bounds, sinMin)];
      if (hint && hintDir) {
        const L = Math.max(0.08 * H, hintLen || 0);          // cả chiều dài kim ở khung trước
        seeds.unshift({ mx: hint[0] + hintDir[0] * L / 2, my: hint[1] + hintDir[1] * L / 2, ux: hintDir[0], uy: hintDir[1], len: L });
      }
      for (const seed of seeds) {
        // Bỏ hạt giống nằm trên một trục đã dò (cùng một vật).
        if (tried.some(q => Math.abs(q.dir[0] * seed.uy - q.dir[1] * seed.ux) < 0.1 &&
              Math.abs((seed.mx - q.top[0]) * q.dir[1] - (seed.my - q.top[1]) * q.dir[0]) < 4)) continue;
        // Dò từ nhiều điểm xuất phát dọc hạt giống: điểm rơi vào chỗ kim lẫn với ngón tay sẽ dò hỏng,
        // điểm rơi vào đoạn kim nổi rõ trên nền sẽ cho cả cây kim. Giữ kết quả tốt nhất.
        const half = (seed.len || 0) / 2;
        let tr = null, trQ = 0;
        for (const f of half > 12 ? [0, -0.85, 0.85, -0.6, 0.6, -0.3, 0.3] : [0]) {
          const c = this._trace(src, [seed.mx + seed.ux * half * f, seed.my + seed.uy * half * f], [seed.ux, seed.uy], bounds);
          if (!c || c.rms > 1.5 || c.cover < 0.5) continue;
          const q = c.len * c.cover / (1 + c.rms * c.rms);
          if (q > trQ) { trQ = q; tr = c; }
        }
        if (!tr) continue;
        tried.push(tr);
        if (tr.len < minExtent || tr.dir[1] < sinMin) continue;

        let score = tr.len * tr.cover * tr.dir[1] * tr.dir[1] / (1 + tr.rms * tr.rms);   // dài, liền, thẳng, dựng đứng
        if (hint) {
          const d = Math.hypot(tr.top[0] - hint[0], tr.top[1] - hint[1]) / (0.10 * diag);
          score /= 1 + d * d;
        }
        if (hintDir) {
          const c = Math.abs(tr.dir[0] * hintDir[1] - tr.dir[1] * hintDir[0]) / 0.2;      // lệch hướng ~12° → giảm nửa
          score /= 1 + c * c;
        }
        if (skin) {
          // Trục kim kéo dài phải đi gần điểm châm và đỉnh kim phải ở phía trên mặt da.
          const lat = Math.abs((skin[0] - tr.top[0]) * tr.dir[1] - (skin[1] - tr.top[1]) * tr.dir[0]);
          const q = lat / (0.08 * diag);
          score /= 1 + q * q;
          if (tr.top[1] > skin[1]) score *= 0.05;
        }
        if (score > bestScore) { bestScore = score; best = tr; }
      }
      if (!best) return result;

      result.found    = true;
      result.top      = best.top;
      result.bottom   = best.end;
      result.dir      = best.dir;
      result.lengthPx = best.len;
      result.incline  = Math.atan2(Math.abs(best.dir[1]), Math.abs(best.dir[0])) * 180 / Math.PI;
      result.tip      = best.end;
      result.tipOk    = best.ok;
      result.quality  = { cover: best.cover, rms: best.rms, handleW: best.handleW, endW: best.endW };

    } catch (e) {
      console.error('NeedleDetector.detect error:', e);
    } finally {
      mats.forEach(m => { try { if (m && !m.isDeleted?.()) m.delete(); } catch (_) {} });
    }
    return result;
  }

  /**
   * Hạt giống không phụ thuộc Hough: quét các hàng ngang cách đều, tìm điểm là "vệt mảnh" (khác nền ở cả
   * hai bên), rồi thử các hướng quanh phương thẳng đứng để lấy hướng mà vệt kéo dài rõ nhất.
   * Kim rõ nhưng ngưỡng nhị phân/Hough bỏ sót (nền thay đổi, kim hơi nhoè) vẫn được tìm thấy ở bước này.
   */
  _scanSeeds(src, bounds, sinMin) {
    const d = src.data, W = src.cols, H = src.rows;
    const [X0, Y0, X1, Y1] = bounds;
    const T = this.minContrast * 0.8 * 4;                  // theo đơn vị của lum (tổng trọng số 4)
    const val = (x, y, c) => { const j = (y * W + x) * 4; return c ? 4 * (d[j] - d[j + 2]) : d[j] + 2 * d[j + 1] + d[j + 2]; };
    const ridge = (x, y) => {
      if (x < 7 || y < 0 || x >= W - 7 || y >= H) return 0;
      let best = 0;
      for (let c = 0; c < 2; c++) {
        const v = val(x, y, c);
        for (const k of [3, 6]) {
          const l = val(x - k, y, c), r = val(x + k, y, c);
          if (Math.sign(l - v) === Math.sign(r - v)) best = Math.max(best, Math.min(Math.abs(l - v), Math.abs(r - v)));
        }
      }
      return best;
    };
    const angles = [];
    for (let a = -45; a <= 45; a += 5) {
      const dx = Math.sin(a * Math.PI / 180), dy = Math.cos(a * Math.PI / 180);
      if (dy >= sinMin - 1e-6) angles.push([dx, dy]);
    }
    const cands = [];
    const stepY = Math.max(6, Math.round(0.035 * H));
    for (let y = Math.max(Y0, 14) + (stepY >> 1); y < Math.min(Y1, H - 14); y += stepY) {
      for (let x = Math.max(X0, 8); x < Math.min(X1, W - 8); x++) {
        const s0 = ridge(x, y);
        if (s0 < T || s0 < ridge(x - 1, y) || s0 <= ridge(x + 1, y)) continue;     // cực đại cục bộ theo x
        let bestS = 0, bestA = null;
        for (const [dx, dy] of angles) {
          let sum = 0, hits = 0;
          for (let j = -12; j <= 12; j += 2) {
            const px = Math.round(x + dx * j), py = Math.round(y + dy * j);
            // cho lệch ±1 px vì hướng thử thô 5°
            const v = Math.max(ridge(px, py), ridge(px - 1, py), ridge(px + 1, py));
            if (v >= T) { sum += v; hits++; }
          }
          if (hits >= 11 && sum > bestS) { bestS = sum; bestA = [dx, dy]; }
        }
        if (bestA) cands.push({ mx: x, my: y, ux: bestA[0], uy: bestA[1], s: bestS });
      }
    }
    cands.sort((a, b) => b.s - a.s);
    return cands.slice(0, 16);
  }

  /**
   * Dò cả cây kim theo các mặt cắt ngang trục, từ một điểm trên kim đi về hai phía.
   * Mỗi mặt cắt: trừ nền từng kênh màu (nội suy giữa hai mép mặt cắt), lấy độ lệch màu so với nền,
   * tìm vệt lệch, đo tâm và bề rộng. Vệt chạm mép mặt cắt (mép ngón tay, bóng đổ, mảng lớn) bị loại.
   * Sau đó khớp đường thẳng bền vững (bỏ các điểm bị mép ngón tay kéo lệch), rồi kéo dài đường thẳng
   * xuống dưới để nối với đoạn thân kim mảnh nằm phía dưới ngón tay nếu cán kim bị tay che.
   * @returns {{top, end, dir, len, cover, rms, handleW, endW, ok}|null}  top = đầu trên, end = đầu dưới
   */
  _trace(src, mid, u, bounds) {
    const d = src.data, W = src.cols, H = src.rows;
    const m   = Math.max(8, Math.round(this._kSize * 0.6));   // nửa bề rộng mặt cắt
    const N   = 2 * m + 1;
    const thr = this.minContrast * 0.8;
    const gapSmall = Math.max(5, Math.round(0.02 * H)); // khe hở thường (lóe sáng trên thân kim)
    const prof = new Float32Array(N), prof2 = new Float32Array(N), dev = new Float32Array(N);

    const pass = (mid, ux, uy, drift, search0, tS = 0, oS = 0) => {
      const nx = uy, ny = -ux;
      const slice = (t, oc, search) => {
        // Hai kênh: độ sáng, và sắc đỏ (R − B). Kim thép xám trước ngón tay gần như cùng độ sáng với da
        // nhưng khác hẳn về sắc đỏ, nên kênh thứ hai giữ được kim khi nó nằm trước bàn tay.
        for (let i = 0; i < N; i++) {
          let sum = 0, rb = 0;
          for (let k = -1; k <= 1; k++) {
            const x = Math.round(mid[0] + ux * (t + k) + nx * (oc + i - m));
            const y = Math.round(mid[1] + uy * (t + k) + ny * (oc + i - m));
            if (x < 0 || y < 0 || x >= W || y >= H) return null;
            const j = (y * W + x) * 4;
            sum += d[j] + 2 * d[j + 1] + d[j + 2];
            rb  += d[j] - d[j + 2];
          }
          prof[i] = sum / 12; prof2[i] = rb / 3;
        }
        let ip = -1, p = 0, ch = prof;
        for (const pr of [prof, prof2]) {
          const bl = (pr[0] + pr[1] + pr[2]) / 3, br = (pr[N - 1] + pr[N - 2] + pr[N - 3]) / 3;
          for (let i = 0; i < N; i++) {
            const e = pr[i] - (bl + (br - bl) * i / (N - 1));
            if (Math.abs(i - m) <= search && Math.abs(e) > Math.abs(p)) { p = e; ip = i; ch = pr; }
          }
        }
        if (ip < 0 || Math.abs(p) < thr) return null;
        {
          const bl = (ch[0] + ch[1] + ch[2]) / 3, br = (ch[N - 1] + ch[N - 2] + ch[N - 3]) / 3;
          for (let i = 0; i < N; i++) dev[i] = ch[i] - (bl + (br - bl) * i / (N - 1));
        }
        const half = Math.abs(p) * 0.5, sg = Math.sign(p);
        let i0 = ip, i1 = ip;
        while (i0 > 0     && dev[i0 - 1] * sg > half) i0--;
        while (i1 < N - 1 && dev[i1 + 1] * sg > half) i1++;
        if (i0 <= 2 || i1 >= N - 3) return null;          // vệt chạm mép → không phải vật mảnh
        let sw = 0, sx = 0;
        for (let i = i0; i <= i1; i++) { sw += dev[i] * sg; sx += dev[i] * sg * i; }
        return { o: oc + sx / sw - m, w: i1 - i0 + 1 };
      };

      const first = slice(tS, Math.round(oS), search0);
      if (!first) return null;
      const walk = sgn => {
        const pts = [];
        let oc = first.o, gap = 0;
        for (let k = 1; gap <= gapSmall; k++) {
          const t = tS + sgn * k;
          const px = mid[0] + ux * t, py = mid[1] + uy * t;
          if (px < bounds[0] || py < bounds[1] || px >= bounds[2] || py >= bounds[3]) break;
          const r = slice(t, Math.round(oc), 3);
          if (!r) { gap++; continue; }
          gap = 0;
          oc += clamp8(r.o - oc, -drift, drift);
          pts.push([t, r.o, r.w]);
        }
        return pts;
      };
      const up = walk(-1), down = walk(+1);
      return [...up.reverse(), [tS, first.o, first.w], ...down];        // theo t tăng dần (trên → dưới)
    };

    // Khớp đường thẳng o = a + b·t, lặp lại sau khi bỏ điểm lệch xa (bị mép ngón tay kéo).
    const fit = pts => {
      let use = pts, a = 0, b = 0;
      for (let it = 0; it < 4; it++) {
        let st = 0, so = 0, stt = 0, sto = 0;
        for (const [t, o] of use) { st += t; so += o; stt += t * t; sto += t * o; }
        const n = use.length, den = n * stt - st * st;
        b = den > 1e-6 ? (n * sto - st * so) / den : 0; a = (so - b * st) / n;
        const res = pts.map(q => Math.abs(q[1] - (a + b * q[0]))).sort((x, y) => x - y);
        const lim = Math.max(1, 2 * res[res.length >> 1]);
        const next = pts.filter(q => Math.abs(q[1] - (a + b * q[0])) <= lim);
        if (next.length < 12 || next.length === use.length) { use = next.length >= 12 ? next : use; break; }
        use = next;
      }
      let ss = 0;
      for (const [t, o] of use) { const e = o - (a + b * t); ss += e * e; }
      // Tham số lấy từ các điểm tin cậy; phạm vi (hai đầu kim) giữ mọi điểm lệch ≤ 3 px để không cắt cụt.
      return { a, b, inl: pts.filter(q => Math.abs(q[1] - (a + b * q[0])) <= 3), rms: Math.sqrt(ss / use.length) };
    };

    const tol = Math.max(3, Math.round(this._kSize * 0.3));
    const p1 = pass(mid, u[0], u[1], 0.35, tol);
    if (!p1 || p1.length < 12) return null;
    const f1 = fit(p1);
    let pts = f1.inl;
    const pct = (arr, q) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

    // Nối qua chỗ bị che (ngón tay cầm kim): đi tiếp theo đúng đường thẳng đã khớp về CẢ HAI phía, tìm một
    // đoạn vệt mảnh dài ≥ 12 điểm nằm đúng trên đường kéo dài (thân kim dưới ngón tay, hoặc cán kim nhô lên
    // trên ngón tay), rồi dò kỹ đoạn đó và ghép vào nếu thẳng hàng, cùng hướng.
    const lineO = t => f1.a + f1.b * t;
    const nx = u[1], ny = -u[0];
    const val = (x, y, c) => { const j = (Math.round(y) * W + Math.round(x)) * 4; return c ? 4 * (d[j] - d[j + 2]) : d[j] + 2 * d[j + 1] + d[j + 2]; };
    const ridge = (x, y) => {                              // vệt mảnh: khác hẳn nền ở cả hai bên (độ sáng hoặc sắc đỏ)
      let best = 0;
      for (let c = 0; c < 2; c++) {
        const v = val(x, y, c);
        for (const k of [3, 6]) {
          const l = val(x - nx * k, y - ny * k, c), r = val(x + nx * k, y + ny * k, c);
          if (Math.sign(l - v) === Math.sign(r - v)) best = Math.max(best, Math.min(Math.abs(l - v), Math.abs(r - v)));
        }
      }
      return best;
    };
    let bridged = false;
    const bridge = sgn => {
      const tFrom = sgn > 0 ? pts[pts.length - 1][0] : pts[0][0];
      let run = [], bestRun = null;
      const close = () => { if (run.length >= 12 && (!bestRun || run.length > bestRun.length)) bestRun = run; };
      for (let k = 1; ; k++) {
        const t = tFrom + sgn * k, o0 = lineO(t), win = Math.round(2 + 0.04 * k);
        const cx = mid[0] + u[0] * t + nx * o0, cy = mid[1] + u[1] * t + ny * o0;
        if (cx < bounds[0] + win + 7 || cy < bounds[1] + 1 || cx >= bounds[2] - win - 7 || cy >= bounds[3] - 1) break;
        let hit = null, bestC = thr * 4;
        for (let o = -win; o <= win; o++) {
          const c = ridge(cx + nx * o, cy + ny * o);
          if (c > bestC) { bestC = c; hit = o0 + o; }
        }
        const last = run[run.length - 1];
        if (hit !== null && (!last || (Math.abs(t - last[0]) <= gapSmall && Math.abs(hit - last[1]) <= 2))) run.push([t, hit]);
        else { close(); run = hit !== null ? [[t, hit]] : []; }
      }
      close();
      if (!bestRun) return;
      const midRun = bestRun[bestRun.length >> 1];
      const seg = pass(mid, u[0], u[1], 0.35, 2, midRun[0], midRun[1]);
      if (!seg || seg.length < 12) return;
      const fs2 = fit(seg);
      if (fs2.rms > 1.2 || Math.abs(fs2.b - f1.b) > 0.07) return;                    // phải thẳng và cùng hướng (lệch < 4°)
      if (Math.abs(fs2.a + fs2.b * midRun[0] - lineO(midRun[0])) > 2 + 0.04 * Math.abs(midRun[0] - tFrom)) return;
      const extra = fs2.inl.filter(q => sgn > 0 ? q[0] > tFrom : q[0] < tFrom);
      if (extra.length < 12) return;
      pts = sgn > 0 ? [...pts, ...extra] : [...extra, ...pts];
      bridged = true;
    };
    bridge(+1);
    bridge(-1);

    const f2 = bridged ? fit(pts) : f1;
    if (bridged) pts = f2.inl;
    const n = pts.length, t0 = pts[0][0], t1 = pts[n - 1][0];
    const at = t => [mid[0] + u[0] * t + nx * (f2.a + f2.b * t), mid[1] + u[1] * t + ny * (f2.a + f2.b * t)];
    const top = at(t0), end = at(t1);
    const len = Math.hypot(end[0] - top[0], end[1] - top[1]);
    if (len < 1) return null;

    const handleW = pct(pts.slice(0, Math.max(4, Math.ceil(n * 0.4))).map(q => q[2]), 0.75);   // cán kim ở phần trên
    const endW  = pct(pts.slice(-8).map(q => q[2]), 0.5);
    const cover = Math.min(1, n / Math.max(1, t1 - t0 + 1));
    // Đoạn cuối (10% chiều dài) phải liền mạch thì điểm cuối mới đáng tin.
    const tailFrom = t1 - Math.max(8, 0.1 * len);
    const tail = pts.filter(q => q[0] >= tailFrom).length / (t1 - tailFrom + 1);
    // Độ thẳng và độ liền tính trên đoạn đã dò trực tiếp; đoạn nối qua chỗ che không làm giảm điểm.
    const span1 = f1.inl[f1.inl.length - 1][0] - f1.inl[0][0] + 1;
    return {
      top, end, len, rms: f1.rms, handleW, endW, bridged,
      cover: Math.min(1, f1.inl.length / span1),
      dir: [(end[0] - top[0]) / len, (end[1] - top[1]) / len],
      // Điểm cuối đáng tin khi đoạn cuối liền mạch và mảnh hẳn so với cán (đúng là thân kim).
      ok: tail >= 0.8 && f2.rms < 1.5 && endW <= Math.max(2, 0.6 * handleW) && (bridged || cover >= 0.75),
    };
  }

  dispose() {
    if (this._kernel) { this._kernel.delete(); this._kernel = null; }
  }

  _getKernel(size) {
    if (!this._kernel || this._kSize !== size) {
      if (this._kernel) this._kernel.delete();
      this._kernel = cv.Mat.ones(size, size, cv.CV_8U);
      this._kSize  = size;
    }
    return this._kernel;
  }
}
