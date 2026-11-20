# Acupuncture Monitor — hồ sơ dự án

## Dự án này là gì
Hệ thống hỗ trợ **thực tập châm cứu** cho sinh viên Y học cổ truyền (sáng kiến cải tiến).
Camera điện thoại quay cây kim khi sinh viên châm vào mô hình da; app nhận diện kim,
đo **độ sâu, góc châm, tốc độ châm**, tự chốt kết quả và lưu lại buổi luyện tập.

## Người dùng và thiết bị
- Người dùng chính: **sinh viên**, dùng **iPhone + Safari**, mở qua **HTTPS**
  (camera không chạy được trên http hay `file://`).
- Chủ dự án là giảng viên YHCT, **không chuyên IT**:
  - Giải thích bằng tiếng Việt, ngôn ngữ đơn giản, tránh thuật ngữ khi không cần.
  - Với thay đổi lớn: trình bày kế hoạch trước, chờ duyệt rồi mới làm.
  - Nói rõ điều gì đã kiểm tra được, điều gì chưa (nhất là những gì chỉ thử được trên iPhone thật).

## Cấu trúc
| Thư mục / file | Vai trò | Trạng thái |
|---|---|---|
| `web/` | **App chính** (HTML/JS thuần, OpenCV.js tự host). Tự triển khai lên GitHub Pages khi push nhánh `main` (`.github/workflows/pages.yml`). | Đang phát triển |
| `web/js/app.js` | Điều khiển chính: camera, vòng xử lý khung hình, chốt kết quả, buổi luyện tập, giao diện | |
| `web/js/needle_detector.js` | Nhận diện kim theo **hình dạng** (không phụ thuộc màu) bằng OpenCV.js | |
| `web/js/geometry.js` | Đo độ sâu/góc bằng mô hình camera lỗ kim; có hiệu chuẩn | |
| `core/`, `APP_refactored.py` | Bản desktop Python (Tkinter + OpenCV), nhận diện đầu kim sơn xanh lá, ghi Excel theo MSSV | Bản cũ, tham khảo |
| `APP.py`, `APP_chart.py`, `keycontrol.py` | Bản gốc trên Raspberry Pi | Cũ, không theo dõi bằng git |
| `dongynso/` | Dự án khác (website Đông Y Số, Firebase) — **không liên quan** | Không đụng tới |

## Chạy thử trên máy tính
- `.claude/launch.json` có cấu hình `web`: `python3 -m http.server 8765` trong `web/`.
- Máy tính không thử được camera iPhone, đèn flash, tốc độ khung hình thật.
  Những phần đó phải nhờ chủ dự án thử trên iPhone và gửi **ảnh chụp popup thông tin kỹ thuật**
  (popup có các dòng: camera, lấy nét, đèn flash, tốc độ xử lý…).

## Quy ước
- Giao diện và chú thích trong code viết **tiếng Việt**. Thông điệp commit viết tiếng Anh (theo lịch sử hiện có).
- Không dùng `alert()` — có thể làm video camera đứng hình trên iOS Safari; dùng `notify()`.
- Cài đặt người dùng lưu trong `localStorage` qua `store` (tiền tố `acup_`), luôn bọc try/catch.
- Thông tin kỹ thuật cho người dùng đưa vào popup chi tiết, không làm rối màn hình chính.
- **Không commit dữ liệu sinh viên** (`core/data/*.xlsx`, `*.csv` đã nằm trong `.gitignore`).
- Chỉ commit khi chủ dự án yêu cầu; push lên `main` là **triển khai thật** cho sinh viên.

## Những điều đã biết
- Nhiều iPhone chỉ cho 60 khung/giây ở 720p → có chế độ `fast` (720p/60) và `hd` (1080p).
- App tự giảm độ phân giải xử lý trên máy yếu (`PROC_SCALES`).
- Đèn flash (`torch`) **bật được trên iPhone của chủ dự án** (Safari, 11/2026). Nút 🔦 cạnh nút camera
  bật/tắt, lựa chọn được nhớ. Máy không hỗ trợ thì nút mờ đi và nhắc dùng đèn bàn/LED.
- **Thiếu sáng làm camera gửi ít hình** (iPhone kéo dài thời gian chụp): "Chờ khung mới" tăng vọt dù app xử lý
  nhanh — ví dụ còn 2 khung/s. Không phải lỗi code. Mục "Chẩn đoán tốc độ đo" (bấm nhãn tốc độ, hoặc ⚙ → CHẨN ĐOÁN)
  so thời gian xử lý với thời gian chờ để chỉ ra nguyên nhân và hướng dẫn khắc phục.
- Mỗi lần sửa file trong `web/` phải tăng số `?v=` trong `index.html`, nếu không iPhone vẫn dùng bản cũ đã lưu tạm.
- Đo độ sâu dựa trên 2 giả định (ghi ở đầu `geometry.js`): kim nằm trong mặt phẳng chính diện
  với camera, và khoảng cách camera → điểm châm lấy từ hiệu chuẩn.
