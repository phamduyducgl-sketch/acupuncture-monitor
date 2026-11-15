'use strict';

/**
 * Phát hiện kim châm cứu qua CÁN KIM có màu (xanh lá / xanh dương) bằng OpenCV.js.
 *
 * Khác bản gốc (chỉ bắt chấm màu ở đầu kim với ngưỡng sáng cao):
 *   - Lọc theo dải màu (Hue) rộng, ngưỡng bão hoà / độ sáng thấp → ít phụ thuộc ánh sáng.
 *   - Chọn vùng theo hình dạng thon dài + gần vị trí khung trước (hint), không chỉ theo diện tích.
 *   - Ghép các đoạn cán kim bị ngón tay che thành một trục.
 *   - Trả về ĐỈNH cán kim (top) làm điểm theo dõi và góc nghiêng của cả cán kim.
 */
class NeedleDetector {
  /**
   * @param {object} opts
   * @param {number[]} opts.hsvLower - [H, S, V] ngưỡng dưới (thang OpenCV: H 0–179)
   * @param {number[]} opts.hsvUpper - [H, S, V] ngưỡng trên
   * @param {number}   opts.minArea  - diện tích vùng màu tối thiểu (pixel²)
   */
  constructor(opts = {}) {
    this.hsvLower = opts.hsvLower ?? [60, 70, 40];
    this.hsvUpper = opts.hsvUpper ?? [135, 255, 255];
    this.minArea  = opts.minArea  ?? 60;

    this._kOpen    = null;
    this._kClose   = null;
    this._lowerMat = null;
    this._upperMat = null;
    this._lastRows = 0;
    this._lastCols = 0;
  }

  /**
   * @param   {HTMLCanvasElement} canvas
   * @param   {object} [opts]
   * @param   {[number,number]|null} opts.hint   - vị trí đỉnh kim ở khung trước (pixel canvas)
   * @param   {[number,number]|null} opts.skin   - điểm châm trên da (pixel canvas), nếu đã đặt
   * @param   {number[]|null}        opts.region - [x0, y0, x1, y1] vùng người dùng khoanh (pixel canvas)
   * @returns {{found, center, top, bottom, incline, axisOk, lengthPx, area, vertices}}
   */
  detect(canvas, { hint = null, skin = null, region = null } = {}) {
    const result = {
      found: false, center: [0, 0], top: null, bottom: null,
      incline: 90, axisOk: false, lengthPx: 0, area: 0, vertices: null,
    };

    let src = null, rgb = null, hsv = null, mask = null, clip = null,
        contours = null, hierarchy = null;

    try {
      this._ensureStaticMats(canvas.height, canvas.width);

      src = cv.imread(canvas);                               // RGBA
      rgb = new cv.Mat();
      cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
      cv.GaussianBlur(rgb, rgb, new cv.Size(5, 5), 0);       // giảm nhiễu khi thiếu sáng

      hsv = new cv.Mat();
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);

      mask = new cv.Mat();
      cv.inRange(hsv, this._lowerMat, this._upperMat, mask);
      cv.morphologyEx(mask, mask, cv.MORPH_OPEN,  this._kOpen);   // bỏ đốm nhiễu
      cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, this._kClose);  // nối nắp + thân cán

      // Giới hạn trong vùng người dùng khoanh: xoá mọi điểm màu nằm ngoài vùng.
      let X0 = 0, Y0 = 0, X1 = canvas.width, Y1 = canvas.height;
      if (region) {
        X0 = Math.max(0, Math.floor(region[0])); Y0 = Math.max(0, Math.floor(region[1]));
        X1 = Math.min(canvas.width,  Math.ceil(region[2]));
        Y1 = Math.min(canvas.height, Math.ceil(region[3]));
        if (X1 - X0 < 4 || Y1 - Y0 < 4) return result;      // vùng nằm ngoài khung hiện tại
        const rect = new cv.Rect(X0, Y0, X1 - X0, Y1 - Y0);
        clip = cv.Mat.zeros(mask.rows, mask.cols, cv.CV_8UC1);
        const from = mask.roi(rect), to = clip.roi(rect);
        from.copyTo(to);
        from.delete(); to.delete();
      }

      contours  = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.findContours(clip || mask, contours, hierarchy,
                      cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      const cands = [];
      for (let i = 0; i < contours.size(); i++) {
        const c    = contours.get(i);
        const area = cv.contourArea(c);
        if (area >= this.minArea) {
          const d  = NeedleDetector._describe(cv.minAreaRect(c), area);
          const br = cv.boundingRect(c);
          const W  = X1 - X0, H = Y1 - Y0;
          const L = br.x <= X0 + 1, R = br.x + br.width  >= X1 - 2;
          const T = br.y <= Y0 + 1, B = br.y + br.height >= Y1 - 2;
          // Vật nền bị cắt bởi mép khung (dải ngang/dọc lớn) hoặc quá dày → không phải cán kim.
          const edgeBand = (L && R) || (T && B) ||
                           ((T || B) && br.width  > 0.25 * W) ||
                           ((L || R) && br.height > 0.25 * H);
          if (!edgeBand && d.short <= 0.1 * canvas.width) cands.push(d);
        }
        c.delete();
      }
      if (!cands.length) return result;

      // ── Chọn vùng chính: thon dài, lớn, gần vị trí cũ ──
      const diag    = Math.hypot(canvas.width, canvas.height);
      const minElong = hint ? 1.0 : 2.5;   // đang bám kim → chấp nhận cả đoạn ngắn (bị tay che)
      let main = null, best = 0;
      for (const c of cands) {
        if (c.elong < minElong) continue;
        let score = c.area * Math.min(c.elong, 8);
        if (hint) {
          const d = Math.hypot(c.top[0] - hint[0], c.top[1] - hint[1]) / (0.15 * diag);
          score /= 1 + d * d;
        }
        if (skin && c.elong >= 1.6) {
          // Trục kim kéo dài phải đi gần điểm châm trên da.
          const ux = c.bottom[0] - c.top[0], uy = c.bottom[1] - c.top[1];
          const un = Math.hypot(ux, uy) || 1;
          const lat = Math.abs((skin[0] - c.top[0]) * uy - (skin[1] - c.top[1]) * ux) / un;
          const q = lat / (0.08 * diag);
          score /= 1 + q * q;
          if (c.top[1] > skin[1]) score *= 0.05;   // nằm dưới mặt da → gần như chắc chắn không phải kim
        }
        if (score > best) { best = score; main = c; }
      }
      if (!main) return result;

      // ── Ghép các đoạn cùng nằm trên trục kim (cán kim bị ngón tay chia cắt) ──
      let top = main.top, bottom = main.bottom, area = main.area;
      const axisOk = main.elong >= 1.6;
      if (axisOk) {
        const ux = main.top[0] - main.bottom[0], uy = main.top[1] - main.bottom[1];
        const un = Math.hypot(ux, uy) || 1;
        const ax = ux / un, ay = uy / un;                 // hướng từ dưới lên đỉnh
        const along = p => (p[0] - main.cx) * ax + (p[1] - main.cy) * ay;
        let tMax = along(top), tMin = along(bottom);
        for (const c of cands) {
          if (c === main) continue;
          const t   = along([c.cx, c.cy]);
          const lat = Math.abs((c.cx - main.cx) * ay - (c.cy - main.cy) * ax);
          if (Math.abs(t) > 0.45 * canvas.height) continue;
          if (lat > Math.max(main.short * 1.5, 6) + 0.08 * Math.abs(t)) continue;
          area += c.area;
          for (const p of [c.top, c.bottom]) {
            const tp = along(p);
            if (tp > tMax) { tMax = tp; top = p; }
            if (tp < tMin) { tMin = tp; bottom = p; }
          }
        }
      }

      const dx = top[0] - bottom[0], dy = top[1] - bottom[1];
      result.found    = true;
      result.top      = top;
      result.bottom   = bottom;
      result.center   = [(top[0] + bottom[0]) / 2, (top[1] + bottom[1]) / 2];
      result.lengthPx = Math.hypot(dx, dy);
      result.axisOk   = axisOk;
      result.incline  = axisOk
        ? Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI   // 0–90° so với phương ngang
        : 90;
      result.area     = area;
      result.vertices = NeedleDetector._rectVertices(main.rect);

    } catch (e) {
      console.error('NeedleDetector.detect error:', e);
    } finally {
      [src, rgb, hsv, mask, clip, contours, hierarchy]
        .forEach(m => { try { if (m && !m.isDeleted?.()) m.delete(); } catch (_) {} });
    }

    return result;
  }

  /** Cập nhật ngưỡng HSV. */
  setHSVRange(lower, upper) {
    this.hsvLower = lower;
    this.hsvUpper = upper;
    this._invalidateMats();
  }

  dispose() {
    this._invalidateMats();
    ['_kOpen', '_kClose'].forEach(k => {
      if (this[k]) { this[k].delete(); this[k] = null; }
    });
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _ensureStaticMats(rows, cols) {
    if (!this._kOpen) {
      this._kOpen  = cv.Mat.ones(3, 3, cv.CV_8U);
      this._kClose = cv.Mat.ones(7, 7, cv.CV_8U);
    }
    if (this._lowerMat && this._lastRows === rows && this._lastCols === cols) return;

    this._invalidateMats();
    const [lh, ls, lv] = this.hsvLower;
    const [uh, us, uv] = this.hsvUpper;
    this._lowerMat = new cv.Mat(rows, cols, cv.CV_8UC3, new cv.Scalar(lh, ls, lv));
    this._upperMat = new cv.Mat(rows, cols, cv.CV_8UC3, new cv.Scalar(uh, us, uv));
    this._lastRows = rows;
    this._lastCols = cols;
  }

  _invalidateMats() {
    ['_lowerMat', '_upperMat'].forEach(k => {
      try { if (this[k] && !this[k].isDeleted?.()) this[k].delete(); } catch (_) {}
      this[k] = null;
    });
  }

  /** Hình học của một vùng: trục dài, hai đầu mút (top = đầu phía trên ảnh). */
  static _describe(rect, area) {
    const { center, size, angle } = rect;
    const wide  = size.width >= size.height;
    const long  = wide ? size.width  : size.height;
    const short = wide ? size.height : size.width;
    const a  = (wide ? angle : angle + 90) * Math.PI / 180;
    const ex = Math.cos(a) * long / 2, ey = Math.sin(a) * long / 2;
    const p1 = [center.x + ex, center.y + ey];
    const p2 = [center.x - ex, center.y - ey];
    const top = p1[1] <= p2[1] ? p1 : p2;
    return {
      rect, area, long, short,
      elong: long / (short + 1),
      cx: center.x, cy: center.y,
      top, bottom: top === p1 ? p2 : p1,
    };
  }

  /** 4 góc của RotatedRect (tự tính, không phụ thuộc phiên bản OpenCV.js). */
  static _rectVertices({ center, size, angle }) {
    const rad = angle * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const hw = size.width / 2, hh = size.height / 2;
    return [
      { x: center.x - cos*hw + sin*hh, y: center.y - sin*hw - cos*hh },
      { x: center.x + cos*hw + sin*hh, y: center.y + sin*hw - cos*hh },
      { x: center.x + cos*hw - sin*hh, y: center.y + sin*hw + cos*hh },
      { x: center.x - cos*hw - sin*hh, y: center.y - sin*hw + cos*hh },
    ];
  }
}
