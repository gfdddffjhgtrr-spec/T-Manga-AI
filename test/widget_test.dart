import 'package:flutter_test/flutter_test.dart';
import 'package:manga_translator/main.dart';

void main() {
  testWidgets('App renders correctly', (WidgetTester tester) async {
    await tester.pumpWidget(const MangaTranslatorApp());
    expect(find.text('แปลภาษา Manga ไทย'), findsOneWidget);
  });
}
