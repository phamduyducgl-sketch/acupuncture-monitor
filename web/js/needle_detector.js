'use strict';

/**
 * Phát hiện đầu kim châm cứu sơn màu xanh lá bằng OpenCV.js.
 * Port từ core/needle_detector.py — logic HSV hoàn toàn giống nhau.
 *
 * Lưu ý kênh màu:
 *   Canvas → RGBA → cv.COLOR_RGBA2BGR → BGR → cv.COLOR_BGR2HSV → HSV
 *   Ngưỡng HSV giữ nguyên từ code Python gốc.
 */

class NeedleDetector {
  /**
   * @param {object} opts
   * @param {number[]} opts.hsvLower      - [H, S, V] ngưỡng dưới (default từ code gốc)
   * @param {number[]} opts.hsvUpper      - [H, S, V] ngưỡng trên
   * @param {number}   opts.minArea       - diện tích contour tối thiểu (pixel²)
   * @param {number}   opts.dilateIter    - số lần dilate
   */
  constructor(opts = {}) {
    this.hsvLower   = opts.hsvLower   ?? [97,  73, 140];
    this.hsvUpper   = opts.hsvUpper   ?? [136, 255, 255];
    this.minArea    = opts.minArea    ?? 70;
    this.dilateIter = opts.dilateIter ?? 3;

    // Mats tái sử dụng (khởi tạo khi frame đầu tiên đến)
    this._kernel    = null;
    this._lowerMat  = null;
    this._upperMat  = null;
    this._lastRows  = 0;
    this._lastCols  = 0;
  }

  /**
   * Phát hiện kim trong 1 khung hình.
   * @param   {HTMLCanvasElement} canvas
   * @returns {{ found, center, angle, radian, area, vertices }}
   */
  detect(canvas) {
    const result = {
      found: false, center: [0, 0],
      angle: 0, radian: 0, area: 0, vertices: null
    };

    // Mats tạm — được giải phóng trong finally
    let src = null, bgr = null, blr = null,
        ero = null, dil = null, hsv = null, mask = null,
        contours = null, hierarchy = null;

    try {
      this._ensureStaticMats(canvas.height, canvas.width);

      src = cv.imread(canvas);                          // RGBA

      bgr = new cv.Mat();
      cv.cvtColor(src, bgr, cv.COLOR_RGBA2BGR);         // RGBA → BGR

      blr = new cv.Mat();
      cv.blur(bgr, blr, new cv.Size(3, 3));             // làm mờ

      ero = new cv.Mat();
      cv.erode(blr, ero, this._kernel);                  // erode

      dil = new cv.Mat();
      cv.dilate(ero, dil, this._kernel,
                new cv.Point(-1, -1), this.dilateIter); // dilate × 3

      hsv = new cv.Mat();
      cv.cvtColor(dil, hsv, cv.COLOR_BGR2HSV);          // BGR → HSV

      mask = new cv.Mat();
      cv.inRange(hsv, this._lowerMat, this._upperMat, mask); // lọc màu

      contours  = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.findContours(mask, contours, hierarchy,
                      cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);

      let maxArea = 0;
      for (let i = 0; i < contours.size(); i++) {
        const c    = contours.get(i);
        const area = cv.contourArea(c);

        if (area > this.minArea && area > maxArea) {
          maxArea = area;

          const rect = cv.minAreaRect(c);
          let   ang  = Math.round(rect.angle);
          if (rect.size.width < rect.size.height) ang = 90 - ang;

          result.found    = true;
          result.center   = [Math.round(rect.center.x), Math.round(rect.center.y)];
          result.angle    = ang;
          result.radian   = ang * Math.PI / 180;
          result.area     = area;
          result.vertices = NeedleDetector._rectVertices(rect);
        }
        c.delete();
      }

    } catch (e) {
      console.error('NeedleDetector.detect error:', e);
    } finally {
      [src, bgr, blr, ero, dil, hsv, mask, contours, hierarchy]
        .forEach(m => { try { if (m && !m.isDeleted?.()) m.delete(); } catch(_){} });
    }

    return result;
  }

  /** Cập nhật ngưỡng HSV (khi cần điều chỉnh theo camera điện thoại). */
  setHSVRange(lower, upper) {
    this.hsvLower = lower;
    this.hsvUpper = upper;
    this._invalidateMats();
  }

  /** Giải phóng Mats tĩnh khi không dùng nữa. */
  dispose() {
    this._invalidateMats();
    if (this._kernel) { this._kernel.delete(); this._kernel = null; }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /** Khởi tạo/tái tạo Mats tĩnh khi kích thước frame thay đổi. */
  _ensureStaticMats(rows, cols) {
    if (this._kernel) {
      if (this._lastRows === rows && this._lastCols === cols
          && this._lowerMat) return;   // không thay đổi
    }

    this._invalidateMats();

    this._kernel = cv.Mat.ones(3, 3, cv.CV_8U);

    const [lh, ls, lv] = this.hsvLower;
    const [uh, us, uv] = this.hsvUpper;
    // Tạo Mat kích thước frame để inRange hoạt động ổn định
    this._lowerMat = new cv.Mat(rows, cols, cv.CV_8UC3,
                                new cv.Scalar(lh, ls, lv));
    this._upperMat = new cv.Mat(rows, cols, cv.CV_8UC3,
                                new cv.Scalar(uh, us, uv));
    this._lastRows = rows;
    this._lastCols = cols;
  }

  _invalidateMats() {
    ['_lowerMat', '_upperMat'].forEach(k => {
      try { if (this[k] && !this[k].isDeleted?.()) this[k].delete(); } catch(_){}
      this[k] = null;
    });
  }

  /**
   * Tính 4 góc của RotatedRect từ tâm + kích thước + góc.
   * cv.RotatedRect.points() không ổn định trên mọi phiên bản OpenCV.js,
   * nên tự tính bằng trigonometry.
   */
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
