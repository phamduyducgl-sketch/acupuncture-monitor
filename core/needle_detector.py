"""
Phát hiện đầu kim châm cứu được sơn màu xanh lá.
Module này độc lập với UI — dùng được trên desktop lẫn mobile.
"""

import cv2
import numpy as np
import imutils
import math


# ── Thông số camera calibration (Raspberry Pi webcam gốc) ──────────────────
# Khi dùng camera điện thoại: bỏ qua undistort hoặc calibrate lại
_CAMERA_MATRIX = np.array([
    [936.37183128,   0.0,         493.07464865],
    [  0.0,         937.43778885,  93.18820841],
    [  0.0,           0.0,           1.0      ]
])
_DIST_COEFFS = np.array([[0.0171085, -0.18085887, 0.01305453, -0.01131838, 0.20937844]])

# ── Thông số lọc màu HSV (xanh lá) ────────────────────────────────────────
# Điều chỉnh nếu camera điện thoại cho ra màu sắc khác
HSV_LOWER = np.array([97,  73, 140])
HSV_UPPER = np.array([136, 255, 255])

# Diện tích contour tối thiểu (pixel²) để xác nhận là đầu kim
MIN_CONTOUR_AREA = 70

_KERNEL = np.ones((3, 3), np.uint8)


class DetectionResult:
    """Kết quả nhận diện cho 1 khung hình."""

    def __init__(self):
        self.found: bool = False
        self.center: tuple = (0, 0)   # (cx, cy) pixel
        self.angle: int = 0           # Degrees 0–90
        self.radian: float = 0.0      # Radians
        self.area: float = 0.0        # Diện tích contour
        self.annotated_frame = None   # Frame BGR đã vẽ bounding box

    def __repr__(self):
        if self.found:
            return f"<DetectionResult found center={self.center} angle={self.angle}°>"
        return "<DetectionResult not_found>"


class NeedleDetector:
    """
    Phát hiện đầu kim châm cứu sơn xanh lá trong 1 khung hình.

    Sử dụng:
        detector = NeedleDetector()
        result = detector.detect(frame)
        if result.found:
            print(result.center, result.angle)
    """

    def __init__(self,
                 use_calibration: bool = True,
                 hsv_lower=None,
                 hsv_upper=None,
                 min_area: int = MIN_CONTOUR_AREA):
        """
        Args:
            use_calibration: Dùng undistort hay không.
                             False khi dùng camera điện thoại chưa calibrate.
            hsv_lower: Ghi đè ngưỡng HSV dưới.
            hsv_upper: Ghi đè ngưỡng HSV trên.
            min_area:  Diện tích tối thiểu để nhận dạng là đầu kim.
        """
        self.use_calibration = use_calibration
        self.lower = hsv_lower if hsv_lower is not None else HSV_LOWER.copy()
        self.upper = hsv_upper if hsv_upper is not None else HSV_UPPER.copy()
        self.min_area = min_area

    # ── Public API ──────────────────────────────────────────────────────────

    def detect(self, frame) -> DetectionResult:
        """
        Nhận diện đầu kim trong frame BGR.

        Trả về DetectionResult (luôn có annotated_frame dù không tìm thấy kim).
        """
        result = DetectionResult()

        dst = self._preprocess(frame)
        result.annotated_frame = dst.copy()

        hsv = cv2.cvtColor(dst, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, self.lower, self.upper)

        contours = cv2.findContours(mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
        contours = imutils.grab_contours(contours)

        best_area = 0
        for c in contours:
            area = cv2.contourArea(c)
            if area < self.min_area or area <= best_area:
                continue
            best_area = area

            rect = cv2.minAreaRect(c)
            box = cv2.boxPoints(rect)
            box = np.int0(box)

            cx = int(rect[0][0])
            cy = int(rect[0][1])
            w  = int(rect[1][0])
            h  = int(rect[1][1])
            ang = int(rect[2])

            # Chuẩn hóa góc về 0–90° (không phân biệt nghiêng trái/phải)
            if w < h:
                ang = 90 - ang

            cv2.drawContours(result.annotated_frame, [box], 0, (0, 0, 255), 2)

            result.found  = True
            result.center = (cx, cy)
            result.angle  = ang
            result.radian = math.radians(ang)
            result.area   = area

        return result

    def set_hsv_range(self, lower, upper):
        """Cập nhật ngưỡng màu HSV (dùng khi camera điện thoại cần hiệu chỉnh)."""
        self.lower = np.array(lower)
        self.upper = np.array(upper)

    # ── Internal ────────────────────────────────────────────────────────────

    def _preprocess(self, frame):
        """Undistort (tuỳ chọn) + blur + erode + dilate."""
        if self.use_calibration:
            h, w = frame.shape[:2]
            new_mat, _ = cv2.getOptimalNewCameraMatrix(
                _CAMERA_MATRIX, _DIST_COEFFS, (w, h), 1, (w, h)
            )
            dst = cv2.undistort(frame, _CAMERA_MATRIX, _DIST_COEFFS, None, new_mat)
        else:
            dst = frame.copy()

        blurred = cv2.blur(dst, (3, 3))
        eroded  = cv2.erode(blurred, (3, 3))
        dilated = cv2.dilate(eroded, _KERNEL, iterations=3)
        return dilated
