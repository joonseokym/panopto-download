Panopto Downloader {{VERSION}}은 설치할 때 **확장 프로그램 전용** 또는 **로컬 도우미 포함**을 선택할 수 있습니다. 두 방식 모두 현재 영상 다운로드, 폴더 전체 다운로드와 0.25~4배 배속을 제공합니다.

| 브라우저 | 확장 프로그램 전용 | 로컬 도우미 포함 |
| --- | --- | --- |
| Chrome | [standalone ZIP]({{RELEASE_BASE_URL}}/panopto-{{VERSION}}-chrome-standalone.zip) | [with-helper ZIP]({{RELEASE_BASE_URL}}/panopto-{{VERSION}}-chrome-with-helper.zip) |
| Safari | [standalone 소스 ZIP]({{RELEASE_BASE_URL}}/panopto-{{VERSION}}-safari-standalone-source.zip) | [with-helper 소스 ZIP]({{RELEASE_BASE_URL}}/panopto-{{VERSION}}-safari-with-helper-source.zip) |

- **확장 프로그램 전용:** 추가 프로그램 없이 브라우저에서 저장합니다. 기본 저장 위치는 브라우저의 다운로드 폴더이며, 다운로드 중 강의 탭과 관리 탭을 유지해야 합니다. TS는 `.ts`로 저장하고 Safari의 최종 저장 결과는 Safari 다운로드 목록에서 확인합니다.
- **로컬 도우미 포함:** 도우미 소스·실행기를 함께 제공합니다. Python 3.9 이상과 FFmpeg·FFprobe를 별도로 설치하고 도우미를 실행·연결해야 합니다. HLS의 MP4 변환·검증, 저장 경로 지정과 완료 파일 중복 저장 방지를 지원합니다. 기본 경로는 `~/Downloads`입니다.
- **Chrome:** ZIP을 풀고 개발자 모드에서 `extension/`을 로드합니다.
- **Safari:** 현재 제공 파일은 **빌드용 소스**입니다. Xcode·Node.js로 로컬 앱을 빌드하거나 지원되는 Safari에서 임시 로드하세요. 일반 배포용 Developer ID 서명·공증 앱은 포함하지 않습니다.

[설치 안내]({{RELEASE_BASE_URL}}/INSTALL.md) · [SHA-256 체크섬]({{RELEASE_BASE_URL}}/SHA256SUMS)

한 브라우저에는 한 방식만 활성화하세요. 전환 시 기존 확장을 먼저 끄고 새 확장을 켠 뒤 Panopto 페이지를 새로고침합니다. 두 방식의 설정·작업 내역은 자동 이전되지 않습니다.
