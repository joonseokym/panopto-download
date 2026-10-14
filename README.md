# Panopto Downloader · Safari / Chrome

로그인된 Panopto의 영상과 폴더를 **확장 프로그램만으로 다운로드**하고 재생 속도를 조절합니다. 이 브랜치의 확장은 로컬 서버, 연결 코드, Python, FFmpeg 설치가 필요하지 않습니다. Safari 설치용 macOS 앱은 확장을 등록하는 역할만 하며 다운로드 도우미를 실행하지 않습니다.

- **현재 영상 다운로드**: 공식 MP4를 우선 사용하며, 지원되는 녹화용 HLS도 브라우저에서 처리합니다.
- **폴더 전체 다운로드**: 목록의 모든 페이지를 조회하고 영상을 순서대로 처리합니다. 하위 폴더는 포함하지 않습니다.
- **저장 위치**: 기본값은 브라우저의 다운로드 폴더입니다. 브라우저 기본 설정을 변경하지 않았다면 Downloads에 저장됩니다.
- **재생 배속**: 0.25~4배. 플레이어 교체와 여러 영상·음성 요소에도 적용하며, 저장 파일의 원래 재생 속도는 유지합니다.
- **다운로드 관리 탭**: 작업별 진행 상황, 실패 이유와 취소 기능을 제공합니다. 팝업은 닫아도 되지만 다운로드 관리 탭은 열어 두세요.

## Chrome 설치

```sh
git clone --branch codex/standalone-extension https://github.com/joonseokym/panopto-download.git
cd panopto-download
```

1. `chrome://extensions`에서 **개발자 모드**를 켭니다.
2. **압축해제된 확장 프로그램을 로드합니다**를 선택하고 저장소의 `extension/` 폴더를 지정합니다.
3. 로그인한 Panopto 페이지를 새로고침합니다. 별도 연결 설정은 없습니다.

Chrome Web Store에 배포된 확장은 아니며, 소스를 직접 로드하는 개발 설치 방식입니다.

## Safari 설치

설치용 macOS 앱은 Xcode와 Node.js 20 이상으로 빌드합니다. Node.js는 패키징에만 사용하며 설치 후 다운로드에는 필요하지 않습니다.

```sh
# Xcode 프로젝트 생성 및 서명하지 않은 빌드
bash scripts/build-safari.sh

# 본인의 Apple Development Team ID로 로컬 개발 서명
bash scripts/build-safari.sh YOUR_TEAM_ID
```

결과는 `dist/safari/Panopto Downloader.app`과 `dist/safari/panopto-downloader-macos.zip`입니다. ZIP을 풀어 앱을 Applications에 넣고 실행한 뒤, Safari 설정의 **확장 프로그램**에서 활성화하고 사용하는 Panopto 사이트 접근을 허용합니다. 설치·업데이트 후 열려 있던 Panopto 페이지를 새로고침합니다.

서명하지 않은 빌드는 개발용이며 일반 설치에는 개발 서명이 필요합니다. App Store 배포·공증은 이 저장소에 포함되지 않습니다. Apple 계정, 인증서, 팀 ID는 소스에 저장하지 않습니다.

지원되는 Safari에서는 개발자 설정의 **Add Temporary Extension…**으로 `dist/safari/extension/` 또는 Safari용 확장 ZIP을 임시로 로드할 수도 있습니다. 개발자 설정이 보이지 않으면 Safari 고급 설정에서 웹 개발자 기능을 표시합니다. 임시 설치의 유지 기간과 사용 가능 여부는 Safari 버전에 따릅니다.

## 사용하기

영상 페이지의 **이 영상 다운로드**, 폴더 목록의 **폴더 전체 다운로드**, 또는 확장 팝업에서 다운로드를 시작합니다. 작업을 처리할 **다운로드 관리 탭**이 열립니다. 다운로드 중에는 이 탭과 로그인된 Panopto 원본 탭을 모두 열어 두세요. 원본 탭은 영상 정보와 로그인 세션을 사용합니다.

폴더 작업은 폴더의 영상 목록을 수집한 뒤 순차적으로 저장합니다. 로그인 만료나 탭 종료로 실패한 항목은 관리 탭에서 확인하고 다시 시도합니다. 팝업을 닫아도 진행하지만, 관리 탭을 닫거나 브라우저를 종료하면 아직 처리 중인 작업이 중단될 수 있습니다. 디스크에 이미 저장한 파일의 존재를 확인해 주는 기능은 아닙니다.

Safari가 여러 파일 다운로드의 허용 여부를 묻는 경우 해당 다운로드 흐름을 허용해야 합니다. 확장에 **브라우저로 전달됨**이 표시되면 Safari 저장 요청까지 진행된 것이며, 실제 파일 저장 완료 여부는 Safari 다운로드 목록에서 확인합니다. 브라우저에 전달된 다운로드는 브라우저 다운로드 목록에서 취소하세요.

여러 화면이 있는 강의는 스트림별 파일로 저장합니다. 화면 합성, 서로 다른 화면의 시간 오프셋 조정, 별도 음성 트랙 결합, 자막 합치기는 제공하지 않습니다.

## 저장 위치

| 방식 | 동작 |
| --- | --- |
| 기본 브라우저 다운로드 | 브라우저가 설정한 다운로드 폴더로 저장합니다. 기본 설정은 Downloads입니다. |
| Chrome 하위 폴더 | 다운로드 폴더 안의 상대 경로를 사용합니다. 예: `Panopto/Lectures`. 절대 경로와 `..`는 사용할 수 없습니다. |
| Chrome 저장할 때 묻기 | 파일별 저장 대화상자를 엽니다. 폴더 전체 작업에서는 파일마다 확인이 필요할 수 있습니다. |
| 지원되는 브라우저에서 폴더 선택 | 저장 설정의 폴더 선택 기능으로 사용자가 직접 고르고 쓰기 권한을 허용한 위치에 저장합니다. 권한이 만료되면 다시 선택해야 합니다. |

Safari의 기본 저장 위치는 **Safari 설정 → 일반 → 파일 다운로드 위치**에서 바꿉니다. Safari에서 폴더 선택 API가 지원되지 않으면 브라우저 저장 방식을 사용합니다. 확장 설정에 `/Users/...` 경로를 입력하여 임의의 폴더에 권한 없이 저장할 수는 없습니다.

## 지원 형식과 제약

- **MP4 등 직접 파일**은 브라우저로 저장합니다.
- **암호화되지 않은 VOD HLS의 fragmented MP4(fMP4)**는 초기화 정보와 영상 조각을 받아 MP4 파일로 이어 저장합니다. 하나의 파일을 가리키는 바이트 범위가 처음부터 끝까지 연속인 경우에만 원본 파일 직접 저장을 최적화에 사용합니다.
- **MPEG-TS HLS**는 원래의 TS 조각을 이어 `.ts` 파일로 저장합니다. MP4로 변환한다고 표시하거나 확장자만 바꾸지 않습니다. 재생 가능한 프로그램에서 열거나 별도 도구로 변환할 수 있습니다.
- 진행 중인 방송, 암호화된 HLS, 준비되지 않은 영상, 별도 음성을 결합해야 하는 HLS 구성, 지원하지 않는 재생 목록은 실패 이유를 표시하고 중단합니다.

도우미가 없어 설치는 간단해지지만, 브라우저 안에서 처리하는 만큼 다음 제약이 있습니다.

1. **관리 탭을 유지해야 합니다.** 탭 종료, 브라우저 종료, 절전이나 네트워크 중단에 영향을 받습니다. 자동 재개는 완전한 다운로드 복구를 보장하지 않습니다.
2. **대용량 처리에 여유 공간이 필요합니다.** 브라우저의 임시 저장소(OPFS)를 우선 사용합니다. 이를 사용할 수 없는 환경에서는 메모리를 사용하며 파일당 256 MiB로 제한합니다. 디스크 임시 저장에는 Safari 26 이상 또는 최신 Chrome이 권장됩니다. Safari에서 최종 저장을 확인한 뒤 작업 탭의 **임시 파일 정리**를 누르세요. 작업 탭을 다시 열 때 이전 실행에서 남은 임시 파일도 정리합니다. 임시 파일과 최종 파일이 함께 존재하는 동안 추가 디스크 공간이 필요합니다.
3. **Safari의 저장 상태 확인과 취소 범위가 제한됩니다.** 확장에서 브라우저에 넘긴 저장 요청을 실제 디스크 저장 완료와 구분해 표시합니다. 최종 다운로드 상태는 Safari에서 확인합니다.
4. **FFmpeg 병합·검증을 하지 않습니다.** TS의 MP4 변환, 복잡한 트랙 구성 처리, FFprobe를 이용한 최종 파일 검증은 제공하지 않습니다.
5. **저장 위치는 브라우저의 권한 모델을 따릅니다.** 임의의 절대 경로를 조용히 지정하여 저장하는 기능은 없습니다.

## 개인정보와 권한

- Panopto 로그인은 브라우저에서 처리합니다. 쿠키·비밀번호를 내보내거나 별도로 저장하지 않습니다.
- 재생 주소는 현재 작업 중 메모리에서 사용합니다. 영구 작업 내역에는 제목, 영상 식별자와 상태 등 메타데이터만 저장하며 서명된 재생 URL은 저장하지 않습니다.
- 외부 분석·추적 서버나 localhost 연결은 사용하지 않습니다.
- 확장 권한은 Panopto 사이트, 현재 탭과 설정 저장, 브라우저에서 제공하는 다운로드 기능을 위한 권한으로 제한합니다. Safari 패키지에서는 지원하지 않는 `downloads` 권한을 제거합니다.
- 재생 권한이 있는 녹화만 사용하며 인증이나 DRM을 우회하지 않습니다.
- 영상 파일, 개인 설정, 인증서와 빌드 산출물은 Git에서 제외합니다.

## 개발·패키징

```sh
npm test
npm run package
```

Chrome과 Safari용 확장 ZIP 및 압축 해제된 소스는 각각 `dist/chrome/`과 `dist/safari/`에 생성됩니다. Safari 빌드 스크립트는 먼저 패키징하고 Safari용 manifest가 적용된 `dist/safari/extension/`으로 앱을 만듭니다. 생성한 ZIP, 앱, Xcode 프로젝트는 Git에 포함하지 않습니다. PNG 아이콘은 `swift scripts/generate-icons.swift`로 다시 생성할 수 있습니다.

미디어 통합 테스트는 FFmpeg로 작은 fMP4/TS 영상을 생성하고, 확장 엔진이 저장한 결과를 FFprobe와 전체 프레임 디코딩으로 검사합니다. 테스트 실행 환경에는 FFmpeg/FFprobe가 필요하며 실제 확장 사용에는 필요하지 않습니다.

## 기존 도우미 방식

기존 `panopto_download.py`, `start.command`, `bookmarklet.js`, `static/`은 이전 도우미 방식과의 호환을 위해 남겨 두었습니다. **이 브랜치의 확장은 이 파일들을 실행하거나 연결하지 않습니다.** 기존 도우미 방식은 Python 3.9 이상, FFmpeg와 FFprobe를 설치하고 `python3 panopto_download.py`로 시작합니다. 관련 테스트는 다음 명령으로 실행할 수 있습니다.

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
```

## 참고 문서

Panopto 재생 정보·폴더 조회는 공식 웹 클라이언트의 [Viewer 코드](https://static-assets-cdn.i.ap.panopto.com/Panopto/Cache/17.12.0.00003/Scripts/Panopto/Bundles/viewer.umd.js), [폴더 목록 코드](https://static-assets-cdn.i.ap.panopto.com/Panopto/Cache/17.12.0.00003/Scripts/Panopto/List/ListBase.js)를 참고합니다. 내부 API는 Panopto 배포 버전에 따라 달라질 수 있습니다.

브라우저 저장 제약은 [Chrome 다운로드 API](https://developer.chrome.com/docs/extensions/reference/api/downloads), [폴더 선택 및 쓰기 권한](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)을 참고하세요. Safari 설치·호환성은 [Apple 설치 안내](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension), [Apple 패키징 안내](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)에 설명되어 있습니다.
