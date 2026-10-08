# 방장 Android 앱

PC에서 **내 휴대폰 연결**을 켜고 비공개 Tailscale Serve `https://PC.ts.net:8444/join#...` QR 링크를 앱에 붙여넣습니다. 휴대폰도 같은 Tailscale 네트워크에 연결되어야 합니다. 친구 Funnel은 별도 `:8443` 경로이며 PC에서 먼저 켭니다. 앱의 공유 버튼은 발급된 친구 링크만 Android 공유 메뉴로 전달합니다.

PC와 서버가 꺼지면 접속·AI 동작이 중단됩니다. 작업대는 기존 서버 정책대로 로컬 PC에서만 접근할 수 있습니다. 인증은 기존 HttpOnly 쿠키로 유지하며 초대 토큰은 앱 설정에 저장하지 않습니다.

JDK 17+, Android API 36 SDK, Gradle 8.13+ 및 AGP 8.13.0 의존성이 설치된 환경에서 `npm run build:android`를 실행합니다. 오프라인 빌드이며 자동 설치·배포는 하지 않습니다. 결과 경로: `android/app/build/outputs/apk/debug/app-debug.apk`. 이 베타의 debug APK는 설치 검증용이며 배포 서명은 별도입니다.

도구 버전은 [Android 공식 호환성 표](https://developer.android.com/build/releases/agp-8-13-0-release-notes)에 맞췄고, WebView의 파일 접근은 [Android 보안 지침](https://developer.android.com/privacy-and-security/risks/webview-unsafe-file-inclusion)에 따라 비활성화했습니다.
