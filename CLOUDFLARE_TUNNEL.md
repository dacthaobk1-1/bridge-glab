# Cloudflare Tunnel: hiểu bản chất và cách dùng

## 1. Vấn đề tunnel giải quyết

Bạn có một server chạy trên máy mình (ví dụ proxy `localhost:3456`). Muốn người ngoài Internet truy cập được, cách truyền thống là:

- Mở port trên router (port forwarding)
- Có IP public tĩnh hoặc dùng DDNS
- Tự lo HTTPS, firewall, chống DDoS

Cách này lộ IP nhà bạn, hay bị chặn bởi nhà mạng (CGNAT), và phải mở cổng vào mạng nội bộ.

**Cloudflare Tunnel đảo chiều kết nối.** Máy bạn chủ động gọi **ra** Cloudflare, không ai gọi **vào** máy bạn.

## 2. Bản chất: kết nối đi ra (outbound-only)

```
Người dùng ──HTTPS──▶ Cloudflare Edge ◀══kết nối đi ra══ cloudflared (máy bạn) ──HTTP──▶ localhost:3456
  (Internet)          (bridge.topconsumerrank.com)         (daemon chạy nền)              (app của bạn)
```

Các bước thực tế:

1. `cloudflared` chạy trên máy bạn, mở **kết nối TCP/QUIC đi ra** tới mạng Cloudflare và giữ nó sống liên tục (thường 4 kết nối, tới 2 datacenter khác nhau).
2. Người dùng gõ `https://bridge.topconsumerrank.com`. DNS trả về IP của **Cloudflare**, không phải IP nhà bạn.
3. Cloudflare nhận request, tra xem hostname này thuộc tunnel nào, rồi đẩy request **ngược qua kết nối có sẵn** xuống `cloudflared`.
4. `cloudflared` chuyển request tới `http://localhost:3456`, nhận response, trả ngược lại theo đường cũ.

Hệ quả quan trọng:

| Điều này | Vì sao |
|---|---|
| Không cần mở port, không cần IP tĩnh | Chỉ có kết nối đi ra, nhà mạng và firewall thường cho phép |
| IP thật của bạn không bị lộ | Bên ngoài chỉ thấy IP Cloudflare |
| HTTPS có sẵn | Cloudflare giữ chứng chỉ, bạn chạy HTTP nội bộ cũng được |
| Tắt `cloudflared` là domain chết (lỗi 502/1033) | Không còn đường nào dẫn về máy bạn |
| Có sẵn chống DDoS, cache, WAF của Cloudflare | Traffic đi qua Edge trước |

## 3. Bốn thành phần phải phân biệt

Đa số lỗi người dùng gặp là do lẫn lộn 4 thứ này.

| Thành phần | Là gì | Nằm ở đâu |
|---|---|---|
| **Tunnel** | Một "đường ống" có tên và UUID (vd `flow-forward`, `fb09bb6e-...`) | Đăng ký trên Cloudflare |
| **Credentials file** | `<UUID>.json`, chìa khóa để `cloudflared` **chạy** tunnel đó | `~\.cloudflared\` |
| **cert.pem** | Chứng chỉ để **quản lý** tài khoản/zone: tạo tunnel, thêm DNS | `~\.cloudflared\cert.pem` |
| **DNS record** | CNAME `bridge` → `<UUID>.cfargotunnel.com` | Zone `topconsumerrank.com` |
| **Ingress (config.yml)** | Luật: hostname nào đi tới service local nào | Máy bạn |

### Điểm dễ nhầm nhất: credentials khác cert.pem

- **Credentials file** chỉ cho phép *chạy* tunnel. Tunnel chạy tốt dù không có cert.pem.
- **cert.pem** cho phép *thay đổi cấu hình* (tạo tunnel, `route dns`). Nó được tạo bởi `cloudflared tunnel login` và **gắn với một zone** bạn chọn lúc login.

Vì vậy, một tunnel đang chạy ổn vẫn có thể báo `Authentication error` khi chạy `route dns`, nếu cert.pem được cấp cho domain khác hoặc đã hết hạn.

## 4. Cấu hình của project này

File `config.yml`:

```yaml
tunnel: fb09bb6e-aaa7-4ba1-bff4-fac1ffb2b204
credentials-file: C:\Users\Admin\.cloudflared\fb09bb6e-aaa7-4ba1-bff4-fac1ffb2b204.json

ingress:
  - hostname: bridge.topconsumerrank.com
    service: http://localhost:3456
  - service: http_status:404
```

Đọc như sau:

- `tunnel` + `credentials-file`: chạy tunnel nào, bằng chìa khóa nào.
- `ingress`: danh sách luật, **khớp từ trên xuống**.
  - Request có Host `bridge.topconsumerrank.com` thì chuyển tới `localhost:3456`.
  - Dòng cuối (không có hostname) là luật mặc định. **Bắt buộc phải có**. Ở đây nó trả 404 cho mọi host khác.

Chạy tunnel: `npm run tunnel`, tức `cloudflared tunnel run flow-forward`.

## 5. Quy trình dựng một tunnel từ đầu

```powershell
# 1. Đăng nhập, tạo cert.pem. Trình duyệt mở ra, CHỌN ĐÚNG DOMAIN.
cloudflared tunnel login

# 2. Tạo tunnel. Sinh ra UUID và file credentials JSON.
cloudflared tunnel create my-tunnel

# 3. Trỏ DNS cho hostname vào tunnel (tạo CNAME tự động).
cloudflared tunnel route dns my-tunnel app.example.com

# 4. Viết config.yml (ingress như mục 4).

# 5. Chạy.
cloudflared tunnel run my-tunnel
```

Bước 3 làm thủ công cũng được: vào Cloudflare Dashboard → DNS → thêm bản ghi:

- Type: `CNAME`
- Name: `app`
- Target: `<UUID>.cfargotunnel.com`
- Proxy: **bật** (mây cam). Bắt buộc, vì `cfargotunnel.com` chỉ hoạt động khi đi qua proxy Cloudflare.

Cách thủ công không cần cert.pem.

## 6. Một tunnel, nhiều dịch vụ

Một tunnel phục vụ được nhiều hostname, mỗi cái trỏ một cổng:

```yaml
ingress:
  - hostname: bridge.example.com
    service: http://localhost:3456
  - hostname: router.example.com
    service: http://localhost:20128
  - service: http_status:404
```

Mỗi hostname mới cần **một bản ghi CNAME riêng**, cùng trỏ về UUID của tunnel đó. Hoặc dùng nhiều tunnel riêng, mỗi cái một config. Tunnel riêng thì dễ cô lập lỗi hơn.

## 7. Lệnh hay dùng

```powershell
cloudflared tunnel list                  # liệt kê tunnel
cloudflared tunnel info <tên>            # xem kết nối đang sống
cloudflared tunnel ingress validate      # kiểm tra cú pháp config.yml
cloudflared tunnel ingress rule https://bridge.example.com   # xem URL khớp luật nào
cloudflared tunnel delete <tên>          # xóa tunnel (phải dừng trước)
cloudflared service install              # chạy như dịch vụ Windows, tự khởi động cùng máy
```

## 8. Bảng lỗi thường gặp

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| `Authentication error` khi `route dns` | cert.pem sai zone hoặc hết hạn | `cloudflared tunnel login` lại, chọn đúng domain. Hoặc thêm CNAME tay |
| Lỗi **1033** | Tunnel không chạy | Bật lại `cloudflared tunnel run ...` |
| Lỗi **502 Bad Gateway** | Tunnel sống nhưng app local chết hoặc sai cổng | Kiểm tra app trên `localhost:<port>` |
| Lỗi **404** từ cloudflared | Hostname không khớp luật ingress nào, rơi vào luật cuối | Sửa `hostname` trong `config.yml` |
| Domain không phân giải | Chưa có CNAME, hoặc chưa bật proxy | Kiểm tra DNS, bật mây cam |
| Sửa config nhưng không có tác dụng | `cloudflared` chưa khởi động lại | Restart tiến trình |
| `tunnel run` báo thiếu credentials | Sai đường dẫn `credentials-file` | Kiểm tra file `.json` có tồn tại |

**Cách chẩn đoán nhanh theo tầng:**

1. App local sống chưa? `curl localhost:3456/health`
2. Tunnel sống chưa? `cloudflared tunnel info <tên>`
3. DNS đúng chưa? `nslookup bridge.example.com` phải ra IP Cloudflare
4. Đi qua đường public: `curl https://bridge.example.com/health`

Lỗi ở tầng nào thì sửa tầng đó, không đoán mò.

## 9. Bảo mật

- Tunnel chỉ **đưa traffic tới** app, nó **không tự xác thực** người dùng. Ai biết URL đều gọi được. Hãy giữ API key ở tầng app (project này đã dùng header `X-API-Key`).
- Muốn chặn truy cập ở tầng Cloudflare, dùng **Cloudflare Access** (đăng nhập email, SSO) hoặc WAF rules.
- File credentials `.json` và `cert.pem` là bí mật. Không commit vào git, không gửi cho người khác. Ai có credentials thì chạy được tunnel của bạn.
- Chỉ publish những cổng cần thiết trong `ingress`. Đừng trỏ tunnel vào dịch vụ nội bộ chưa có xác thực.

## 10. Tóm tắt một câu

> Tunnel = máy bạn gọi ra Cloudflare và giữ đường dây mở. Cloudflare nhận request từ Internet rồi đẩy xuống đường dây đó. Vì vậy bạn không cần mở port, không lộ IP, và có HTTPS miễn phí.
