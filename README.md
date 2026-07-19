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

## Thông tin kết nối

| Key | Value |
|-----|-------|
| **Public URL** | `https://bridge.topconsumerrank.com` |
| **API Key** | `gSrFqVLkEzXmwTSkyjTWlre6eiKWalIyeOLxJwJ6llU` |
| **Tunnel ID** | `fb09bb6e-aaa7-4ba1-bff4-fac1ffb2b204` |
| **Proxy Port** | `3456` |
| **Image API Port** | `8765` |

> API Key đã được proxy tự inject vào mỗi request, client bên ngoài **không cần gửi key**.

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
