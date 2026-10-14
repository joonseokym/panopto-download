#!/usr/bin/env python3
"""A local, token-protected downloader for the user's current Panopto session.

The browser sends signed playback URLs, never cookies. HTTPS resources are
validated and mirrored locally before ffmpeg runs with networking disabled.
"""

import argparse
import errno
import hashlib
import hmac
import html
import ipaddress
import json
import math
import os
from pathlib import Path
import queue
import re
import secrets
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parent
KAIST_ORIGIN = "https://kaist.ap.panopto.com"
MAX_PAYLOAD = 256 * 1024
MAX_STREAMS = 8
MAX_ACTIVE_JOBS = 20
MAX_HISTORY = 100
MAX_CANCEL_REQUESTS = 10000
MAX_MANIFEST = 4 * 1024 * 1024
MAX_RESOURCES = 20000
MAX_JOB_BYTES = 50 * 1024 ** 3
TERMINAL = {"completed", "failed", "cancelled"}
JOB_FIELDS = ("id", "title", "status", "progress", "error", "files", "outputDir", "requestId")
URI_ATTRIBUTE = re.compile(r'URI="([^"]+)"')


class DownloadError(Exception):
    """A user-safe error that contains no signed URLs or server response body."""


class Cancelled(DownloadError):
    pass


class QueueFull(DownloadError):
    pass


class RequestCancelled(DownloadError):
    pass


class CancellationLimit(DownloadError):
    pass


def validate_request_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", value):
        raise DownloadError("다운로드 요청 식별자가 올바르지 않습니다.")
    return value


def panopto_origin(value):
    """Accept a plain HTTPS origin belonging to Panopto, with no URL extras."""
    if not isinstance(value, str):
        return False
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower()
        return (parsed.scheme == "https" and parsed.netloc == host
                and (host == "panopto.com" or host.endswith(".panopto.com"))
                and not parsed.path and not parsed.query and not parsed.fragment)
    except ValueError:
        return False


def extension_origin(value):
    """Browser extension origins are permitted only with the pairing token."""
    if not isinstance(value, str):
        return False
    return bool(re.fullmatch(r"chrome-extension://[a-p]{32}", value)
                or re.fullmatch(r"safari-web-extension://[A-Za-z0-9][A-Za-z0-9._-]{0,254}", value))


def output_directory(value):
    if not isinstance(value, (str, Path)):
        raise DownloadError("저장 폴더는 절대 경로 또는 ~/로 시작하는 경로로 입력해 주세요.")
    value = str(value).strip()
    if (not value or len(value) > 4096 or any(ord(c) < 32 for c in value)
            or (value.startswith("~") and value != "~" and not value.startswith("~/"))):
        raise DownloadError("저장 폴더 경로가 올바르지 않습니다.")
    try:
        path = Path(value).expanduser()
        if not path.is_absolute():
            raise DownloadError("저장 폴더는 절대 경로 또는 ~/로 시작하는 경로로 입력해 주세요.")
        path = path.resolve()
        path.mkdir(parents=True, exist_ok=True)
        if not path.is_dir() or not os.access(str(path), os.W_OK | os.X_OK):
            raise OSError()
        return path
    except (OSError, ValueError, RuntimeError):
        raise DownloadError("저장 폴더를 만들거나 쓸 수 없습니다. 경로와 접근 권한을 확인해 주세요.") from None


def safe_filename(value, default="Panopto 영상"):
    value = unicodedata.normalize("NFKC", str(value))
    value = re.sub(r'[\x00-\x1f\x7f<>:"/\\|?*]', "_", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    while len(value.encode("utf-8")) > 160:
        value = value[:-1]
    if not value:
        value = default
    if re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])", value):
        value = "_" + value
    return value


def publish_no_overwrite(part, destination):
    """Publish verified media, including on volumes that do not support links."""
    try:
        os.link(str(part), str(destination))
        return
    except OSError as exc:
        if exc.errno not in {errno.EOPNOTSUPP, errno.ENOSYS, errno.EPERM, errno.EXDEV}:
            raise
    created = False
    try:
        # Exclusive creation keeps the same no-overwrite guarantee on exFAT.
        with destination.open("xb") as output:
            created = True
            with part.open("rb") as source:
                shutil.copyfileobj(source, output, length=1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        if created:
            try:
                destination.unlink()
            except OSError:
                pass
        raise


def validate_media_url(url, resolve=False):
    if not isinstance(url, str) or len(url) > 16384:
        raise DownloadError("유효한 영상 주소가 필요합니다.")
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower()
        port = parsed.port
    except ValueError:
        raise DownloadError("영상 주소 형식이 올바르지 않습니다.") from None
    if (parsed.scheme != "https" or not host or parsed.username is not None
            or parsed.password is not None or port not in (None, 443)
            or not (host == "panopto.com" or host.endswith(".panopto.com"))
            or any(c.isspace() or ord(c) < 32 for c in url)):
        raise DownloadError("Panopto의 HTTPS 영상 주소만 다운로드할 수 있습니다.")
    if resolve:
        try:
            addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
            if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global
                                    for a in addresses):
                raise DownloadError("영상 서버의 네트워크 주소를 사용할 수 없습니다.")
        except (socket.gaierror, ValueError):
            raise DownloadError("영상 서버 주소를 확인하지 못했습니다.") from None
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))


def validate_payload(payload):
    if not isinstance(payload, dict):
        raise DownloadError("영상 정보 형식이 올바르지 않습니다.")
    title = payload.get("title", "Panopto 영상")
    if not isinstance(title, str) or len(title) > 1000:
        raise DownloadError("영상 제목이 너무 깁니다.")
    page_url = payload.get("pageUrl", "")
    if not isinstance(page_url, str) or len(page_url) > 4096:
        raise DownloadError("Panopto 페이지 주소가 올바르지 않습니다.")
    try:
        parsed = urlsplit(page_url)
        if (not panopto_origin(urlunsplit((parsed.scheme, parsed.netloc, "", "", "")))
                or any(c.isspace() or ord(c) < 32 for c in page_url)):
            raise ValueError()
    except ValueError:
        raise DownloadError("Panopto HTTPS 페이지에서 영상을 선택해 주세요.") from None
    duration = payload.get("duration")
    if duration is not None and (isinstance(duration, bool)
                                or not isinstance(duration, (int, float))
                                or not math.isfinite(duration)
                                or duration <= 0 or duration > 48 * 3600):
        raise DownloadError("영상 길이 정보가 올바르지 않습니다.")
    streams = payload.get("streams")
    if not isinstance(streams, list) or not 1 <= len(streams) <= MAX_STREAMS:
        raise DownloadError("다운로드할 영상 스트림이 없거나 너무 많습니다.")
    result, seen = [], set()
    for stream in streams:
        if not isinstance(stream, dict):
            raise DownloadError("영상 스트림 정보가 올바르지 않습니다.")
        url = validate_media_url(stream.get("url"))
        name = stream.get("name", "영상")
        if not isinstance(name, str) or len(name) > 500:
            raise DownloadError("영상 스트림 이름이 올바르지 않습니다.")
        if url not in seen:
            result.append({"url": url, "name": name})
            seen.add(url)
    validated = {"title": title.strip() or "Panopto 영상", "pageUrl": page_url,
                 "duration": duration, "streams": result}
    if "requestId" in payload:
        validated["requestId"] = validate_request_id(payload["requestId"])
    return validated


def load_token(state_dir):
    state_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(str(state_dir), 0o700)
    path = state_dir / "token"
    try:
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        token = path.read_text(encoding="ascii").strip()
    else:
        token = secrets.token_urlsafe(32)
        with os.fdopen(fd, "w", encoding="ascii") as file:
            file.write(token + "\n")
    os.chmod(str(path), 0o600)
    if not re.fullmatch(r"[A-Za-z0-9_-]{43,100}", token):
        raise RuntimeError(".state/token 파일이 올바르지 않습니다. 서버를 끄고 이 파일을 삭제해 주세요.")
    return token


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_media_url(newurl, resolve=True)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class MediaMirror:
    """Fetch a finite HLS graph with every network destination checked."""

    def __init__(self, directory, cancel, progress=None, opener=None):
        self.directory = Path(directory)
        self.cancel = cancel
        self.progress = progress or (lambda value: None)
        self.opener = opener or build_opener(SafeRedirect())
        self.resources = {}
        self.bytes_received = 0
        self.completed_resources = 0
        self.total_resources = 0
        self.manifest_depth = 0

    def check_cancel(self):
        if self.cancel.is_set():
            raise Cancelled("다운로드를 취소했습니다.")

    def fetch(self, url, destination=None, limit=None):
        self.check_cancel()
        url = validate_media_url(url, resolve=True)
        request = Request(url, headers={"User-Agent": "PanoptoLocalDownloader/1.0",
                                       "Accept-Encoding": "identity"})
        try:
            with self.opener.open(request, timeout=30) as response:
                validate_media_url(response.geturl(), resolve=True)
                total = response.headers.get("Content-Length")
                total = int(total) if total and total.isdigit() else None
                if limit and total and total > limit:
                    raise DownloadError("영상 목록 파일의 허용 크기를 초과했습니다.")
                if total and self.bytes_received + total > MAX_JOB_BYTES:
                    raise DownloadError("다운로드 허용 크기(50 GB)를 초과했습니다.")
                chunks, size = [], 0
                file = open(destination, "wb") if destination else None
                try:
                    while True:
                        self.check_cancel()
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        size += len(chunk)
                        self.bytes_received += len(chunk)
                        if ((limit and size > limit)
                                or self.bytes_received > MAX_JOB_BYTES):
                            raise DownloadError("다운로드 허용 크기를 초과했습니다.")
                        if file:
                            file.write(chunk)
                        else:
                            chunks.append(chunk)
                        if total and destination:
                            resource_progress = (self.completed_resources + size / total) / max(1, self.total_resources)
                            self.progress(min(90, resource_progress * 90))
                finally:
                    if file:
                        file.close()
                if total is not None and size != total:
                    raise DownloadError("영상 파일 전송이 중간에 끊겼습니다. 다시 시도해 주세요.")
                if size == 0:
                    raise DownloadError("영상 서버에서 빈 파일을 받았습니다.")
                return (b"".join(chunks) if not destination else size), response.geturl()
        except (Cancelled, DownloadError):
            raise
        except HTTPError as exc:
            if exc.code in (401, 403):
                raise DownloadError("영상 주소가 만료되었거나 다운로드 권한이 없습니다. Safari에서 영상을 다시 열고 재시도해 주세요.") from None
            raise DownloadError("영상 서버에서 파일을 받지 못했습니다 (HTTP %s)." % exc.code) from None
        except (URLError, OSError, ValueError):
            raise DownloadError("영상 서버 연결이 끊겼습니다. 네트워크를 확인하고 다시 시도해 주세요.") from None

    @staticmethod
    def child_url(parent, child):
        child = child.strip()
        result = urljoin(parent, child)
        # Some Panopto deployments sign the whole relative HLS resource tree.
        # Preserve that query for relative children without their own signature.
        parsed_child = urlsplit(child)
        parsed_parent = urlsplit(parent)
        parsed_result = urlsplit(result)
        if (not parsed_child.scheme and not parsed_child.netloc
                and not parsed_child.query and parsed_parent.query):
            result = urlunsplit((parsed_result.scheme, parsed_result.netloc,
                                parsed_result.path, parsed_parent.query, ""))
        return validate_media_url(result)

    def resource(self, url):
        self.check_cancel()
        if url in self.resources:
            return self.resources[url]
        if len(self.resources) >= MAX_RESOURCES:
            raise DownloadError("영상 조각 수가 허용 범위를 초과했습니다.")
        extension = Path(urlsplit(url).path).suffix.lower()
        if extension not in {".ts", ".m4s", ".mp4", ".aac", ".m4a", ".vtt"}:
            extension = ".ts"
        name = hashlib.sha256(url.encode("utf-8")).hexdigest()[:32] + extension
        self.resources[url] = name
        self.fetch(url, self.directory / name)
        self.completed_resources += 1
        self.progress(min(90, self.completed_resources / max(1, self.total_resources) * 90))
        return name

    @staticmethod
    def attributes(line):
        return dict(re.findall(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)', line.split(":", 1)[-1]))

    def playlist(self, url, depth=0):
        if depth > 5:
            raise DownloadError("영상 재생 목록의 중첩이 너무 깊습니다.")
        data, final_url = self.fetch(url, limit=MAX_MANIFEST)
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise DownloadError("HLS 영상 목록을 읽을 수 없습니다.") from None
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        if not lines or lines[0] != "#EXTM3U":
            raise DownloadError("유효한 HLS 영상 목록이 아닙니다.")
        if any(line.startswith("#EXT-X-SESSION-KEY:") for line in lines):
            raise DownloadError("암호화된 영상의 다운로드는 지원하지 않습니다.")
        for line in lines:
            if line.startswith("#EXT-X-KEY:") and self.attributes(line).get("METHOD") != "NONE":
                raise DownloadError("암호화된 영상의 다운로드는 지원하지 않습니다.")
        variants = []
        for index, line in enumerate(lines):
            if line.startswith("#EXT-X-STREAM-INF:"):
                if index + 1 >= len(lines) or lines[index + 1].startswith("#"):
                    raise DownloadError("영상 품질 목록이 올바르지 않습니다.")
                attrs = self.attributes(line)
                try:
                    bandwidth = int(attrs.get("BANDWIDTH", "0"))
                except ValueError:
                    bandwidth = 0
                variants.append((bandwidth, index, attrs))
        if variants:
            _, index, attrs = max(variants, key=lambda item: item[0])
            selected = self.playlist(self.child_url(final_url, lines[index + 1]), depth + 1)
            output = ["#EXTM3U", "#EXT-X-VERSION:3"]
            audio_group = attrs.get("AUDIO")
            audio = [line for line in lines if line.startswith("#EXT-X-MEDIA:")
                     and self.attributes(line).get("TYPE") == "AUDIO"
                     and self.attributes(line).get("GROUP-ID") == audio_group]
            if audio:
                chosen = next((line for line in audio if self.attributes(line).get("DEFAULT") == "YES"), audio[0])
                match = URI_ATTRIBUTE.search(chosen)
                if match:
                    audio_file = self.playlist(self.child_url(final_url, match.group(1)), depth + 1)
                    chosen = URI_ATTRIBUTE.sub('URI="' + audio_file + '"', chosen)
                output.append(chosen)
            # Remove unrelated groups to keep this local master self-contained.
            stream_line = re.sub(r',?(?:SUBTITLES|CLOSED-CAPTIONS|VIDEO)=(?:"[^"]*"|[^,]*)', "", lines[index])
            if not audio:
                stream_line = re.sub(r',?AUDIO="[^"]*"', "", stream_line)
            output.extend([stream_line, selected])
        else:
            if "#EXT-X-ENDLIST" not in lines:
                raise DownloadError("진행 중인 생방송은 다운로드할 수 없습니다. 녹화가 끝난 뒤 시도해 주세요.")
            if any(line.startswith(("#EXT-X-PART:", "#EXT-X-PRELOAD-HINT:")) for line in lines):
                raise DownloadError("이 HLS 영상의 분할 형식은 아직 지원하지 않습니다.")
            resource_urls = set()
            for line in lines:
                if not line.startswith("#"):
                    resource_urls.add(self.child_url(final_url, line))
                elif line.startswith("#EXT-X-MAP:"):
                    match = URI_ATTRIBUTE.search(line)
                    if match:
                        resource_urls.add(self.child_url(final_url, match.group(1)))
            self.total_resources += len(resource_urls.difference(self.resources))
            output = []
            for line in lines:
                self.check_cancel()
                if not line.startswith("#"):
                    output.append(self.resource(self.child_url(final_url, line)))
                elif line.startswith("#EXT-X-MAP:"):
                    match = URI_ATTRIBUTE.search(line)
                    if not match:
                        raise DownloadError("HLS 초기화 파일 정보가 올바르지 않습니다.")
                    name = self.resource(self.child_url(final_url, match.group(1)))
                    output.append(URI_ATTRIBUTE.sub('URI="' + name + '"', line))
                elif "URI=" in line:
                    # Ignore metadata/renditions rather than handing hidden URLs
                    # to ffmpeg. Every supported resource is rewritten above.
                    if line.startswith("#EXT-X-KEY:"):
                        output.append("#EXT-X-KEY:METHOD=NONE")
                else:
                    output.append(line)
        name = hashlib.sha256((url + ":" + str(depth)).encode("utf-8")).hexdigest()[:32] + ".m3u8"
        (self.directory / name).write_text("\n".join(output) + "\n", encoding="utf-8")
        return name

    def prepare(self, url):
        path = urlsplit(url).path.lower()
        if path.endswith(".m3u8"):
            result = self.directory / self.playlist(url)
            self.progress(90)
            return result
        if not path.endswith((".mp4", ".m4v", ".m4a", ".mov", ".webm")):
            raise DownloadError("MP4 또는 HLS 영상 주소만 지원합니다.")
        destination = self.directory / "source.mp4"
        self.fetch(url, destination)
        return destination


class DownloadManager:
    def __init__(self, output=None, ffmpeg=None, ffprobe=None, start_worker=True, state_dir=None):
        self.state_dir = Path(state_dir) if state_dir is not None else ROOT / ".state"
        self.default_output = Path.home() / "Downloads"
        if output is None:
            try:
                saved = json.loads((self.state_dir / "settings.json").read_text(encoding="utf-8"))
                output = saved["outputDir"]
            except FileNotFoundError:
                output = self.default_output
            except (OSError, ValueError, KeyError, TypeError):
                raise RuntimeError("저장 폴더 설정 파일을 읽을 수 없습니다. .state/settings.json을 확인해 주세요.") from None
        self.output = output_directory(output)
        self.ffmpeg = ffmpeg or self.find_tool("ffmpeg")
        self.ffprobe = ffprobe or self.find_tool("ffprobe")
        if not self.ffmpeg:
            raise RuntimeError("ffmpeg가 필요합니다. Homebrew에서 brew install ffmpeg를 실행해 주세요.")
        if not self.ffprobe:
            raise RuntimeError("ffprobe가 필요합니다. Homebrew에서 brew install ffmpeg를 실행해 주세요.")
        self.lock = threading.RLock()
        self.jobs = {}
        self.request_jobs = {}
        self.cancelled_requests = set()
        self.pending = queue.Queue()
        self.stopping = threading.Event()
        self.worker = None
        self.load_completed_history()
        if start_worker:
            self.worker = threading.Thread(target=self.work, daemon=True, name="panopto-download")
            self.worker.start()

    @staticmethod
    def find_tool(name):
        found = shutil.which(name)
        if found:
            return found
        for directory in ("/opt/homebrew/bin", "/usr/local/bin"):
            path = Path(directory) / name
            if path.is_file() and os.access(str(path), os.X_OK):
                return str(path)
        return None

    def submit(self, payload):
        payload = validate_payload(payload)
        parsed = urlsplit(payload["pageUrl"])
        session_id = next((values[0] for key, values in parse_qs(parsed.query).items()
                           if key.lower() == "id" and values), None)
        identity = (parsed.hostname, session_id) if session_id else payload["pageUrl"].split("#", 1)[0]
        with self.lock:
            request_id = payload.get("requestId")
            if request_id in self.cancelled_requests:
                raise RequestCancelled("이미 취소된 다운로드 요청입니다.")
            if request_id in self.request_jobs:
                return self.request_jobs[request_id]
            fingerprint = hashlib.sha256(json.dumps([identity, str(self.output)], sort_keys=True).encode()).hexdigest()
            for job in self.jobs.values():
                if (job["fingerprint"] == fingerprint
                        and (job["status"] not in TERMINAL or self.completed_files_exist(job))):
                    if request_id:
                        self.request_jobs[request_id] = job["id"]
                    return job["id"]
            if sum(job["status"] not in TERMINAL for job in self.jobs.values()) >= MAX_ACTIVE_JOBS:
                raise QueueFull("대기 중인 다운로드가 너무 많습니다. 완료된 뒤 다시 시도해 주세요.")
            while len(self.jobs) >= MAX_HISTORY:
                oldest = next((key for key, job in self.jobs.items() if job["status"] in TERMINAL), None)
                if oldest is None:
                    break
                del self.jobs[oldest]
                self.request_jobs = {key: value for key, value in self.request_jobs.items() if value != oldest}
            job_id = secrets.token_hex(6)
            self.jobs[job_id] = {"id": job_id, "title": payload["title"], "status": "queued",
                                 "progress": 0, "error": None, "files": [], "payload": payload,
                                 "fingerprint": fingerprint, "cancel": threading.Event(),
                                 "process": None, "createdAt": time.time(),
                                 "requestId": payload.get("requestId"), "outputDir": str(self.output)}
            if request_id:
                self.request_jobs[request_id] = job_id
        self.pending.put(job_id)
        return job_id

    def snapshot(self):
        with self.lock:
            return [{key: job[key] for key in JOB_FIELDS}
                    for job in self.jobs.values()]

    def settings(self):
        with self.lock:
            return {"outputDir": str(self.output), "defaultOutputDir": str(self.default_output)}

    @staticmethod
    def completed_files_exist(job):
        if job["status"] != "completed" or not job["files"]:
            return False
        try:
            output = Path(job["outputDir"])
            return all((output / file["name"]).is_file()
                       and (output / file["name"]).stat().st_size == file["size"]
                       for file in job["files"])
        except OSError:
            return False

    def load_completed_history(self):
        """Only verified completed file metadata is persisted, never media URLs."""
        try:
            path = self.state_dir / "downloads.json"
            if path.stat().st_size > 1024 * 1024:
                return
            entries = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(entries, list):
                return
            for entry in entries[-MAX_HISTORY:]:
                if (not isinstance(entry, dict)
                        or not re.fullmatch(r"[a-f0-9]{12}", entry.get("id", ""))
                        or not re.fullmatch(r"[a-f0-9]{64}", entry.get("fingerprint", ""))
                        or not isinstance(entry.get("title"), str) or len(entry["title"]) > 1000
                        or not isinstance(entry.get("outputDir"), str) or not Path(entry["outputDir"]).is_absolute()
                        or not isinstance(entry.get("files"), list) or not 1 <= len(entry["files"]) <= MAX_STREAMS):
                    continue
                if any(not isinstance(file, dict)
                       or not isinstance(file.get("name"), str) or Path(file["name"]).name != file["name"]
                       or not file["name"] or not isinstance(file.get("size"), int) or file["size"] <= 0
                       for file in entry["files"]):
                    continue
                job = {key: entry[key] for key in ("id", "fingerprint", "title", "outputDir", "files")}
                job.update(status="completed", progress=100, error=None,
                           payload={"streams": [], "duration": None}, cancel=threading.Event(),
                           process=None, createdAt=0, requestId=None)
                if self.completed_files_exist(job):
                    self.jobs[job["id"]] = job
        except (OSError, ValueError, TypeError):
            # Damaged or stale optional history cannot prevent new downloads.
            pass

    def persist_completed_history(self):
        with self.lock:
            entries = [{key: job[key] for key in ("id", "fingerprint", "title", "outputDir", "files")}
                       for job in self.jobs.values() if self.completed_files_exist(job)]
            self.write_private_json("downloads.json", entries)

    def write_private_json(self, name, data):
        self.state_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(str(self.state_dir), 0o700)
        descriptor, temporary = tempfile.mkstemp(prefix="settings-", suffix=".json", dir=str(self.state_dir))
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as file:
                json.dump(data, file, ensure_ascii=False)
                file.write("\n")
            os.replace(temporary, self.state_dir / name)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def set_output_directory(self, value):
        output = output_directory(value)
        with self.lock:
            try:
                self.write_private_json("settings.json", {"outputDir": str(output)})
            except OSError:
                raise DownloadError("저장 폴더 설정을 저장하지 못했습니다. 로컬 서버의 접근 권한을 확인해 주세요.") from None
            self.output = output
            return self.settings()

    def update(self, job, **changes):
        with self.lock:
            job.update(changes)

    def cancel(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                return False
            if job["status"] in TERMINAL:
                return True
            job["cancel"].set()
            if job["status"] == "queued":
                job.update(status="cancelled", error=None)
                job["payload"] = {"streams": [], "duration": None}
            process = job["process"]
            if process and process.poll() is None:
                process.terminate()
            return True

    def cancel_request(self, request_id):
        request_id = validate_request_id(request_id)
        with self.lock:
            if request_id not in self.cancelled_requests and len(self.cancelled_requests) >= MAX_CANCEL_REQUESTS:
                raise CancellationLimit("요청 취소 기록의 허용 수를 초과했습니다. 로컬 서버를 다시 시작해 주세요.")
            # submit() checks this same set while holding this same lock. After
            # acknowledgement, an earlier HTTP request cannot create a late job.
            self.cancelled_requests.add(request_id)
            job_id = self.request_jobs.get(request_id)
            job = self.jobs.get(job_id)
            if job:
                self.cancel(job_id)
            return {"ok": True, "requestId": request_id,
                    "job": {key: job[key] for key in JOB_FIELDS} if job else None}

    def close(self):
        self.stopping.set()
        with self.lock:
            ids = list(self.jobs)
        for job_id in ids:
            self.cancel(job_id)
        self.pending.put(None)
        if self.worker:
            self.worker.join(timeout=3)

    def work(self):
        while not self.stopping.is_set():
            job_id = self.pending.get()
            if job_id is None:
                break
            with self.lock:
                job = self.jobs.get(job_id)
            if not job or job["cancel"].is_set():
                continue
            self.run_job(job)

    def run_ffmpeg(self, job, source, part, stream_index, count):
        command = [self.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
                   "-protocol_whitelist", "file,pipe"]
        if source.suffix == ".m3u8":
            command += ["-allowed_extensions", "ALL"]
        command += ["-i", str(source), "-map", "0:v:0?", "-map", "0:a:0?",
                    "-c", "copy", "-movflags", "+faststart", "-progress", "pipe:1",
                    "-nostats", "-n", str(part)]
        # stderr is kept local and never returned: even unexpected demuxer errors
        # must not disclose signed media URLs in the browser or console.
        with tempfile.TemporaryFile() as errors:
            try:
                process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors,
                                           text=True, bufsize=1)
            except OSError:
                raise DownloadError("ffmpeg를 실행하지 못했습니다. 설치 상태를 확인해 주세요.") from None
            self.update(job, process=process)
            try:
                for line in process.stdout:
                    if job["cancel"].is_set():
                        process.terminate()
                        break
                    if line.startswith("out_time_us=") and job["payload"].get("duration"):
                        try:
                            ratio = int(line.split("=", 1)[1]) / 1000000 / job["payload"]["duration"]
                            progress = (stream_index + .9 + min(.09, ratio * .09)) / count * 100
                            self.update(job, progress=round(progress, 1))
                        except ValueError:
                            pass
                try:
                    code = process.wait(timeout=15 if job["cancel"].is_set() else 300)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                    if job["cancel"].is_set():
                        raise Cancelled("다운로드를 취소했습니다.")
                    raise DownloadError("영상 파일을 저장하는 데 시간이 너무 오래 걸렸습니다.") from None
                if job["cancel"].is_set():
                    raise Cancelled("다운로드를 취소했습니다.")
                if code != 0 or not part.exists() or part.stat().st_size < 100:
                    raise DownloadError("영상 파일을 MP4로 저장하지 못했습니다. 이 영상의 코덱 또는 재생 목록을 지원하지 않을 수 있습니다.")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                process.stdout.close()
                self.update(job, process=None)

    def verify(self, part, duration=None):
        if not self.ffprobe:
            raise DownloadError("다운로드 검증에 ffprobe가 필요합니다. ffmpeg를 다시 설치해 주세요.")
        try:
            result = subprocess.run([self.ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe",
                                     "-show_entries", "format=duration:stream=codec_type", "-of", "json", str(part)],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=30)
            data = json.loads(result.stdout)
            actual = float(data.get("format", {}).get("duration", 0))
            streams = data.get("streams", [])
            if result.returncode or not math.isfinite(actual) or actual <= 0 or not any(
                    stream.get("codec_type") in {"video", "audio"} for stream in streams):
                raise ValueError()
            # Playback metadata can cover multiple streams whose lengths differ;
            # only reject gross truncation, not short introductions/late starts.
            if duration and actual < duration * 0.8:
                raise DownloadError("저장된 영상이 원본 길이보다 많이 짧습니다. 완료 파일로 처리하지 않았습니다.")
        except DownloadError:
            raise
        except (OSError, ValueError, subprocess.TimeoutExpired):
            raise DownloadError("저장된 영상 파일을 검증하지 못했습니다. 완료 파일로 처리하지 않았습니다.") from None

    def run_job(self, job):
        parts = []
        try:
            with self.lock:
                if job["cancel"].is_set():
                    raise Cancelled()
                output = Path(job["outputDir"])
                streams = list(job["payload"]["streams"])
                # Claim the queued job before cancel() can clear its payload.
                job["status"] = "downloading"
            for index, stream in enumerate(streams):
                if job["cancel"].is_set():
                    raise Cancelled()
                self.update(job, status="downloading")
                with tempfile.TemporaryDirectory(prefix=".panopto-", dir=str(output)) as temporary:
                    progress = lambda value: self.update(job, progress=round((index + value / 100) / len(streams) * 100, 1))
                    mirror = MediaMirror(temporary, job["cancel"], progress)
                    source = mirror.prepare(stream["url"])
                    title = safe_filename(job["title"])
                    suffix = " - " + safe_filename(stream["name"], "영상") if len(streams) > 1 else ""
                    # Keep the whole name within common filesystem byte limits.
                    name = safe_filename(title + suffix) + " [" + job["id"] + "]"
                    if len(streams) > 1:
                        name += "-%02d" % (index + 1)
                    destination = output / (name + ".mp4")
                    part = output / ("." + name + ".part.mp4")
                    parts.append(part)
                    if part.exists() or destination.exists():
                        raise DownloadError("같은 이름의 파일이 이미 있습니다. 기존 파일을 보호하기 위해 중단했습니다.")
                    self.update(job, status="processing")
                    self.run_ffmpeg(job, source, part, index, len(streams))
                    self.verify(part, job["payload"].get("duration") if len(streams) == 1 else None)
                    if job["cancel"].is_set():
                        raise Cancelled()
                    publish_no_overwrite(part, destination)
                    part.unlink()
                    with self.lock:
                        job["files"].append({"name": destination.name, "size": destination.stat().st_size})
            with self.lock:
                if job["cancel"].is_set():
                    raise Cancelled()
                job.update(status="completed", progress=100)
            try:
                self.persist_completed_history()
            except OSError:
                # The verified files remain completed if optional history fails.
                pass
        except Cancelled:
            self.update(job, status="cancelled", error=None)
        except DownloadError as exc:
            self.update(job, status="failed", error=str(exc))
        except Exception:
            self.update(job, status="failed", error="다운로드 중 오류가 발생했습니다. 다시 시도해 주세요.")
        finally:
            for part in parts:
                try:
                    part.unlink(missing_ok=True)
                except OSError:
                    pass
            # Signed URLs exist only for an active job. Clear them on completion.
            with self.lock:
                job["payload"] = {"streams": [], "duration": None}


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, manager, token, root=ROOT):
        self.manager = manager
        self.token = token
        self.root = Path(root)
        super().__init__(address, RequestHandler)
        self.base_url = "http://127.0.0.1:%d" % self.server_port
        self.hosts = {"127.0.0.1:%d" % self.server_port, "localhost:%d" % self.server_port}
        self.origins = {self.base_url, "http://localhost:%d" % self.server_port, "null"}

    def trusted_origin(self, origin):
        return origin in self.origins or panopto_origin(origin) or extension_origin(origin)

    def bookmarklet(self):
        source = (self.root / "bookmarklet.js").read_text(encoding="utf-8")
        script = source.replace("__TOKEN__", self.token).replace("__BASE_URL__", self.base_url).strip().removeprefix("javascript:")
        return "javascript:" + quote(script, safe="")


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "PanoptoLocal/1.0"

    def log_message(self, format, *args):
        pass

    def respond(self, status, body, content_type="application/json; charset=utf-8", headers=None):
        if not isinstance(body, bytes):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        origin = self.headers.get("Origin")
        path = urlsplit(self.path).path
        if extension_origin(origin) and (path.startswith("/api/") or path == "/health"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        if headers:
            for key, value in headers.items():
                self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def error(self, status, message):
        self.respond(status, json.dumps({"error": message}, ensure_ascii=False))

    def valid_host(self):
        if self.headers.get("Host", "").lower() not in self.server.hosts:
            self.error(403, "로컬 주소에서만 사용할 수 있습니다.")
            return False
        return True

    def valid_token(self, value):
        return isinstance(value, str) and hmac.compare_digest(value, self.server.token)

    def authorized(self, token, mutation=False, allow_missing_origin=False):
        if not self.valid_token(token):
            self.error(403, "인증 토큰이 올바르지 않습니다. 로컬 시작 페이지에서 연결 토큰을 확인해 주세요.")
            return False
        origin = self.headers.get("Origin")
        if (mutation and not self.server.trusted_origin(origin)
                and not (origin is None and allow_missing_origin)):
            self.error(403, "허용되지 않은 페이지에서 보낸 요청입니다.")
            return False
        return True

    def do_OPTIONS(self):
        if not self.valid_host():
            return
        path = urlsplit(self.path).path
        requested_headers = {value.strip().lower() for value in self.headers.get(
            "Access-Control-Request-Headers", "").split(",") if value.strip()}
        if (not extension_origin(self.headers.get("Origin"))
                or not (path.startswith("/api/") or path == "/health")
                or self.headers.get("Access-Control-Request-Method") not in {"GET", "POST"}
                or not requested_headers <= {"content-type", "x-panopto-token"}):
            self.error(403, "허용되지 않은 확장 프로그램 요청입니다.")
            return
        headers = {"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                   "Access-Control-Allow-Headers": "Content-Type, X-Panopto-Token"}
        if self.headers.get("Access-Control-Request-Private-Network") == "true":
            headers["Access-Control-Allow-Private-Network"] = "true"
        self.respond(204, "", headers=headers)

    def read_body(self, content_type):
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != content_type:
            self.error(415, "요청 데이터 형식이 올바르지 않습니다.")
            return None
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_PAYLOAD:
                raise ValueError()
        except ValueError:
            self.error(413, "요청 데이터가 없거나 너무 큽니다.")
            return None
        self.connection.settimeout(10)
        return self.rfile.read(length).decode("utf-8")

    def do_GET(self):
        if not self.valid_host():
            return
        path = urlsplit(self.path).path
        if path == "/health":
            self.respond(200, json.dumps({"ok": True, "service": "panopto-download", "protocolVersion": 1,
                                        "capabilities": ["jobs", "settings", "extension-cors", "request-cancel"],
                                        "maxActiveJobs": MAX_ACTIVE_JOBS}))
        elif path == "/api/jobs":
            if self.authorized(self.headers.get("X-Panopto-Token")):
                self.respond(200, json.dumps({"jobs": self.server.manager.snapshot()}, ensure_ascii=False))
        elif path == "/api/settings":
            if self.authorized(self.headers.get("X-Panopto-Token")):
                self.respond(200, json.dumps(self.server.manager.settings(), ensure_ascii=False))
        elif path == "/bookmarklet.txt":
            self.respond(200, self.server.bookmarklet(), "text/plain; charset=utf-8")
        elif path == "/":
            try:
                page = (self.server.root / "static" / "index.html").read_text(encoding="utf-8")
                page = page.replace("__TOKEN__", self.server.token).replace("__BOOKMARKLET__", html.escape(self.server.bookmarklet(), quote=True))
                page = page.replace("__OUTPUT_DIR__", html.escape(str(self.server.manager.output)))
                self.respond(200, page, "text/html; charset=utf-8")
            except OSError:
                self.error(500, "시작 페이지 파일을 찾을 수 없습니다.")
        else:
            self.error(404, "페이지를 찾을 수 없습니다.")

    def do_POST(self):
        if not self.valid_host():
            return
        path = urlsplit(self.path).path
        cancel_match = re.fullmatch(r"/api/jobs/([a-f0-9]{12})/cancel", path)
        if cancel_match:
            if not self.authorized(self.headers.get("X-Panopto-Token"), mutation=True, allow_missing_origin=True):
                return
            if self.server.manager.cancel(cancel_match.group(1)):
                self.respond(200, '{"ok":true}')
            else:
                self.error(404, "다운로드 작업을 찾을 수 없습니다.")
            return
        if path in {"/api/jobs", "/api/settings", "/api/cancel-request"}:
            if not self.authorized(self.headers.get("X-Panopto-Token"), mutation=True, allow_missing_origin=True):
                return
            try:
                body = self.read_body("application/json")
                if body is None:
                    return
                data = json.loads(body)
                if path == "/api/cancel-request":
                    if not isinstance(data, dict) or set(data) != {"requestId"}:
                        raise DownloadError("취소할 다운로드 요청 식별자가 필요합니다.")
                    result = self.server.manager.cancel_request(data["requestId"])
                    status = 200
                elif path == "/api/settings":
                    if not isinstance(data, dict) or set(data) != {"outputDir"}:
                        raise DownloadError("저장 폴더 경로를 outputDir에 입력해 주세요.")
                    result = self.server.manager.set_output_directory(data["outputDir"])
                    status = 200
                else:
                    job_id = self.server.manager.submit(data)
                    result = next(job for job in self.server.manager.snapshot() if job["id"] == job_id)
                    status = 201
            except RequestCancelled as exc:
                self.error(409, str(exc))
                return
            except CancellationLimit as exc:
                self.error(503, str(exc))
                return
            except QueueFull as exc:
                self.respond(429, json.dumps({"error": str(exc)}, ensure_ascii=False), headers={"Retry-After": "5"})
                return
            except DownloadError as exc:
                self.error(400, str(exc))
                return
            except (ValueError, UnicodeDecodeError, socket.timeout):
                self.error(400, "요청 데이터를 읽을 수 없습니다.")
                return
            self.respond(status, json.dumps(result, ensure_ascii=False))
            return
        if path != "/download":
            self.error(404, "페이지를 찾을 수 없습니다.")
            return
        try:
            body = self.read_body("application/x-www-form-urlencoded")
            if body is None:
                return
            fields = parse_qs(body, max_num_fields=4, strict_parsing=True)
            if any(len(value) != 1 for value in fields.values()):
                raise ValueError()
            token = fields.get("token", [None])[0]
            if not self.authorized(token, mutation=True):
                return
            payload = json.loads(fields.get("payload", [""])[0])
            job_id = self.server.manager.submit(payload)
        except DownloadError as exc:
            self.error(400, str(exc))
            return
        except (ValueError, UnicodeDecodeError, socket.timeout):
            self.error(400, "요청의 영상 정보를 읽을 수 없습니다.")
            return
        target = "/?job=" + quote(job_id)
        self.respond(303, '<!doctype html><html lang="ko"><meta charset="utf-8"><p>다운로드를 시작했습니다. <a href="' + target + '">진행 상황 보기</a></p></html>',
                     "text/html; charset=utf-8", {"Location": target})


def main(argv=None):
    parser = argparse.ArgumentParser(description="Safari에서 선택한 Panopto 영상을 로컬 MP4로 저장합니다.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--output", type=Path, help="이번 실행의 저장 폴더 (기본: 저장된 설정 또는 ~/Downloads)")
    parser.add_argument("--no-browser", action="store_true", help="호환 옵션: 브라우저는 자동으로 열지 않습니다.")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("포트는 1~65535 범위여야 합니다.")
    manager = None
    try:
        token = load_token(ROOT / ".state")
        manager = DownloadManager(args.output)
        server = LocalServer(("127.0.0.1", args.port), manager, token)
    except (DownloadError, RuntimeError, OSError) as exc:
        parser.exit(1, "시작할 수 없습니다: %s\n" % exc)
    print("Panopto 다운로드 시작 페이지: " + server.base_url, flush=True)
    print("저장 폴더: " + str(manager.output), flush=True)
    print("종료하려면 Ctrl+C를 누르세요.", flush=True)
    try:
        server.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        pass
    finally:
        manager.close()
        server.server_close()


if __name__ == "__main__":
    main()
