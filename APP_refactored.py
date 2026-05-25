"""
APP_refactored.py — Phiên bản desktop đã tái cấu trúc.

Chức năng giống APP.py gốc, nhưng:
  - Logic CV nằm trong core/needle_detector.py
  - Logic tính toán nằm trong core/needle_calculator.py
  - Logic lưu file nằm trong core/data_recorder.py
  - File này chỉ chứa UI (Tkinter)

Dùng để xác nhận logic hoạt động đúng trước khi chuyển sang mobile.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

import tkinter as tk
from tkinter import *
from PIL import Image, ImageTk
import cv2

from core import NeedleDetector, NeedleCalculator, DataRecorder

# ── Khởi tạo các module core ─────────────────────────────────────────────────
# use_calibration=True  → dùng ma trận calibration của webcam Raspberry Pi gốc
# use_calibration=False → dùng camera điện thoại (chưa calibrate)
detector  = NeedleDetector(use_calibration=True)
calculator = NeedleCalculator()
recorder  = DataRecorder()


# ── Tạo giao diện ────────────────────────────────────────────────────────────
def create_widgets():

    def on_set_position(event=None):
        """Nút SET — ghi nhận vị trí chuẩn bị châm."""
        result = _last_result
        if result and result.found:
            calculator.set_start(result.center, result.radian)
            root.lbl_status.config(text="OK", bg="orange")
            root.lbl_code_status.config(text="Student Code", bg="LightSteelBlue2")

    def on_display_result(event=None):
        """Nút DISPLAY — hiển thị kết quả và lưu Excel."""
        result = _last_result
        if not (result and result.found):
            return

        snap = calculator.get_snapshot(result.center, result.angle, result.radian)

        root.lbl_avg.config(text=snap.avg_velocity)
        root.lbl_v1.config(text=snap.velocity_history[0])
        root.lbl_v2.config(text=snap.velocity_history[1])
        root.lbl_v3.config(text=snap.velocity_history[2])
        root.lbl_d1.config(text=snap.distance_history[0])
        root.lbl_d2.config(text=snap.distance_history[1])
        root.lbl_d3.config(text=snap.distance_history[2])
        root.lbl_length.config(text=snap.length_cm)
        root.lbl_angle.config(text=snap.angle_deg)
        root.lbl_check.config(text=snap.remaining_cm, fg="red", bg="white")
        root.lbl_status.config(text="SET POS", bg="LightSteelBlue2")

        try:
            recorder.record(snap.avg_velocity, snap.angle_deg, snap.length_cm)
        except RuntimeError:
            pass  # Session chưa tạo — bỏ qua

    def on_save_student(event=None):
        """Nút lưu MSSV — tạo file Excel mới."""
        sid = name_var.get().strip()
        if sid:
            recorder.create_session(sid)
            calculator.reset()
            root.lbl_code_status.config(text="SAVED", bg="yellow")

    # ── Layout ───────────────────────────────────────────────────────────────
    Label(root, bg="steelblue", fg="white",
          text="Acupuncture Monitoring System (Refactored)",
          font=("Cambria", 14)).grid(row=1, column=1, columnspan=5, pady=8)

    # Khung hiển thị camera
    root.lbl_cam = Label(root, bg="steelblue", borderwidth=3, relief="groove")
    root.lbl_cam.grid(row=3, column=2, columnspan=3, rowspan=12, padx=4, pady=4)

    # Nút CAM
    root.btn_cam = Button(root, text="STOP CAM", command=stop_cam,
                          bg="LightSteelBlue2", font=("Cambria", 13), width=13)
    root.btn_cam.grid(row=2, column=2)

    # Nhập MSSV
    root.lbl_code_status = Label(root, text="Student Code",
                                 bg="LightSteelBlue2", font=("Cambria", 14), width=13)
    root.lbl_code_status.grid(row=2, column=1)
    Entry(root, textvariable=name_var, font=("Cambria", 14), width=13).grid(row=3, column=1)

    # Trạng thái SET
    root.lbl_status = Label(root, text="SET POS",
                             bg="#676767", font=("Cambria", 13), width=14)
    root.lbl_status.grid(row=2, column=3)

    # Phím tắt (giữ tương thích với code gốc)
    root.bind("<KP_Next>",  on_set_position)     # PAGE-DOWN
    root.bind("<KP_Enter>", on_display_result)   # ENTER numpad
    root.bind("<KP_Down>",  on_save_student)     # Mũi tên xuống numpad
    # Thêm phím thay thế dễ dùng hơn
    root.bind("<s>", on_set_position)
    root.bind("<d>", on_display_result)
    root.bind("<Return>", on_save_student)

    # ── Thông số hiển thị ────────────────────────────────────────────────────
    def _make_pair(label_text, row, col, bg_label="#f45c29", w=14):
        Label(root, bg=bg_label, fg="black", text=label_text,
              font=("Cambria", 12), width=w).grid(row=row, column=col, pady=1)
        lbl = Label(root, bg="white", fg="red", text="—",
                    font=("Cambria", 14), width=w)
        lbl.grid(row=row+1, column=col, pady=1)
        return lbl

    root.lbl_avg    = _make_pair("AVERAGE (cm/s)", 4, 2)
    root.lbl_length = _make_pair("LENGTH (cm)",    4, 3)
    root.lbl_angle  = _make_pair("ANGLE (Deg)",    4, 4)

    root.lbl_check  = _make_pair("CHECKING (cm)", 6, 1, bg_label="#68cbf8", w=16)

    Label(root, bg="#68cbf8", fg="black", text="VELOCITY (cm/s):",
          font=("Cambria", 11), width=16).grid(row=8, column=1)
    root.lbl_v1 = Label(root, bg="white", fg="black", text="—", font=("Cambria", 11), width=16)
    root.lbl_v1.grid(row=9, column=1)
    root.lbl_v2 = Label(root, bg="white", fg="black", text="—", font=("Cambria", 11), width=16)
    root.lbl_v2.grid(row=10, column=1)
    root.lbl_v3 = Label(root, bg="white", fg="black", text="—", font=("Cambria", 11), width=16)
    root.lbl_v3.grid(row=11, column=1)

    Label(root, bg="#68cbf8", fg="black", text="DISPLACE. (cm):",
          font=("Cambria", 11), width=16).grid(row=12, column=1)
    root.lbl_d1 = Label(root, bg="white", fg="black", text="—", font=("Cambria", 11), width=16)
    root.lbl_d1.grid(row=13, column=1)
    root.lbl_d2 = Label(root, bg="white", fg="black", text="—", font=("Cambria", 11), width=16)
    root.lbl_d2.grid(row=14, column=1)
    root.lbl_d3 = Label(root, bg="white", fg="black", text="—", font=("Cambria", 11), width=16)
    root.lbl_d3.grid(row=15, column=1)


# ── Camera loop ───────────────────────────────────────────────────────────────
_last_result = None   # Kết quả detect gần nhất — dùng chung với event handlers

def show_feed():
    global _last_result
    ret, frame = root.cap.read()
    if not ret:
        root.lbl_cam.configure(image="")
        return

    result = detector.detect(frame)
    _last_result = result

    if result.found:
        calculator.update(result.center)

    # Hiển thị frame đã annotate
    rgb = cv2.cvtColor(result.annotated_frame, cv2.COLOR_BGR2RGBA)
    img = ImageTk.PhotoImage(image=Image.fromarray(rgb))
    root.lbl_cam.configure(image=img)
    root.lbl_cam.imgtk = img

    root.lbl_cam.after(35, show_feed)


def stop_cam():
    root.cap.release()
    root.btn_cam.config(text="START CAM", command=start_cam)
    root.lbl_cam.config(text="OFF CAM", font=("Cambria", 50))


def start_cam():
    root.cap = cv2.VideoCapture(0)
    root.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    root.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    root.btn_cam.config(text="STOP CAM", command=stop_cam)
    root.lbl_cam.config(text="")
    show_feed()


# ── Khởi chạy ────────────────────────────────────────────────────────────────
root = tk.Tk()
root.title("Acupuncture Monitoring System — Refactored")
root.geometry("900x800")
root.configure(background="#676767")
root.resizable(True, True)

name_var = StringVar()

root.cap = cv2.VideoCapture(0)
root.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
root.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

create_widgets()
show_feed()
root.mainloop()
