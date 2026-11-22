# AI Video Translator

Chrome extension Manifest V3 dùng Gemini Live Translation để nghe âm thanh tab và phát giọng dịch gần như trực tiếp. Trên trang đã bật extension, bấm vào video đầu tiên để bắt đầu; các video tiếp theo tự phát trong cùng trang sẽ tự bắt đầu lồng tiếng. Tiếng gốc được giảm âm lượng để nghe giọng Gemini rõ hơn. Extension tự lọc một số request và phần tử quảng cáo trên các website, tự bấm nút bỏ qua quảng cáo YouTube khi nút đó xuất hiện, tích hợp bộ tải video/media mạnh mẽ cho Telegram Web, và hỗ trợ mở khóa bỏ mờ cùng tải PDF trên Studocu / Studeersnel.

## Tính năng Studocu Helper (Bỏ mờ & Tải PDF)

Extension tự động hoạt động trên các trang Studocu (`studocu.com`, `studeersnel.nl`, `studocu.vn`, `studocu.id`):
- **Bỏ mờ tài liệu (Unblur)**: Loại bỏ các lớp phủ mờ (blur), khôi phục lớp chữ (text layer) và lớp hình ảnh (figure layer) sắc nét gốc.
- **Tự động tải tất cả các trang (Auto-load pages)**: Tự động cuộn và tải trước các trang tài liệu mà không cần phải cuộn tay từng trang.
- **Xóa banner quảng cáo & giới hạn Premium**: Ẩn các banner mời nâng cấp Premium, pop-up giới hạn xem trước và sign-in wall.
- **Tải toàn bộ tài liệu dưới dạng PDF**: Tích hợp nút **Download** vào trình đọc tài liệu để gom tất cả các trang và in/lưu thành file PDF hoàn chỉnh chuẩn kích thước trang gốc.
- **Hiển thị thông báo trang bị khóa**: Với các trang bị khóa chặt từ máy chủ (*premium-locked: server không gửi lớp text cho người dùng miễn phí*), extension hiển thị bản xem trước và thông báo rõ ràng thay vì để trang trắng.

## Tính năng tải video & media Telegram

Extension tự động hỗ trợ tải phương tiện trên Telegram Web (`https://web.telegram.org/`, cả bản WebK và WebZ/WebA):
- **Tải video, GIF và ảnh**: Thêm nút tải trực tiếp vào trình phát media (MediaViewer), story và thanh điều khiển video.
- **Mở khóa tải từ kênh bị hạn chế**: Mở khóa và hiển thị lại nút tải trên các kênh/nhóm bật tính năng chặn lưu nội dung (*"Restrict saving content"*).
- **Tải tin nhắn thoại & video tròn (Circle video)**: Hỗ trợ tải voice message và video note trong chat.
- **Tải luồng mượt mà & không tràn RAM**: Sử dụng Range requests và File System Access API (`showSaveFilePicker`) để stream trực tiếp file về máy kèm thanh tiến trình phần trăm ở góc màn hình; tự động chuyển sang Blob nếu trình duyệt không hỗ trợ File System Access API.

## Cài đặt và sử dụng

1. Tạo Gemini API key tại [Google AI Studio](https://aistudio.google.com/apikey). Tài khoản cần được cấp quyền dùng Gemini Live API; có thể phát sinh phí.
2. Mở `chrome://extensions` trong Chrome hoặc Chromium hỗ trợ Manifest V3 và offscreen documents.
3. Bật **Developer mode**, chọn **Load unpacked**, rồi chọn thư mục này.
4. Bấm biểu tượng extension, nhập Gemini API key lần đầu, chọn ngôn ngữ và bấm **Bật cho trang này**. Key và ngôn ngữ được lưu cục bộ để dùng lại; sau đó trang được bật sẽ tự bật lại khi tải lại cùng website trong tab đó.
5. Đóng popup rồi bấm vào video đầu tiên để bắt đầu lồng tiếng. Khi video tiếp theo bắt đầu phát trong cùng trang, extension tự bắt đầu phiên lồng tiếng mới.
6. Bấm **Dừng** trong popup để ngừng lồng tiếng và khôi phục âm thanh gốc.

Nếu kết nối Gemini bị lỗi liên tục, extension tự tải lại trang đang bật lồng tiếng tối đa 2 lần trong 10 phút, rồi khôi phục vị trí và trạng thái phát video trước khi thử lại. Giới hạn này ngăn tải lại vô hạn; nếu vẫn lỗi, extension sẽ hiển thị thông báo.

Lọc quảng cáo tự bật trên các trang HTTP/HTTPS, kết hợp rules request cục bộ, bộ chọn DOM và trình chặn pop-up. Trình chặn pop-up chạy trong mọi trang/iframe và theo dõi tab mới trong 15 giây để xử lý cả chuỗi chuyển hướng. Popup ngoài nguồn mở từ iframe sẽ bị chặn trừ một số website phổ biến; popup do trang chính mở chỉ bị chặn khi khớp domain/quy ước quảng cáo. Website hoặc trang đang tạm dừng lọc sẽ không bị theo dõi. Bộ lọc không đảm bảo loại bỏ mọi quảng cáo và không thay thế bộ lọc chuyên biệt trên YouTube.

Trên YouTube, extension áp dụng thêm bộ lọc request và player chuyên biệt, tự bấm nút bỏ qua khi có thể. Khi YouTube đánh dấu quảng cáo đang phát trong player, extension ẩn hình quảng cáo, tắt tiếng và tăng tốc video quảng cáo, đồng thời tạm ngừng gửi âm thanh/lồng tiếng trong lúc quảng cáo; khi quảng cáo kết thúc, extension khôi phục âm lượng/tốc độ phát và tiếp tục lồng tiếng. Khi Gemini nhận diện tiếng nói gốc trùng ngôn ngữ đích, extension phát tiếng gốc ở âm lượng bình thường và bỏ qua tiếng lồng tiếng. Trạng thái lồng tiếng bình thường không hiện trên màn hình; thông báo góc màn hình chỉ xuất hiện khi có lỗi.

Extension tự nhận diện ngôn ngữ đang nói. [Gemini Live Translation](https://ai.google.dev/gemini-api/docs/live-api/live-translate) hỗ trợ hơn 70 ngôn ngữ đích. Giọng dịch do Gemini tạo, không sao chép chính xác giọng của người nói trong video.

## Quyền riêng tư và giới hạn

- API key được lưu cục bộ trong extension và tự điền lại khi mở popup. Âm thanh của cả tab được truyền trực tiếp tới Gemini Live API của Google trong khi lồng tiếng; không được gửi tới máy chủ của dự án này.
- Chrome yêu cầu người dùng cấp quyền trên từng tab: mở popup và bấm **Bật cho trang này** một lần trên website đó, sau đó mới bấm video. Extension tự khôi phục trạng thái bật khi tải lại trang cùng website; tab mới hoặc website khác vẫn cần được bật riêng.
- Extension cần thu âm tab và truy cập được phần tử video. Để lọc quảng cáo trên các website, manifest yêu cầu quyền truy cập HTTP/HTTPS. Rules được tích hợp cục bộ và không tự cập nhật từ máy chủ. Trang nội bộ của trình duyệt, một số video DRM hoặc video trong iframe khác nguồn có thể không hoạt động.
- Khi tua video, extension xóa âm thanh dịch đang chờ và kết nối lại Gemini sau khi thao tác tua ổn định; lời thoại trong khoảng kết nối lại có thể không được dịch.
- Chỉ dẫn dịch yêu cầu Gemini dùng câu nói tự nhiên, bỏ tiếng đệm và lỗi nói vấp không mang nghĩa. Chất giọng tổng hợp vẫn do Gemini Live API quyết định, extension hiện không có tùy chọn chọn giọng riêng.
- Âm thanh dịch có thể chậm hơn hình ảnh một chút; độ trễ và chất lượng phụ thuộc kết nối mạng và Gemini Live API.
- Chủ tài khoản chịu trách nhiệm về mức sử dụng và chi phí API.
