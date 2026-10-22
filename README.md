# DK FASHION — nâng cấp trên nhánh `backend-foundation`

Gói này giữ `index.html` hiện có làm nền tảng, không thay tên miền `fashionstore.id.vn`, không triển khai hosting và không thay đổi nhánh `main`.

## Đã nâng cấp trong giao diện
- Giỏ hàng được lưu ở trình duyệt; số lượng tăng/giảm và xóa sản phẩm.
- Trang chủ có banner lớn, thiết kế responsive cho điện thoại và máy tính.
- 8 sản phẩm mẫu có hình ảnh từ CDN ảnh bên ngoài, giá niêm yết/giá ưu đãi và nhãn sản phẩm.
- Tìm kiếm theo tên/danh mục/đối tượng; lọc danh mục; sắp xếp giá tăng/giảm.
- Trang chi tiết sản phẩm dạng modal, chọn cỡ giày và thêm vào giỏ.
- Giỏ hàng lưu ở trình duyệt; tăng/giảm số lượng, xóa sản phẩm và tính tổng tiền.
- Danh sách yêu thích được lưu ở trình duyệt; có thể mở danh sách đã lưu.
- Biểu mẫu đặt hàng COD gửi đến API khi backend và PostgreSQL đã cấu hình.
- Frontend gửi đơn tới `POST /api/v1/orders`. API kiểm tra dữ liệu, lấy giá từ database (không tin giá do trình duyệt gửi), khóa tồn kho và ghi đơn hàng trong transaction.

## Cấu trúc
- `index.html`: giao diện gốc được nâng cấp.
- `backend/src/server.js`: API Express.
- `backend/db/schema.sql`: bảng PostgreSQL và 4 sản phẩm mẫu.
- `backend/.env.example`: mẫu cấu hình, không chứa thông tin đăng nhập thật.

## Chạy backend
1. Cài Node.js 20 trở lên.
2. Trong thư mục `backend`, chạy `npm install`.
3. Tạo file `backend/.env` từ `.env.example`, điền `DATABASE_URL` của PostgreSQL riêng của bạn.
4. Chạy nội dung `backend/db/schema.sql` trong PostgreSQL của bạn.
5. Chạy `npm start`.
6. Kiểm tra `http://localhost:3000/api/v1/health`.

`DATABASE_URL` chỉ đặt trong `.env` cục bộ; không commit file `.env`. Không dùng thông tin kết nối giả làm thông tin thật.

## Giới hạn cần biết
- Ảnh hiện lấy từ Unsplash CDN nên cần internet; nếu nhà cung cấp ảnh thay đổi URL hoặc mạng chặn CDN, ảnh có thể không tải.
- Đây là dữ liệu demo, không phải danh mục/tồn kho thật của cửa hàng. Hãy thay ảnh, mô tả, giá và sản phẩm trước khi bán hàng thật.
- Chức năng đăng nhập, quản trị, tra cứu đơn, vận chuyển, email và thanh toán trực tuyến chưa được triển khai.
- Chưa chạy kiểm thử trình duyệt end-to-end; đã kiểm tra cú pháp JavaScript giao diện và Node.js backend.

## Lưu ý quan trọng
- Gói này chưa tự động triển khai lên tên miền/hosting.
- API sản phẩm và đặt hàng yêu cầu PostgreSQL đã được cấu hình và schema đã được chạy.
- Chưa có trang quản trị được bảo vệ bằng đăng nhập; không nên đưa API quản trị công khai trước khi bổ sung xác thực và phân quyền.
- Giao diện hiện giữ danh sách sản phẩm tĩnh; bước tích hợp tiếp theo là tải danh sách từ `GET /api/v1/products` và thiết lập đường dẫn API phù hợp khi triển khai.
