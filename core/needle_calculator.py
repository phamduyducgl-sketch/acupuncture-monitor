"""
Tính toán các thông số châm kim:
  - Vận tốc tức thời và trung bình
  - Khoảng dịch chuyển
  - Chiều dài mũi kim đã châm vào da

Module này thuần Python/math — không phụ thuộc OpenCV hay UI.
"""

import math
from dataclasses import dataclass, field
from typing import List, Tuple


# ── Hằng số vật lý ──────────────────────────────────────────────────────────
PIXEL_TO_CM         = 0.0177   # 1 pixel = 0.0177 cm (đã calibrate với webcam gốc)
                                # Cần đo lại khi dùng camera điện thoại
FRAME_INTERVAL_S    = 0.035    # Thời gian giữa 2 khung hình (35 ms)
NEEDLE_K_PX         = 265      # Chiều dài từ tâm marker → mũi kim (pixel)
NEEDLE_D_PX         = 90       # Chiều cao hộp kim nhô lên trong khung hình (pixel)
NEEDLE_TOTAL_CM     = 5.1      # Tổng chiều dài kim (cm)
FRAME_HEIGHT_PX     = 480      # Chiều cao frame mặc định (pixel)

DIS_MIN_CM          = 0.08     # Dịch chuyển tối thiểu (< này = nhiễu)
DIS_MAX_CM          = 0.80     # Dịch chuyển tối đa (> này = lỗi)

HISTORY_SIZE        = 3        # Số mẫu vận tốc / dịch chuyển lưu lại


@dataclass
class MeasurementSnapshot:
    """Bộ thông số tại thời điểm hiển thị kết quả."""
    avg_velocity: float = 0.0          # cm/s — vận tốc trung bình
    velocity_history: List[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    distance_history: List[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    length_cm: float = 0.0             # cm — chiều dài mũi kim đã vào da
    remaining_cm: float = NEEDLE_TOTAL_CM   # cm — phần kim còn lại ngoài da
    angle_deg: int = 0                 # độ — góc châm


class NeedleCalculator:
    """
    Theo dõi chuyển động của kim và tính toán thông số châm.

    Vòng đời điển hình:
        calc = NeedleCalculator()

        # 1. Khi người dùng nhấn SET (chuẩn bị châm):
        calc.set_start(center, radian)

        # 2. Mỗi khung hình:
        calc.update(center)

        # 3. Khi người dùng nhấn DISPLAY (lấy kết quả):
        snap = calc.get_snapshot(center, angle_deg, radian)
    """

    def __init__(self, pixel_to_cm: float = PIXEL_TO_CM,
                 frame_interval_s: float = FRAME_INTERVAL_S,
                 frame_height_px: int = FRAME_HEIGHT_PX):
        self.pixel_to_cm      = pixel_to_cm
        self.frame_interval_s = frame_interval_s
        self.frame_height_px  = frame_height_px

        self._reset_state()

    # ── Public API ───────────────────────────────────────────────────────────

    def set_start(self, center: Tuple[int, int], radian: float):
        """
        Ghi nhận vị trí bắt đầu châm.
        Gọi khi người dùng nhấn nút SET.
        """
        cx, cy = center
        self._cx_start = cx
        self._cy_start = cy
        self._cx_prev  = cx
        self._cy_prev  = cy

        canh_vuong = self.frame_height_px - cy

        if radian < math.radians(35):
            # Góc nhỏ: dùng hằng số kinh nghiệm
            self._space_px = 6
        else:
            # space = L - K - D  (L, K, D đều quy ra pixel)
            L = canh_vuong / math.sin(radian)
            D = NEEDLE_D_PX / math.sin(radian)
            self._space_px = abs(round(L, 1) - NEEDLE_K_PX - round(D, 1))

        self._is_set = True

    def update(self, center: Tuple[int, int]):
        """
        Cập nhật vị trí kim mỗi khung hình.
        Tính vận tốc và dịch chuyển tức thời.
        """
        if not self._is_set:
            return

        cx, cy = center
        if cx == self._cx_prev and cy == self._cy_prev:
            return

        disp_cm = round(
            math.sqrt((cx - self._cx_prev) ** 2 + (cy - self._cy_prev) ** 2)
            * self.pixel_to_cm,
            2
        )

        if DIS_MIN_CM < disp_cm < DIS_MAX_CM:
            velocity = round(disp_cm / self.frame_interval_s, 2)

            self._distance_history[self._idx] = disp_cm
            self._velocity_history[self._idx] = velocity
            self._avg_velocity = round(sum(self._velocity_history) / HISTORY_SIZE, 2)
            self._idx = (self._idx + 1) % HISTORY_SIZE

        self._cx_prev = cx
        self._cy_prev = cy

    def get_snapshot(self, center: Tuple[int, int],
                     angle_deg: int,
                     radian: float) -> MeasurementSnapshot:
        """
        Tính toán chiều dài kim đã vào da và trả về bộ thông số đầy đủ.
        Gọi khi người dùng nhấn nút DISPLAY.
        """
        cx, cy = center
        length_cm = self._calc_length(cx, cy, radian)

        return MeasurementSnapshot(
            avg_velocity     = self._avg_velocity,
            velocity_history = self._velocity_history.copy(),
            distance_history = self._distance_history.copy(),
            length_cm        = length_cm,
            remaining_cm     = round(NEEDLE_TOTAL_CM - length_cm, 1),
            angle_deg        = angle_deg,
        )

    def reset(self):
        """Đặt lại tất cả về 0 cho ca châm mới."""
        self._reset_state()

    def set_pixel_scale(self, pixel_to_cm: float):
        """
        Cập nhật tỉ lệ pixel/cm khi dùng camera mới.
        Đo bằng cách đặt thước tham chiếu vào khung hình.
        """
        self.pixel_to_cm = pixel_to_cm

    # ── Internal ─────────────────────────────────────────────────────────────

    def _reset_state(self):
        self._cx_start = 0
        self._cy_start = 0
        self._cx_prev  = 0
        self._cy_prev  = 0
        self._space_px = 0
        self._is_set   = False

        self._velocity_history = [0.0] * HISTORY_SIZE
        self._distance_history = [0.0] * HISTORY_SIZE
        self._idx              = 0
        self._avg_velocity     = 0.0

    def _calc_length(self, cx: int, cy: int, radian: float) -> float:
        """Tính chiều dài mũi kim đã châm vào da (cm)."""
        space_cm = self._space_px * self.pixel_to_cm

        # Góc gần thẳng đứng (>75°) và cx lệch nhiều → chỉ tính theo cy
        if abs(cx - self._cx_start) > 30 and radian > math.radians(75):
            raw = math.sqrt((cy - self._cy_start) ** 2) * self.pixel_to_cm
            return round(abs(raw - space_cm) + 0.1, 1)

        # Trường hợp thông thường: kim di chuyển theo hướng xiên
        raw = math.sqrt(
            (cx - self._cx_start) ** 2 + (cy - self._cy_start) ** 2
        ) * self.pixel_to_cm
        return round(abs(raw - space_cm), 1)
