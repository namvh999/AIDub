# AI Video Translator

Chrome extension Manifest V3 dùng Gemini Live Translation để nghe âm thanh tab và phát giọng dịch gần như trực tiếp. Trên trang đã bật extension, bấm vào video đầu tiên để bắt đầu; các video tiếp theo tự phát trong cùng trang sẽ tự bắt đầu lồng tiếng. Tiếng gốc được giảm âm lượng để nghe giọng Gemini rõ hơn.

## Cài đặt và sử dụng

1. Tạo Gemini API key tại [Google AI Studio](https://aistudio.google.com/apikey). Tài khoản cần được cấp quyền dùng Gemini Live API; có thể phát sinh phí.
2. Mở `chrome://extensions` trong Chrome hoặc Chromium hỗ trợ Manifest V3 và offscreen documents.
3. Bật **Developer mode**, chọn **Load unpacked**, rồi chọn thư mục này.
4. Bấm biểu tượng extension, nhập Gemini API key lần đầu, chọn ngôn ngữ và bấm **Bật cho trang này**. Key và ngôn ngữ được lưu cục bộ để dùng lại; sau đó trang được bật sẽ tự bật lại khi tải lại cùng website trong tab đó.
5. Đóng popup rồi bấm vào video đầu tiên để bắt đầu lồng tiếng. Khi video tiếp theo bắt đầu phát trong cùng trang, extension tự bắt đầu phiên lồng tiếng mới.
6. Bấm **Dừng** trong popup để ngừng lồng tiếng và khôi phục âm thanh gốc.

Extension tự nhận diện ngôn ngữ đang nói. [Gemini Live Translation](https://ai.google.dev/gemini-api/docs/live-api/live-translate) hỗ trợ hơn 70 ngôn ngữ đích. Giọng dịch do Gemini tạo, không sao chép chính xác giọng của người nói trong video.

## Quyền riêng tư và giới hạn

- API key được lưu cục bộ trong extension và tự điền lại khi mở popup. Âm thanh của cả tab được truyền trực tiếp tới Gemini Live API của Google trong khi lồng tiếng; không được gửi tới máy chủ của dự án này.
- Chrome yêu cầu người dùng cấp quyền trên từng tab: mở popup và bấm **Bật cho trang này** một lần trên website đó, sau đó mới bấm video. Extension tự khôi phục trạng thái bật khi tải lại trang cùng website; tab mới hoặc website khác vẫn cần được bật riêng.
- Extension cần thu âm tab và truy cập được phần tử video. Trang nội bộ của trình duyệt, một số video DRM hoặc video trong iframe khác nguồn có thể không hoạt động.
- Âm thanh dịch có thể chậm hơn hình ảnh một chút; độ trễ và chất lượng phụ thuộc kết nối mạng và Gemini Live API.
- Chủ tài khoản chịu trách nhiệm về mức sử dụng và chi phí API.
