# Safari 공개 배포용 서명과 공증

GitHub Releases로 Safari 앱을 직접 배포할 때는 **Developer ID Application 인증서로 서명**하고, 완성된 배포 파일을 **Apple 공증 서비스에 제출**합니다. 별도의 공증 인증서를 발급받는 방식은 아닙니다. 현재 릴리스의 Safari ZIP은 빌드용 소스이며 공증 앱이 포함되어 있지 않습니다.

## 인증서 발급

1. [Apple Developer Program](https://developer.apple.com/programs/)에 가입합니다. 안내된 연회비는 US$99이며 지역별 결제 금액은 다를 수 있습니다. 일반 Developer ID 인증서 발급에는 팀의 Account Holder 권한이 필요합니다. 개인 가입자는 본인이 Account Holder입니다.
2. 서명할 Mac에서 **키체인 접근 → 인증서 지원 → 인증 기관에서 인증서 요청**을 엽니다. 이메일과 이름을 입력하고 CA 이메일은 비운 뒤 **디스크에 저장**을 선택해 `.certSigningRequest` 파일을 만듭니다.
3. [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list)에서 **Certificates → + → Developer ID Application**을 선택하고 CSR을 업로드합니다. 앱을 담은 `.pkg` 설치 파일까지 서명할 때는 Developer ID Installer도 필요합니다. `.app`을 ZIP으로 배포하는 경우 Application 인증서를 사용합니다.
4. 내려받은 `.cer`를 CSR을 만든 Mac에서 열어 키체인에 설치합니다. 키체인의 **나의 인증서**에서 Developer ID Application 항목과 연결된 개인 키를 확인합니다.

CSR을 만들 때 생성된 개인 키는 서명에 필요합니다. 인증서의 공개 부분인 `.cer`만 다른 Mac에 복사하면 그 Mac에서 서명할 수 있는 것은 아닙니다. 개인 키나 내보낸 `.p12`는 Git 저장소와 릴리스 파일에 넣지 않습니다.

## 배포 앱 만들기

현재 `scripts/build-safari.sh YOUR_TEAM_ID`는 **로컬 개발 서명용**입니다. 이 명령에 팀 ID만 전달해도 Developer ID 공증 앱이 만들어지는 것은 아닙니다.

공개 배포는 생성된 Xcode 프로젝트에서 Release Archive를 만들고, Organizer의 배포 절차에서 **Developer ID** 서명과 공증을 선택하는 방식으로 진행합니다. 앱과 내부 Safari 확장 모두 유효하게 서명되어야 하며, Hardened Runtime, 보안 타임스탬프, 배포용 entitlements도 맞아야 합니다. 디버깅용 `get-task-allow=true` 설정은 공증 빌드에 포함하지 않습니다.

공증은 파일마다 이루어집니다. 확장 전용 앱과 도우미 포함 확장 앱은 각각 배포 빌드를 만들고 공증 결과를 확인합니다. 공증 성공 후 티켓을 앱에 첨부(staple)하고 다시 ZIP으로 묶어 릴리스에 올립니다. 공증 전에 만든 ZIP에는 나중에 첨부한 티켓이 반영되지 않습니다.

## 명령줄 공증 인증

`notarytool`은 Apple 계정의 앱 전용 암호 또는 App Store Connect API 키로 인증할 수 있습니다. 로컬에서 앱 전용 암호를 사용할 때는 키체인 프로필로 저장하면 명령 기록이나 저장소에 암호를 넣지 않아도 됩니다.

```sh
xcrun notarytool store-credentials "panopto-notary" \
  --apple-id "YOUR_APPLE_ACCOUNT" \
  --team-id "YOUR_TEAM_ID"
```

명령이 요청하면 앱 전용 암호를 직접 입력합니다. 이후 서명된 배포 ZIP을 제출하고, 성공한 앱에 티켓을 첨부합니다.

```sh
xcrun notarytool submit "SIGNED_APP.zip" \
  --keychain-profile "panopto-notary" --wait
xcrun stapler staple "Your App.app"
xcrun stapler validate "Your App.app"
```

`--wait`의 성공 결과를 확인한 뒤 staple을 실행해야 합니다. 위 명령은 서명되지 않은 개발 앱을 배포용 앱으로 바꿔 주지는 않습니다.

## 공식 문서

- [Developer ID 인증서 발급](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [CSR 생성](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request)
- [Safari 확장 배포](https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension)
- [공증 준비 조건](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [공증 인증과 제출 절차](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
