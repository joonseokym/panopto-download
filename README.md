# Panopto Downloader · Safari / Chrome

로그인된 Panopto에서 녹화 영상을 MP4로 저장하고, 폴더 전체 다운로드와 재생 배속을 제공하는 브라우저 확장입니다. Safari와 Chrome은 같은 Manifest V3 소스를 사용합니다.

- **현재 영상 다운로드**: 공식 통합 MP4가 제공되면 우선 사용하고, 그 외에는 재생용 MP4/HLS를 저장합니다.
- **이 폴더 전체 다운로드**: 페이지를 넘겨 폴더의 모든 영상을 조회하고, 항목별 진행 상황과 실패 이유를 표시합니다. 하위 폴더는 포함하지 않습니다.
- **저장 위치 지정**: 기본값은 `~/Downloads`. 확장 설정이나 로컬 관리 화면에서 다른 폴더 경로를 지정할 수 있습니다.
- **재생 배속**: 0.25~4배. 플레이어가 교체되거나 여러 영상 트랙이 있는 경우에도 적용합니다. 저장되는 MP4는 원래 속도를 유지합니다.
- **다운로드 관리**: 순차 처리, 진행률, 취소, 기존 완료 파일의 중복 저장 방지.

## 1. 로컬 도우미 시작

HLS 병합과 임의의 저장 위치를 지원하기 위해 Python/FFmpeg 도우미가 필요합니다. 브라우저 확장만으로 모든 기능을 제공하지는 않습니다. 배속 기능은 도우미 없이 사용할 수 있습니다.

필수 프로그램: Python 3.9 이상, FFmpeg와 FFprobe. Node.js 20 이상은 테스트와 ZIP 패키징에만 필요합니다. Python 패키지를 별도로 설치할 필요는 없습니다.

```sh
git clone https://github.com/joonseokym/panopto-download.git
cd panopto-download
# macOS에서 FFmpeg가 없다면:
brew install ffmpeg
python3 panopto_download.py
```

macOS에서는 `start.command`를 더블클릭해도 됩니다. 다운로드 중에는 도우미를 실행한 터미널을 열어 두세요. 종료는 `Ctrl+C`입니다.

관리 화면: <http://127.0.0.1:8765>. **확장 프로그램 연결 코드**를 복사합니다.

## 2. Chrome 설치

1. `chrome://extensions`를 열고 **개발자 모드**를 켭니다.
2. **압축해제된 확장 프로그램을 로드합니다**를 선택하고 저장소의 `extension/` 폴더를 지정합니다.
3. 확장 프로그램 설정에서 연결 코드를 붙여 넣고 연결을 확인합니다.
4. 열려 있던 Panopto 페이지를 새로고침합니다.

Chrome Web Store에 배포된 확장은 아니며, 현재는 소스를 직접 로드하는 개발 설치 방식입니다.

## 3. Safari 설치

현재 Safari의 임시 설치 기능을 사용할 수 있습니다. **Safari 설정 → 개발자 → Add Temporary Extension…**에서 `extension/` 폴더나 생성한 ZIP을 선택합니다. 개발자 설정이 보이지 않으면 Safari 고급 설정의 웹 개발자 기능을 표시합니다. 임시 확장은 Safari를 종료하거나 24시간이 지나면 제거됩니다.

지속적으로 설치할 macOS 앱은 Xcode로 빌드할 수 있습니다.

```sh
# Xcode 프로젝트 생성 및 서명하지 않은 빌드
bash scripts/build-safari.sh

# 본인의 Apple Development Team ID를 전달해 로컬 개발 서명
bash scripts/build-safari.sh YOUR_TEAM_ID
```

결과는 `dist/safari/Panopto Downloader.app`과 `dist/safari/panopto-downloader-macos.zip`입니다. 앱을 실행하고 Safari 설정의 확장 프로그램에서 활성화한 뒤 Panopto 사이트 접근을 허용합니다. 서명하지 않은 빌드는 배포용 앱이 아니며, 일반 설치에는 개발 서명이 필요합니다. App Store 배포·공증은 이 저장소에 포함되지 않습니다. Apple 계정, 인증서, 팀 ID를 소스에 저장하지 않습니다.

설치 후 확장 설정에 로컬 연결 코드를 입력하고 Panopto 페이지를 새로고침합니다.

## 사용하기

**영상 페이지**에는 현재 영상 다운로드 버튼과 배속 선택이 나타납니다. **폴더 목록 페이지**에는 이 폴더 전체 다운로드 버튼이 나타납니다. 같은 기능을 확장 팝업에서도 실행할 수 있습니다.

폴더 다운로드 중에는 로그인된 Panopto 탭을 열어 두세요. 팝업을 닫아도 대기열은 유지됩니다. 탭을 닫거나 로그인이 만료되면 항목별 오류를 확인하고 다시 시도할 수 있습니다. 다운로드 가능한 녹화만 저장하며, 진행 중인 방송·준비되지 않은 영상·암호화된 HLS는 지원하지 않습니다.

저장 폴더는 설정에서 `~/Downloads`, `~/Movies/Lectures` 같은 경로로 입력합니다. 변경한 위치는 아직 도우미에 제출하지 않은 대기 영상부터 적용됩니다. 폴더 다운로드 대기열의 영상도 여기에 포함됩니다. 이미 도우미에 제출한 작업은 제출할 때의 위치를 사용합니다. 설정은 이 Mac의 도우미에 저장되므로 연결된 브라우저에서 공유됩니다.

여러 화면이 있는 강의는 스트림별 MP4로 저장합니다. 화면 합성이나 화면별 시간 오프셋 조정은 하지 않으며, 화면 스트림에 음성이 없을 수도 있습니다. 자막을 MP4에 합치지는 않습니다.

## 확장 없이 즐겨찾기로 사용

관리 화면의 **Panopto 다운로드** 버튼을 Safari 즐겨찾기 막대로 드래그합니다. Panopto 영상 페이지에서 해당 즐겨찾기를 누르면 현재 영상을 다운로드합니다. 이 방식은 개별 다운로드만 지원합니다.

## 개인정보와 권한

- Panopto 로그인은 브라우저에서 처리합니다. 쿠키·비밀번호를 내보내거나 별도로 저장하지 않습니다.
- 재생 주소는 다운로드할 때 로컬 도우미에 전달하며 완료 후 메모리에서 제거합니다. 외부 분석·추적 서버가 없습니다.
- 확장 권한은 Panopto 사이트, 로컬 도우미, 설정 저장, 현재 탭, 대기열 재개용 알람으로 제한됩니다.
- 연결 코드는 확장 로컬 저장소와 `.state/token`에 보관합니다. 코드를 다른 사람에게 공유하지 마세요.
- `.state/`에는 로컬 설정·완료 내역이 저장됩니다. 영상 파일, 토큰, 설정, 빌드 산출물은 Git에서 제외합니다.
- 재생 권한이 있는 영상만 사용할 수 있으며, 인증이나 DRM을 우회하지 않습니다.

## 개발·검증

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
npm test
npm run package
```

ZIP 산출물은 `dist/chrome/`과 `dist/safari/`에 생성됩니다. Safari 빌드와 ZIP은 로컬 산출물이며 Git에는 포함하지 않습니다. PNG 아이콘은 `swift scripts/generate-icons.swift`로 다시 생성할 수 있습니다.

도우미는 `127.0.0.1:8765`에만 바인딩됩니다. JSON API는 연결 코드를 `X-Panopto-Token` 헤더로 받습니다. CORS는 브라우저 확장 출처만 허용하며, 일반 웹 페이지에 토큰을 제공하지 않습니다.

```sh
# 시작할 때만 저장 위치를 덮어쓰기
python3 panopto_download.py --output ~/Movies/Lectures
```

확장은 기본 포트 8765에 연결합니다. `--port`를 바꾸는 옵션은 기존 즐겨찾기 방식과 도우미 개발에만 사용하세요.

## 참고 문서

Panopto 재생 정보·폴더 조회는 공식 웹 클라이언트의 [Viewer 코드](https://static-assets-cdn.i.ap.panopto.com/Panopto/Cache/17.12.0.00003/Scripts/Panopto/Bundles/viewer.umd.js), [폴더 목록 코드](https://static-assets-cdn.i.ap.panopto.com/Panopto/Cache/17.12.0.00003/Scripts/Panopto/List/ListBase.js)를 참고합니다. Panopto 배포 버전에 따라 내부 API가 달라질 수 있습니다.

Safari 설치와 패키징은 [Apple 설치 안내](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension), [Apple 패키징 안내](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)를 참고하세요. 임의의 저장 경로에 도우미가 필요한 이유는 [Chrome 다운로드 API의 경로 제한](https://developer.chrome.com/docs/extensions/reference/api/downloads)과 관련됩니다.
