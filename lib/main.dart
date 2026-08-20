import 'dart:io';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:google_mlkit_text_recognition/google_mlkit_text_recognition.dart';
import 'package:google_mlkit_translation/google_mlkit_translation.dart';

void main() {
  runApp(const MangaTranslatorApp());
}

class MangaTranslatorApp extends StatelessWidget {
  const MangaTranslatorApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Manga Thai Translator',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.deepPurple),
        useMaterial3: true,
      ),
      home: const MangaTranslatorHomePage(),
    );
  }
}

enum SourceLanguage {
  japanese('ภาษาญี่ปุ่น', TextRecognitionScript.japanese, TranslateLanguage.japanese),
  english('ภาษาอังกฤษ', TextRecognitionScript.latin, TranslateLanguage.english);

  final String label;
  final TextRecognitionScript script;
  final TranslateLanguage translateLanguage;

  const SourceLanguage(this.label, this.script, this.translateLanguage);
}

class TranslatedBlock {
  final Rect boundingBox;
  final String originalText;
  final String translatedText;

  TranslatedBlock({
    required this.boundingBox,
    required this.originalText,
    required this.translatedText,
  });
}

class MangaTranslatorHomePage extends StatefulWidget {
  const MangaTranslatorHomePage({super.key});

  @override
  State<MangaTranslatorHomePage> createState() => _MangaTranslatorHomePageState();
}

class _MangaTranslatorHomePageState extends State<MangaTranslatorHomePage> {
  final ImagePicker _picker = ImagePicker();

  File? _selectedImage;
  Size? _imageSize; // ความกว้างและความสูงจริงของรูปภาพ
  SourceLanguage _selectedLanguage = SourceLanguage.japanese;

  bool _isProcessing = false;
  String _statusMessage = '';
  List<TranslatedBlock> _translatedBlocks = [];

  // เลือกรูปภาพจากเครื่อง
  Future<void> _pickImage() async {
    try {
      final XFile? pickedFile = await _picker.pickImage(source: ImageSource.gallery);
      if (pickedFile == null) return;

      final File imageFile = File(pickedFile.path);

      // อ่านขนาดพิกเซลจริงของรูปภาพ
      final bytes = await imageFile.readAsBytes();
      final decodedImage = await decodeImageFromList(bytes);

      setState(() {
        _selectedImage = imageFile;
        _imageSize = Size(decodedImage.width.toDouble(), decodedImage.height.toDouble());
        _translatedBlocks = [];
      });

      // สแกนและแปลภาษาอัตโนมัติเมื่อเลือกรูปภาพ
      await _processImage();
    } catch (e) {
      _showErrorSnackBar('เกิดข้อผิดพลาดในการเลือกรูปภาพ: $e');
    }
  }

  // ประมวลผลสแกน OCR และแปลภาษา
  Future<void> _processImage() async {
    if (_selectedImage == null) return;

    setState(() {
      _isProcessing = true;
      _statusMessage = 'กำลังสแกนข้อความบนภาพ (OCR)...';
      _translatedBlocks = [];
    });

    TextRecognizer? textRecognizer;
    OnDeviceTranslator? translator;

    try {
      // 1. สร้าง Text Recognizer ตามภาษาต้นทางที่เลือก (ญี่ปุ่น/อังกฤษ)
      textRecognizer = TextRecognizer(script: _selectedLanguage.script);
      final inputImage = InputImage.fromFile(_selectedImage!);
      final RecognizedText recognizedText = await textRecognizer.processImage(inputImage);

      if (recognizedText.blocks.isEmpty) {
        setState(() {
          _isProcessing = false;
          _statusMessage = 'ไม่พบข้อความในรูปภาพ';
        });
        return;
      }

      // 2. จัดเตรียม On-Device Translator ของ Google ML Kit
      setState(() {
        _statusMessage = 'กำลังเตรียมโมเดลแปลภาษาไทย...';
      });

      final modelManager = OnDeviceTranslatorModelManager();
      // ตรวจสอบและดาวน์โหลดโมเดลภาษาถ้ายังไม่มีในเครื่อง
      final isSourceDownloaded = await modelManager.isModelDownloaded(_selectedLanguage.translateLanguage.bcpCode);
      if (!isSourceDownloaded) {
        setState(() {
          _statusMessage = 'กำลังดาวน์โหลดโมเดล ${_selectedLanguage.label}...';
        });
        await modelManager.downloadModel(_selectedLanguage.translateLanguage.bcpCode);
      }

      final isThaiDownloaded = await modelManager.isModelDownloaded(TranslateLanguage.thai.bcpCode);
      if (!isThaiDownloaded) {
        setState(() {
          _statusMessage = 'กำลังดาวน์โหลดโมเดลภาษาไทย...';
        });
        await modelManager.downloadModel(TranslateLanguage.thai.bcpCode);
      }

      translator = OnDeviceTranslator(
        sourceLanguage: _selectedLanguage.translateLanguage,
        targetLanguage: TranslateLanguage.thai,
      );

      setState(() {
        _statusMessage = 'กำลังแปลภาษาไทย...';
      });

      List<TranslatedBlock> blocks = [];

      // 3. แปลข้อความแต่ละบล็อก
      for (final block in recognizedText.blocks) {
        final text = block.text.trim();
        if (text.isEmpty) continue;

        final translatedText = await translator.translateText(text);

        blocks.add(
          TranslatedBlock(
            boundingBox: block.boundingBox,
            originalText: text,
            translatedText: translatedText,
          ),
        );
      }

      setState(() {
        _translatedBlocks = blocks;
        _statusMessage = 'แปลสำเร็จเรียบร้อย (${blocks.length} จุด)';
      });
    } catch (e) {
      _showErrorSnackBar('เกิดข้อผิดพลาดในการแปลภาษา: $e');
      setState(() {
        _statusMessage = 'เกิดข้อผิดพลาดในการประมวลผล';
      });
    } finally {
      textRecognizer?.close();
      translator?.close();
      setState(() {
        _isProcessing = false;
      });
    }
  }

  void _showErrorSnackBar(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: Colors.red),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('แปลภาษา Manga ไทย'),
        centerTitle: true,
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
      ),
      body: Column(
        children: [
          // แถบควบคุมภาษาต้นทาง
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 8.0),
            color: Colors.grey.shade100,
            child: Row(
              children: [
                const Text(
                  'ภาษาต้นทาง: ',
                  style: TextStyle(fontWeight: FontWeight.bold),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: SegmentedButton<SourceLanguage>(
                    segments: const [
                      ButtonSegment<SourceLanguage>(
                        value: SourceLanguage.japanese,
                        label: Text('ภาษาญี่ปุ่น 🇯🇵'),
                      ),
                      ButtonSegment<SourceLanguage>(
                        value: SourceLanguage.english,
                        label: Text('ภาษาอังกฤษ 🇺🇸'),
                      ),
                    ],
                    selected: {_selectedLanguage},
                    onSelectionChanged: (Set<SourceLanguage> newSelection) {
                      setState(() {
                        _selectedLanguage = newSelection.first;
                      });
                      if (_selectedImage != null) {
                        _processImage();
                      }
                    },
                  ),
                ),
              ],
            ),
          ),

          // แสดงสถานะการทำงาน
          if (_statusMessage.isNotEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6.0, horizontal: 16.0),
              child: Row(
                children: [
                  if (_isProcessing)
                    const Padding(
                      padding: EdgeInsets.only(right: 8.0),
                      child: SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    ),
                  Expanded(
                    child: Text(
                      _statusMessage,
                      style: TextStyle(
                        fontSize: 13,
                        color: _isProcessing ? Colors.deepPurple : Colors.grey.shade700,
                        fontWeight: _isProcessing ? FontWeight.bold : FontWeight.normal,
                      ),
                    ),
                  ),
                ],
              ),
            ),

          // พื้นที่แสดงภาพ Manga และข้อความแปลทับ
          Expanded(
            child: _selectedImage == null
                ? Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(
                          Icons.image_search,
                          size: 80,
                          color: Colors.grey.shade400,
                        ),
                        const SizedBox(height: 16),
                        Text(
                          'กรุณากดปุ่มด้านล่างเพื่อเลือกรูปภาพ Manga',
                          style: TextStyle(fontSize: 16, color: Colors.grey.shade600),
                        ),
                      ],
                    ),
                  )
                : InteractiveViewer(
                    minScale: 0.5,
                    maxScale: 4.0,
                    child: Center(
                      child: LayoutBuilder(
                        builder: (context, constraints) {
                          if (_imageSize == null) return Container();

                          // คำนวณอัตราส่วนการปรับขนาดภาพในหน้าจอ
                          final double imageWidth = _imageSize!.width;
                          final double imageHeight = _imageSize!.height;

                          final double containerWidth = constraints.maxWidth;
                          final double containerHeight = constraints.maxHeight;

                          // BoxFit.contain calculation
                          final double scaleX = containerWidth / imageWidth;
                          final double scaleY = containerHeight / imageHeight;
                          final double scale = scaleX < scaleY ? scaleX : scaleY;

                          final double fittedWidth = imageWidth * scale;
                          final double fittedHeight = imageHeight * scale;

                          return SizedBox(
                            width: containerWidth,
                            height: containerHeight,
                            child: Stack(
                              children: [
                                // 1. แสดงรูปภาพ Manga
                                Center(
                                  child: SizedBox(
                                    width: fittedWidth,
                                    height: fittedHeight,
                                    child: Image.file(
                                      _selectedImage!,
                                      fit: BoxFit.fill,
                                    ),
                                  ),
                                ),

                                // 2. แสดงกล่องข้อความภาษาไทยทับบนตำแหน่งเดิม
                                for (final block in _translatedBlocks)
                                  Positioned(
                                    left: ((containerWidth - fittedWidth) / 2) + (block.boundingBox.left * scale),
                                    top: ((containerHeight - fittedHeight) / 2) + (block.boundingBox.top * scale),
                                    width: block.boundingBox.width * scale,
                                    height: block.boundingBox.height * scale,
                                    child: Container(
                                      padding: const EdgeInsets.all(2.0),
                                      decoration: BoxDecoration(
                                        color: Colors.white,
                                        borderRadius: BorderRadius.circular(4.0),
                                        border: Border.all(color: Colors.black26, width: 0.5),
                                        boxShadow: const [
                                          BoxShadow(
                                            color: Colors.black12,
                                            blurRadius: 2,
                                          ),
                                        ],
                                      ),
                                      child: Center(
                                        child: FittedBox(
                                          fit: BoxFit.scaleDown,
                                          child: Text(
                                            block.translatedText,
                                            textAlign: TextAlign.center,
                                            style: const TextStyle(
                                              color: Colors.black,
                                              fontWeight: FontWeight.bold,
                                              height: 1.2,
                                            ),
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                              ],
                            ),
                          );
                        },
                      ),
                    ),
                  ),
          ),
        ],
      ),

      // ปุ่มเลือกรูปภาพ
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _isProcessing ? null : _pickImage,
        icon: const Icon(Icons.add_photo_alternate),
        label: const Text('เลือกรูปภาพ Manga'),
      ),
    );
  }
}
