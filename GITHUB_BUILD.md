# بناء CodeX Android من الجوال

هذه النسخة لا تحتاج Android Studio على الهاتف. GitHub Actions يوفر بيئة البناء (Java + Gradle + Android SDK) على خوادمه.

## الخطوات

1. أنشئ مستودعًا جديدًا على GitHub، مثل `CodeX-Android`.
2. ارفع **محتويات هذا المجلد** إلى المستودع (بحيث يظهر `.github/workflows/android-apk.yml` في جذر المستودع، ومجلد `android` بجانبه).
3. افتح تبويب **Actions**.
4. اختر **Build CodeX Android APK**.
5. اضغط **Run workflow**.
6. انتظر حتى تنتهي المهمة بنجاح.
7. افتح نتيجة التشغيل ثم قسم **Artifacts**.
8. نزّل `CodeX-Android-debug-apk.zip`، فك الضغط، وثبّت `app-debug.apk` على الهاتف.

يمكن أيضًا أن يبدأ البناء تلقائيًا عند رفع تغييرات إلى `android/**`.

## ملاحظات

- هذا يبني Debug APK للتجربة.
- لا توجد مفاتيح توقيع خاصة داخل المستودع.
- البناء يستخدم Android SDK 35 وBuild Tools 35.0.0 وGradle 8.10.2.
- GitHub هو الذي ينفذ البناء؛ لا يلزم تنزيل SDK أو Gradle على الهاتف.
