# Safari 공개 배포용 서명과 공증

GitHub Releases로 Safari 앱을 직접 배포할 때는 **Developer ID Application 인증서로 서명**하고, 완성된 배포 파일을 **Apple 공증 서비스에 제출**합니다. 별도의 공증 인증서를 발급받는 방식은 아닙니다. 현재 릴리스의 Safari ZIP은 빌드용 소스이며 공증 앱이 포함되어 있지 않습니다.

## 비용과 가입 조건

새 개인 계정으로 Developer ID 인증서를 발급받고 공증 앱을 배포하려면 Apple Developer Program 가입이 필요합니다. 연회비는 **US$99**이며 현지 결제 금액은 지역에 따라 다릅니다. 인증서 한 장이나 공증 한 건마다 US$99를 추가로 내는 구조가 아니며, **같은 Developer ID Application 인증서로 확장 전용판과 도우미 포함판을 모두 서명**할 수 있습니다.

이미 가입된 본인 또는 소속 팀의 멤버십과 적절한 권한이 있다면 신규 개인 가입 없이 해당 팀으로 진행할 수 있습니다. [회비 면제](https://developer.apple.com/help/account/membership/fee-waivers/)는 조건을 충족하는 비영리·공인 교육기관·정부 **법인**을 대상으로 하며, 개인 학생 계정이 자동으로 면제되지는 않습니다. 무료 Apple 계정의 로컬 개발·임시 설치와 일반 사용자에게 배포하는 Developer ID 서명·공증은 구분해야 합니다.

## 인증서 발급

1. [Apple Developer Program](https://developer.apple.com/programs/)에 가입합니다. 안내된 연회비는 US$99이며 지역별 결제 금액은 다를 수 있습니다. 일반 Developer ID 인증서 발급에는 팀의 Account Holder 권한이 필요합니다. 개인 가입자는 본인이 Account Holder입니다.
2. 서명할 Mac에서 **키체인 접근 → 인증서 지원 → 인증 기관에서 인증서 요청**을 엽니다. 이메일과 이름을 입력하고 CA 이메일은 비운 뒤 **디스크에 저장**을 선택해 `.certSigningRequest` 파일을 만듭니다.
3. [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list)에서 **Certificates → + → Developer ID Application**을 선택하고 CSR을 업로드합니다. 앱을 담은 `.pkg` 설치 파일까지 서명할 때는 Developer ID Installer도 필요합니다. `.app`을 ZIP으로 배포하는 경우 Application 인증서를 사용합니다.
4. 내려받은 `.cer`를 CSR을 만든 Mac에서 열어 키체인에 설치합니다. 키체인의 **나의 인증서**에서 Developer ID Application 항목과 연결된 개인 키를 확인합니다.

CSR을 만들 때 생성된 개인 키는 서명에 필요합니다. 인증서의 공개 부분인 `.cer`만 다른 Mac에 복사하면 그 Mac에서 서명할 수 있는 것은 아닙니다. 개인 키나 내보낸 `.p12`는 Git 저장소와 릴리스 파일에 넣지 않습니다.

## 배포 앱 만들기

현재 `scripts/build-safari.sh YOUR_TEAM_ID`는 **로컬 개발 서명용**입니다. 이 명령에 팀 ID만 전달해도 Developer ID 공증 앱이 만들어지는 것은 아닙니다.

공개 배포는 아래 배포 스크립트를 사용하거나, 생성된 Xcode 프로젝트에서 Release Archive를 만들고 Organizer의 **Developer ID** 서명과 공증을 사용할 수 있습니다. 앱과 내부 Safari 확장 모두 유효하게 서명되어야 하며, Hardened Runtime, 보안 타임스탬프, 배포용 entitlements도 맞아야 합니다. 디버깅용 `get-task-allow=true` 설정은 공증 빌드에 포함하지 않습니다.

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

## 두 버전의 공개 배포 빌드

macOS, 전체 Xcode, Node.js 20 이상, 키체인의 Developer ID Application 인증서·연결된 개인 키, 위에서 저장한 `notarytool` 키체인 프로필이 필요합니다. 먼저 키체인의 인증서 이름과 팀 ID를 확인합니다.

```sh
security find-identity -v -p codesigning
bash scripts/distribute-safari.sh \
  --identity "Developer ID Application: YOUR_NAME (YOUR_TEAM_ID)" \
  --team-id "YOUR_TEAM_ID" \
  --notary-profile "panopto-notary"
```

기본값은 두 버전 모두이며 `--variant standalone` 또는 `--variant with-helper`로 하나만 선택할 수 있습니다. 스크립트는 macOS 12.0을 최소 버전으로 지정하고 Release 빌드에서 `ONLY_ACTIVE_ARCH=NO`, `ARCHS="arm64 x86_64"`를 사용합니다. 앱과 확장에 두 아키텍처가 실제 포함되는지, 번들 ID와 버전·최소 OS가 맞는지 검사한 뒤 내부 확장부터 앱 순서로 Developer ID 서명합니다. Hardened Runtime·보안 타임스탬프·팀 ID·`get-task-allow=false`를 확인한 후 각 앱을 Apple에 제출하고 **Accepted**인 경우에만 티켓을 첨부합니다. Gatekeeper 확인 후 최종 ZIP을 만들고, ZIP을 새 폴더에 다시 풀어 서명·티켓·Gatekeeper를 재검증합니다.

요청한 모든 버전이 검증을 통과한 후에만 다음 파일을 `dist/release/`에 복사합니다. 기존 릴리스 ZIP과 체크섬 파일을 지우거나 덮어쓰지 않습니다. 재실행에는 `--output-dir /path/to/fresh-directory`로 새 폴더를 지정합니다.

- `panopto-1.2.0-safari-standalone-macos.zip`
- `panopto-1.2.0-safari-with-helper-macos.zip`
- `SAFARI-SHA256SUMS`

파일명의 버전은 `package.json`과 두 확장의 일치하는 버전에서 읽습니다. 도우미 포함 ZIP에는 서명·공증된 Safari 앱과 함께 `helper/` 소스·실행기·설명서를 넣습니다. **Python·FFmpeg·FFprobe 자체는 포함하지 않으므로 별도 설치해야 합니다.** 공증은 Safari 앱에 적용되며 외부 인터프리터를 공증하거나 자동 설치하지 않습니다.

공증 결과·로그·서명 진단은 `~/Library/Logs/PanoptoDownloader/distribution.*` 아래 접근 제한된 폴더에 보관하며 릴리스 ZIP에 넣지 않습니다. 암호·개인 키는 스크립트 인자로 전달하지 않습니다. Developer ID 인증서나 유효한 공증 인증이 없으면 결과 파일을 생성하지 않으며, 개발 서명·서명하지 않은 앱을 공개 배포 앱으로 표시하지 않습니다. 테스트의 모의 공증 성공은 실제 Apple 공증을 대신하지 않습니다.

이 명령은 로컬 배포 파일만 만들며 GitHub에 자동 업로드하지 않습니다. 실제 성공한 두 ZIP과 `SAFARI-SHA256SUMS`만 릴리스에 올리고, 기존 소스 패키지의 체크섬과 구분해 안내합니다.

## 공식 문서

- [Developer ID 인증서 발급](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [CSR 생성](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request)
- [Safari 확장 배포](https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension)
- [공증 준비 조건](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [공증 인증과 제출 절차](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
