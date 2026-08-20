# แอปพลิเคชันแปลภาษาการ์ตูน Manga (Manga Thai Translator)

แอปพลิเคชัน Flutter สำหรับสแกนข้อความภาษาต่างประเทศ (เช่น ภาษาญี่ปุ่น/ภาษาอังกฤษ) บนภาพการ์ตูน Manga แล้วแปลเป็นภาษาไทย โดยนำข้อความแปลมาวางปิดทับลงบนตำแหน่งช่องคำพูดเดิม ฟรี 100% ด้วย **Google ML Kit** บนตัวเครื่อง (On-Device)

---

## 🌟 ฟีเจอร์หลัก (Features)
1. **เลือกรูปภาพ Manga (Image Picker):** เลือกภาพการ์ตูน Manga จากในเครื่องได้ง่ายดาย
2. **เลือกภาษาต้นทาง (Source Language Selector):** รองรับการสแกน OCR ทั้ง **ภาษาญี่ปุ่น 🇯🇵** (`TextRecognitionScript.japanese`) และ **ภาษาอังกฤษ 🇺🇸** (`TextRecognitionScript.latin`)
3. **แปลภาษาฟรี 100% (On-Device Translation):** ประมวลผลแปลเป็นภาษาไทยบนตัวเครื่อง ไม่ต้องพึ่งพา API แบบชำระเงิน และสามารถใช้ออฟไลน์ได้เมื่อดาวน์โหลดโมเดลภาษาในเครื่องแล้ว
4. **วางข้อความแปลทับตำแหน่งเดิม (Text Overlay):** สร้างกล่องสีขาวปิดทับข้อความเดิมตามพิกัด Bounding Box และแสดงผลข้อความภาษาไทยสีดำ
5. **รองรับ Zoom / Pan:** สามารถย่อ-ขยายภาพ และเลื่อนดูส่วนต่างๆ ของ Manga ได้อย่างสะดวกลื่นไหลผ่าน `InteractiveViewer`

---

## 🛠️ โครงสร้างโปรเจกต์ (Project Structure)
```text
manga_translator/
├── lib/
│   └── main.dart                   # โค้ดหลักของแอปพลิเคชัน (UI, OCR, Translation, Overlay)
├── android/
│   └── app/
│       └── build.gradle.kts        # กำหนด minSdk = 21 สำหรับ Google ML Kit
├── pubspec.yaml                    # กำหนด Dependencies (image_picker, google_mlkit, etc.)
└── README.md                       # คู่มือการติดตั้งและทดสอบ
```

---

## 📋 ความต้องการของระบบ (Prerequisites)
- **Flutter SDK:** เวอร์ชั่น 3.10.0 ขึ้นไป
- **Dart SDK:** เวอร์ชั่น 3.0.0 ขึ้นไป
- **Android Studio / VS Code:** พร้อมปลั๊กอิน Flutter & Dart
- **Android Device หรือ Emulator:** Android 5.0 (API Level 21) ขึ้นไป

---

## 🚀 ขั้นตอนการติดตั้งและการลงเครื่องเปิดทดสอบ (Step-by-Step Setup)

### ขั้นตอนที่ 1: ติดตั้ง Dependencies
เปิด Terminal ในโฟลเดอร์โปรเจกต์ แล้วรันคำสั่ง:
```bash
flutter pub get
```

### ขั้นตอนที่ 2: ตรวจสอบการตั้งค่า Android (minSdk)
Google ML Kit ต้องการ Android `minSdkVersion` ขั้นต่ำอยู่ที่ **21**
ซึ่งได้ทำการกำหนดไว้แล้วในไฟล์ `android/app/build.gradle.kts`:
```kotlin
defaultConfig {
    applicationId = "com.example.manga_translator"
    minSdk = 21
    targetSdk = flutter.targetSdkVersion
    versionCode = flutter.versionCode
    versionName = flutter.versionName
}
```

### ขั้นตอนที่ 3: เปิดทดสอบแอปพลิเคชัน (Run App)
1. ต่อสาย USB เชื่อมต่อโทรศัพท์ Android (เปิดโหมด USB Debugging) หรือเปิด Android Emulator
2. ตรวจสอบว่า Flutter มองเห็นอุปกรณ์ด้วยคำสั่ง:
   ```bash
   flutter devices
   ```
3. สั่งรันแอปพลิเคชันลงบนเครื่อง:
   ```bash
   flutter run
   ```

---

## 📱 วิธีการใช้งานแอปพลิเคชัน (How to Use)
1. เปิดแอป **Manga Thai Translator**
2. เลือกภาษาต้นทางตรงแถบด้านบน: **ภาษาญี่ปุ่น** หรือ **ภาษาอังกฤษ**
3. กดปุ่ม **"เลือกรูปภาพ Manga"** ด้านล่างขวา เพื่อเลือกภาพการ์ตูนจากคลังภาพในเครื่อง
4. แอปจะทำการสแกนข้อความบนภาพอัตโนมัติ (หากเป็นการใช้งานครั้งแรก ML Kit จะทำการดาวน์โหลดโมเดลภาษาในเครื่องสั้นๆ)
5. เมื่อแปลเสร็จเรียบร้อย ข้อความภาษาไทยจะถูกวางทับลงบนช่องคำพูดเดิม
6. สามารถใช้สองนิ้ว **จีบนิ้วย่อ-ขยาย (Zoom)** หรือ **ลากเลื่อนภาพ (Pan)** เพื่ออ่าน Manga ได้ชัดเจนขึ้น

---

## 📦 Packages ที่ใช้งาน (Dependencies)
- [`image_picker`](https://pub.dev/packages/image_picker): สำหรับเปิด Gallery เลือกรูปภาพ
- [`google_mlkit_text_recognition`](https://pub.dev/packages/google_mlkit_text_recognition): สำหรับสแกนข้อความ OCR (รองรับภาษาญี่ปุ่น และ ละติน/อังกฤษ)
- [`google_mlkit_translation`](https://pub.dev/packages/google_mlkit_translation): สำหรับแปลภาษา On-device ฟรี 100%
