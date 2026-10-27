# Flow Forward - Image Generation API Proxy

Proxy server chuyển tiếp HTTP request từ internet qua Cloudflare Tunnel đến server generate ảnh chạy local.

```
Client (internet)
    ↓ HTTPS
https://bridge.topconsumerrank.com
    ↓ Cloudflare Tunnel
localhost:3456  ← flow_foward.js (proxy)
    ↓ HTTP
localhost:8765  ← Image Generation API (service khác, không thuộc project này)
```

**Tại sao cần proxy này?**
- Image API chạy local, không thể truy cập từ internet trực tiếp.
- Cloudflare Tunnel tạo kênh kết nối an toàn mà không cần mở port/firewall.
- Proxy tự động inject API key và rewrite URL trong response.

---

## Tóm tắt cài đặt trên máy mới

| Bước | Việc cần làm |
|------|-------------|
| 1 | Cài **Node.js** (LTS) — không cần `npm install` vì không có dependency |
| 2 | Cài **cloudflared** (`winget install Cloudflare.cloudflared` trên Windows) |
| 3 | Copy thư mục `flow_foward/` sang máy mới |
| 4 | Copy file credentials từ máy cũ: `C:\Users\Admin\.cloudflared\fb09bb6e-aaa7-4ba1-bff4-fac1ffb2b204.json` → đặt vào `C:\Users\<TênUser>\.cloudflared\` trên máy mới |
| 5 | Sửa `config.yml`: cập nhật `credentials-file` cho đúng đường dẫn user mới |
| 6 | Chạy 2 terminal: `node flow_foward.js` và `cloudflared tunnel --config config.yml run flow-forward` |

> **Lưu ý quan trọng nhất:** File `.json` credentials là chìa khóa để tunnel hoạt động — phải copy đúng file đó từ máy cũ. Nếu không có, xem mục **Cách B** bên dưới để tạo tunnel mới.

---

## Cài đặt trên máy mới

### Bước 1: Cài Node.js

Tải về tại https://nodejs.org — chọn bản **LTS**.

Kiểm tra sau cài:
```bash
node --version   # cần >= 14.x
```

> Project này không dùng npm package nào ngoài built-in, **không cần chạy `npm install`**.

---

### Bước 2: Cài Cloudflared

**Windows:**
```powershell
# Cách 1: Winget (khuyên dùng)
winget install --id Cloudflare.cloudflared

# Cách 2: Tải file .msi tại
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

**Linux/macOS:**
```bash
# macOS
brew install cloudflared

# Linux (Ubuntu/Debian)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
```

Kiểm tra:
```bash
cloudflared --version
```

---

### Bước 3: Copy project

Copy toàn bộ thư mục `flow_foward/` sang máy mới. Cần các file:
```
flow_foward/
├── flow_foward.js      ← proxy server (file quan trọng nhất)
├── config.yml          ← cấu hình Cloudflare Tunnel
└── package.json
```

---

### Bước 4: Cấu hình Cloudflare Tunnel credentials

Đây là bước quan trọng nhất. Có 2 cách:

#### Cách A: Dùng lại tunnel cũ (khuyên dùng — giữ nguyên domain)

1. **Từ máy cũ**, copy file credentials:
   ```
   C:\Users\Admin\.cloudflared\fb09bb6e-aaa7-4ba1-bff4-fac1ffb2b204.json
   ```

2. **Trên máy mới**, tạo thư mục và đặt file vào đúng chỗ:

   **Windows:**
   ```powershell
   mkdir C:\Users\<TênUser>\.cloudflared
   # Paste file .json vào thư mục đó
   ```

   **Linux/macOS:**
   ```bash
   mkdir -p ~/.cloudflared
   # Paste file .json vào ~/.cloudflared/
   ```

3. **Cập nhật `config.yml`** — sửa đường dẫn credentials cho đúng với máy mới:

   **Windows:**
   ```yaml
   tunnel: fb09bb6e-aaa7-4ba1-bff4-fac1ffb2b204
   credentials-file: C:\Users\<TênUser>\.cloudflared\fb09bb6e-aaa7-4ba1-bff4-fac1ffb2b204.json

   ingress:
     - hostname: bridge.topconsumerrank.com
       service: http://localhost:3456
     - service: http_status:404
   ```

   **Linux/macOS:**
   ```yaml
   tunnel: fb09bb6e-aaa7-4ba1-bff4-fac1ffb2b204
   credentials-file: /home/<TênUser>/.cloudflared/fb09bb6e-aaa7-4ba1-bff4-fac1ffb2b204.json

   ingress:
     - hostname: bridge.topconsumerrank.com
       service: http://localhost:3456
     - service: http_status:404
   ```

#### Cách B: Tạo tunnel mới (nếu không có file credentials cũ)

```bash
# Đăng nhập Cloudflare (mở browser để xác nhận)
cloudflared tunnel login

# Tạo tunnel mới
cloudflared tunnel create flow-forward

# Lệnh trên sẽ in ra tunnel ID mới, ví dụ: abc123-...
# Cập nhật config.yml với tunnel ID và credentials-file mới

# Tạo DNS record trỏ domain về tunnel
cloudflared tunnel route dns flow-forward bridge.topconsumerrank.com
```

Sau đó cập nhật `config.yml` với tunnel ID mới.

---

### Bước 5: Khởi động

Mở **2 terminal riêng biệt**:

**Terminal 1 — Proxy server:**
```bash
node flow_foward.js
```
Output mong đợi:
```
Proxy server running on port 3456
Forwarding /api/* -> http://127.0.0.1:8765
```

**Terminal 2 — Cloudflare Tunnel:**
```bash
cloudflared tunnel --config config.yml run flow-forward
```
Output mong đợi (sau vài giây):
```
...INF Connection registered connIndex=0 ...
...INF Connection registered connIndex=1 ...
```

---

### Bước 6: Kiểm tra

```bash
curl https://bridge.topconsumerrank.com/health
```

Response thành công:
```json
{"status": "ok"}
```

> Nếu báo lỗi 502, hãy đảm bảo Image API đang chạy tại `localhost:8765`.

---

## Khởi động nhanh (khi đã cài xong)

```bash
# Terminal 1
node flow_foward.js

# Terminal 2
cloudflared tunnel --config config.yml run flow-forward
```

---

## API Endpoints

### Health Check

```bash
curl https://bridge.topconsumerrank.com/health
# → {"status": "ok"}
```

### Generate ảnh (text-to-image)

```bash
curl -X POST https://bridge.topconsumerrank.com/api/image/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "a cat wearing sunglasses",
    "model": "nano_banana_2"
  }'
```

Response:
```json
{
  "task_id": "931c1e84",
  "status": "pending",
  "message": "Image task queued for processing",
  "poll_url": "/api/status/931c1e84"
}
```

### Generate ảnh với reference image

```bash
curl -X POST https://bridge.topconsumerrank.com/api/image/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "same person in a different outfit",
    "model": "nano_banana_2",
    "reference_images": ["data:image/png;base64,iVBORw0KGgo..."]
  }'
```

### Kiểm tra trạng thái task

```bash
curl https://bridge.topconsumerrank.com/api/status/{task_id}
```

Response (hoàn thành):
```json
{
  "task_id": "931c1e84",
  "status": "completed",
  "results": ["https://bridge.topconsumerrank.com/api/files/20260619_image.jpg"]
}
```

### Download ảnh

```bash
curl -o output.jpg https://bridge.topconsumerrank.com/api/files/{filename}
```

---

## Flow hoàn chỉnh (script bash)

```bash
# Bước 1: Gửi request generate
RESPONSE=$(curl -s -X POST https://bridge.topconsumerrank.com/api/image/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a cat wearing sunglasses", "model": "nano_banana_2"}')

TASK_ID=$(echo $RESPONSE | jq -r '.task_id')
echo "Task ID: $TASK_ID"

# Bước 2: Poll cho đến khi hoàn thành
while true; do
  STATUS=$(curl -s https://bridge.topconsumerrank.com/api/status/$TASK_ID)
  STATE=$(echo $STATUS | jq -r '.status')
  echo "Status: $STATE"
  if [ "$STATE" = "completed" ]; then
    FILE=$(echo $STATUS | jq -r '.results[0]' | sed 's|http://127.0.0.1:8765||')
    break
  fi
  sleep 5
done

# Bước 3: Download ảnh
curl -o result.jpg "https://bridge.topconsumerrank.com${FILE}"
echo "Saved to result.jpg"
```

---

## Xử lý lỗi thường gặp

| Lỗi | Nguyên nhân | Cách fix |
|-----|-------------|----------|
| `502 Backend unavailable` | Image API (`localhost:8765`) chưa chạy | Khởi động Image API trước |
| `cloudflared: tunnel not found` | Sai tunnel ID hoặc chưa login | Kiểm tra `config.yml`, chạy `cloudflared tunnel login` |
| `credentials file not found` | Đường dẫn file `.json` sai | Sửa `credentials-file` trong `config.yml` |
| Tunnel connect nhưng request timeout | Proxy chưa chạy (port 3456) | Khởi động `node flow_foward.js` |

---

## Cấu trúc project

```
flow_foward/
├── flow_foward.js   # Proxy server: nhận request port 3456, forward sang 8765
├── config.yml       # Cloudflare Tunnel: ánh xạ domain → localhost:3456
├── package.json     # npm metadata (không có dependencies)
└── README.md
```

**Các file không cần thiết (không copy sang máy mới):**
- `proxy.log` / `proxy.err.log` — log tự tạo khi chạy
- `test_image.jpg` — file test
- `node_modules/` — không có gì ở đây
"# bridge-glab" 

---

## Gateway v2: batch video, tracking & trace logs

### Cơ chế mới
| Vấn đề cũ | Cách xử lý |
|---|---|
| Failover nhảy qua lại giữa 2 node đều chết, không cứu được task | Health check + circuit breaker: node `down` không nhận việc, tự `up` lại khi backend sống. Khi không còn node nào sống, request **chờ/retry** (tối đa 60s với client, 15 phút với batch) thay vì fail ngay |
| Retry POST làm trùng job | POST chỉ retry khi chắc chắn chưa tới backend (`ECONNREFUSED`...). Lỗi sau khi đã gửi trả `502 upstream_failed` + `may_have_been_processed:true` |
| Gửi nhiều video cùng lúc làm backend quá tải | Hàng đợi submit theo loại (`VIDEO_SUBMIT_CONCURRENCY`=2, `IMAGE_SUBMIT_CONCURRENCY`=4, tùy chọn `VIDEO_SUBMIT_GAP_MS`, `VIDEO_MAX_ACTIVE`) |
| Poll 404 sau khi backend restart bị tính là lỗi bridge | Task gắn với backend sở hữu; 404 từ đúng backend đó => `lost` kèm giải thích |
| Không biết vì sao task fail | Bridge tự poll nền mọi task chưa xong (20s/lần) và lưu **body lỗi của backend** vào DB, kể cả khi client ngừng poll |
| `gateway.db` 1.2 GB, đầy ổ | Không lưu base64/chuỗi dài (cắt ở 2000 ký tự), không lưu mỗi lần poll `running`, WAL, trace nén gzip sau 1 ngày, cảnh báo ổ đĩa < 1 GB |

### Batch video
```bash
curl -X POST https://bridge.topconsumerrank.com/api/batch/video/generate \
  -H "Content-Type: application/json" \
  -d '{"defaults":{"model":"omni_flash"},
       "requests":[{"prompt":"cảnh 1"},{"prompt":"cảnh 2"}]}'
# -> 202 {"batch_id":"b_1a2b3c4d5e","total":2,"status_url":"/api/batch/b_1a2b3c4d5e"}

curl https://bridge.topconsumerrank.com/api/batch/b_1a2b3c4d5e            # đầy đủ
curl "https://bridge.topconsumerrank.com/api/batch/b_1a2b3c4d5e?compact=1&only=failed"
```
Tối đa 500 item/batch (`BATCH_MAX_ITEMS`). `/api/batch/image/generate` hoạt động tương tự. Mỗi item có `index`, `task_id`, `state`
(`queued | pending | running | completed | failed | lost | abandoned | submit_failed`), `error`, `request_id`; `done:true` khi mọi item đã kết thúc.
Kết quả của item `completed` nằm trong `result`. API cũ (`/api/video/generate` + `/api/status/:id`) vẫn dùng bình thường và cũng đi qua hàng đợi.

### Truy vết lỗi
Mọi response có header `X-Request-Id`. Lỗi do bridge trả JSON `{error, detail, request_id, attempts, retryable}`.
```bash
curl "http://localhost:3456/api/admin/trace?task_id=87dade1e"     # task + các request + toàn bộ trace
curl "http://localhost:3456/api/admin/trace?request_id=req_ab12"
curl "http://localhost:3456/api/admin/trace?batch_id=b_1a2b3c4d5e"
curl "http://localhost:3456/api/admin/tasks?status=failed&limit=50"
curl "http://localhost:3456/health?deep=1"                           # trạng thái backend, hàng đợi (503 nếu không có backend sống)
```
Nơi lưu log: `logs/YYYY-MM-DD.access.log`, `.err.log` (text), `logs/trace/YYYY-MM-DD.jsonl[.gz]` (từng lần gọi backend, request/response đã cắt gọn,
lỗi lưu tối đa 16 KB), và SQLite `logs/gateway.db` (bảng `requests`, `tasks`, `batch_items`).
Dashboard hiện "TASK FAILED" + lỗi thật trong cửa sổ Params.

### Biến môi trường (tùy chọn)
`PORT`, `API_KEY`, `PUBLIC_URL`, `BACKENDS_JSON`, `UPSTREAM_TIMEOUT_MS`(120000), `VIDEO_SUBMIT_CONCURRENCY`, `VIDEO_SUBMIT_GAP_MS`,
`VIDEO_MAX_ACTIVE` (0 = không giới hạn số task đang chạy), `TRACK_INTERVAL_MS`, `TRACK_MAX_AGE_MS`, `MIN_FREE_DISK_MB`, `LOG_DIR`, `DB_PATH`.

### Thu nhỏ DB cũ (một lần)
Dừng gateway rồi chạy `node scripts/compact-db.js` (1.2 GB -> ~20 MB).
