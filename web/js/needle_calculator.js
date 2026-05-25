'use strict';

/**
 * Tính toán thông số châm kim.
 * Port 1-1 từ core/needle_calculator.py — không phụ thuộc OpenCV.
 */

const PIXEL_TO_CM      = 0.0177;  // Cần calibrate lại với camera điện thoại
const FRAME_INTERVAL_S = 0.035;   // 35ms/frame
const NEEDLE_K_PX      = 265;     // Chiều dài kim từ tâm marker → mũi (pixel)
const NEEDLE_D_PX      = 90;      // Chiều cao hộp kim nhô lên (pixel)
const NEEDLE_TOTAL_CM  = 5.1;     // Tổng chiều dài kim (cm)
const DIS_MIN_CM       = 0.08;    // Dịch chuyển tối thiểu (nhiễu nếu nhỏ hơn)
const DIS_MAX_CM       = 0.80;    // Dịch chuyển tối đa (lỗi nếu lớn hơn)
const HISTORY_SIZE     = 3;

class NeedleCalculator {
  constructor(pixelToCm = PIXEL_TO_CM, frameInterval = FRAME_INTERVAL_S) {
    this.pixelToCm     = pixelToCm;
    this.frameInterval = frameInterval;
    this._reset();
  }

  /**
   * Ghi nhận vị trí bắt đầu châm.
   * @param {[number,number]} center  - [cx, cy] pixel
   * @param {number}          radian  - góc châm (radian)
   * @param {number}          frameH  - chiều cao frame (pixel), mặc định 480
   */
  setStart(center, radian, frameH = 480) {
    const [cx, cy] = center;
    this._cxStart = cx;
    this._cyStart = cy;
    this._cxPrev  = cx;
    this._cyPrev  = cy;

    const canhVuong = frameH - cy;

    if (radian < 35 * Math.PI / 180) {
      this._spacePx = 6;
    } else {
      const L = canhVuong / Math.sin(radian);
      const D = NEEDLE_D_PX / Math.sin(radian);
      this._spacePx = Math.abs(Math.round(L * 10) / 10 - NEEDLE_K_PX - Math.round(D * 10) / 10);
    }

    this._isSet = true;
  }

  /**
   * Cập nhật vị trí mỗi khung hình — gọi liên tục trong camera loop.
   * @param {[number,number]} center
   */
  update(center) {
    if (!this._isSet) return;

    const [cx, cy] = center;
    if (cx === this._cxPrev && cy === this._cyPrev) return;

    const disp = this._round2(
      Math.sqrt((cx - this._cxPrev) ** 2 + (cy - this._cyPrev) ** 2) * this.pixelToCm
    );

    if (disp > DIS_MIN_CM && disp < DIS_MAX_CM) {
      const vel = this._round2(disp / this.frameInterval);
      this._distHist[this._idx] = disp;
      this._velHist[this._idx]  = vel;
      this._avgVel = this._round2(this._velHist.reduce((a, b) => a + b, 0) / HISTORY_SIZE);
      this._idx = (this._idx + 1) % HISTORY_SIZE;
    }

    this._cxPrev = cx;
    this._cyPrev = cy;
  }

  /**
   * Trả về bộ thông số tại thời điểm DISPLAY.
   * @param {[number,number]} center
   * @param {number}          angleDeg
   * @param {number}          radian
   * @returns {object}
   */
  getSnapshot(center, angleDeg, radian) {
    const [cx, cy] = center;
    const len = this._calcLength(cx, cy, radian);
    return {
      avgVelocity:     this._avgVel,
      velocityHistory: [...this._velHist],
      distanceHistory: [...this._distHist],
      lengthCm:        len,
      remainingCm:     this._round1(NEEDLE_TOTAL_CM - len),
      angleDeg:        angleDeg,
    };
  }

  reset() { this._reset(); }

  /** Cập nhật tỉ lệ pixel/cm khi dùng camera khác. */
  setPixelScale(pixelToCm) { this.pixelToCm = pixelToCm; }

  // ── Private ──────────────────────────────────────────────────────────────

  _reset() {
    this._cxStart = 0; this._cyStart = 0;
    this._cxPrev  = 0; this._cyPrev  = 0;
    this._spacePx = 0; this._isSet   = false;
    this._velHist  = [0, 0, 0];
    this._distHist = [0, 0, 0];
    this._idx    = 0;
    this._avgVel = 0;
  }

  _calcLength(cx, cy, radian) {
    const spaceCm = this._spacePx * this.pixelToCm;

    // Góc gần thẳng đứng + lệch cx nhiều → chỉ tính theo cy
    if (Math.abs(cx - this._cxStart) > 30 && radian > 75 * Math.PI / 180) {
      const raw = Math.sqrt((cy - this._cyStart) ** 2) * this.pixelToCm;
      return this._round1(Math.abs(raw - spaceCm) + 0.1);
    }

    const raw = Math.sqrt(
      (cx - this._cxStart) ** 2 + (cy - this._cyStart) ** 2
    ) * this.pixelToCm;
    return this._round1(Math.abs(raw - spaceCm));
  }

  _round2(v) { return Math.round(v * 100) / 100; }
  _round1(v) { return Math.round(v * 10)  / 10;  }
}
