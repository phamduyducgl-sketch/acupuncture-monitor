'use strict';

/**
 * Ghi lưu dữ liệu châm kim và xuất file CSV.
 * CSV mở được trực tiếp trong Excel (có BOM UTF-8).
 */
class DataRecorder {
  constructor() {
    this._studentId = null;
    this._records   = [];       // mỗi phần tử: [velocity, angle, length]
    this._date      = '';
  }

  /** Tạo session mới cho sinh viên. Xoá dữ liệu cũ nếu có. */
  createSession(studentId) {
    this._studentId = studentId.trim();
    this._records   = [];
    this._date      = new Date().toISOString().slice(0, 10);
  }

  /**
   * Ghi 1 lần đo.
   * @param {number} velocity  - cm/s
   * @param {number} angle     - độ
   * @param {number} length    - cm
   */
  record(velocity, angle, length) {
    if (!this._studentId) throw new Error('Chưa tạo session — gọi createSession() trước.');
    this._records.push([velocity, angle, length]);
  }

  /** Số lần đo đã ghi. */
  get count() { return this._records.length; }

  get studentId() { return this._studentId; }

  /** Trả về bản sao danh sách lần đo: [[velocity, angle, length], ...] */
  getRecords() { return this._records.map(r => [...r]); }

  /**
   * Tải file CSV về thiết bị.
   * Tên file: MSSV_YYYY-MM-DD.csv
   */
  downloadCSV() {
    if (!this._studentId) return;

    const header = ['STT', 'VELOCITY (cm/s)', 'ANGLE (deg)', 'LENGTH (cm)'];
    const rows   = this._records.map((r, i) => [i + 1, ...r]);
    const csv    = [header, ...rows].map(r => r.join(',')).join('\r\n');

    // BOM để Excel nhận UTF-8
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${this._studentId}_${this._date}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
