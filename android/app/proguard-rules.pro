# Proguard rules for LyricWave Standalone Native App
-keepclassmembers class * extends android.webkit.WebChromeClient {
   public void *(...);
}
-keepclassmembers class * extends android.webkit.WebViewClient {
   public void *(...);
}
-keep class androidx.webkit.** { *; }
-dontwarn androidx.webkit.**
