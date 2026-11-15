'use strict';

/**
 * Phát hiện kim châm cứu theo HÌNH DẠNG (không phụ thuộc màu) bằng OpenCV.js.
 *
 * Ý tưởng: kim là vật mảnh, thẳng và dựng đứng so với mặt da.
 *   1. Ảnh xám → top-hat + black-hat: giữ lại các cấu trúc mảnh (sáng hoặc tối hơn nền),
 *      bỏ các mảng lớn và các mép bậc thang (mép bàn, mép mô hình da).
 *   2. Ngưỡng theo thống kê ảnh → HoughLinesP: tìm các đoạn thẳng.
 *   3. Chỉ giữ đoạn đủ dốc (≥ minIncline so với phương ngang), gom các đoạn thẳng hàng
 *      thành một trục, chọn trục dài nhất (ưu tiên gần vị trí cũ và đi qua điểm châm).
 *   4. Đầu trên của trục = đỉnh kim.
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
   * @param   {[number,number]|null} opts.skin   - điểm châm trên da (pixel canvas)
   * @param   {number[]|null}        opts.region - [x0, y0, x1, y1] vùng khoanh (pixel canvas)
   * @returns {{found, top, bottom, incline, lengthPx}}
   */
  detect(canvas, { hint = null, skin = null, region = null } = {}) {
    const result = { found: false, top: null, bottom: null, incline: 90, lengthPx: 0 };
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

      const src = M(cv.imread(canvas));                      // RGBA
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
      if (!segs.length) return result;

      // ── Gom các đoạn thẳng hàng quanh mỗi "hạt giống" dài nhất ──
      segs.sort((a, b) => b.len - a.len);
      const diag = Math.hypot(W, H);
      const minExtent = Math.max(24, 0.07 * H);
      let best = null, bestScore = 0;

      // Dò dọc theo trục trên ảnh nhị phân để tìm đúng hai đầu mút của vật
      // (đoạn Hough thường dừng sớm hoặc chỉ bám một mép của cán kim).
      const tol  = Math.max(3, Math.round(this._kSize * 0.3));
      const data = bin.data, bw = bin.cols, bhgt = bin.rows;
      const lit  = (x, y) => {
        const c = Math.round(x) - X0, r = Math.round(y) - Y0;
        return c >= 0 && r >= 0 && c < bw && r < bhgt && data[r * bw + c] > 0;
      };
      const walk = (seed, t0, dir) => {
        let t = t0, last = t0, gap = 0;
        while (gap <= 6) {
          t += dir;
          const px = seed.mx + seed.ux * t, py = seed.my + seed.uy * t;
          if (px < X0 || px >= X1 || py < Y0 || py >= Y1) break;
          let hit = false;
          for (let o = -tol; o <= tol && !hit; o++) hit = lit(px + o * seed.uy, py - o * seed.ux);
          if (hit) { last = t; gap = 0; } else gap++;
        }
        return last;
      };

      for (const seed of segs.slice(0, 8)) {
        let tMin = Infinity, tMax = -Infinity, cover = 0;
        for (const s of segs) {
          if (Math.abs(seed.ux * s.uy - seed.uy * s.ux) > 0.14) continue;          // lệch hướng > 8°
          const dx = s.mx - seed.mx, dy = s.my - seed.my;
          const along = dx * seed.ux + dy * seed.uy;
          const lat   = Math.abs(dx * seed.uy - dy * seed.ux);
          if (lat > tol + 0.02 * Math.abs(along)) continue;                         // không thẳng hàng
          for (const [px, py] of [[s.x1, s.y1], [s.x2, s.y2]]) {
            const t = (px - seed.mx) * seed.ux + (py - seed.my) * seed.uy;
            if (t < tMin) tMin = t;
            if (t > tMax) tMax = t;
          }
          cover += s.len;
        }
        tMin = walk(seed, tMin, -1);
        tMax = walk(seed, tMax, +1);
        const extent = tMax - tMin;
        if (extent < minExtent) continue;

        const top    = [seed.mx + seed.ux * tMin, seed.my + seed.uy * tMin];
        const bottom = [seed.mx + seed.ux * tMax, seed.my + seed.uy * tMax];
        let score = Math.min(extent, cover) * seed.uy * seed.uy;   // dài, liền mạch, dựng đứng

        if (hint) {
          const d = Math.hypot(top[0] - hint[0], top[1] - hint[1]) / (0.15 * diag);
          score /= 1 + d * d;
        }
        if (skin) {
          // Trục kim kéo dài phải đi gần điểm châm và đỉnh kim phải ở phía trên mặt da.
          const lat = Math.abs((skin[0] - top[0]) * seed.uy - (skin[1] - top[1]) * seed.ux);
          const q = lat / (0.08 * diag);
          score /= 1 + q * q;
          if (top[1] > skin[1]) score *= 0.05;
        }
        if (score > bestScore) { bestScore = score; best = { top, bottom, extent }; }
      }
      if (!best) return result;

      const dx = best.bottom[0] - best.top[0], dy = best.bottom[1] - best.top[1];
      result.found    = true;
      result.top      = best.top;
      result.bottom   = best.bottom;
      result.lengthPx = best.extent;
      result.incline  = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI;

    } catch (e) {
      console.error('NeedleDetector.detect error:', e);
    } finally {
      mats.forEach(m => { try { if (m && !m.isDeleted?.()) m.delete(); } catch (_) {} });
    }
    return result;
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
