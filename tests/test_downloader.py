import http.client
import errno
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlencode
from urllib.parse import urlsplit

import panopto_download as downloader


def payload(url="https://s-cloudfront.cdn.ap.panopto.com/sessions/example/master.m3u8"):
    return {"title": "강의 / 1", "pageUrl": "https://kaist.ap.panopto.com/Panopto/Pages/Viewer.aspx?id=example",
            "duration": 120.5, "streams": [{"url": url, "name": "화면"}]}


class ValidationTests(unittest.TestCase):
    def test_filename_cannot_escape_output_and_fits_filesystem(self):
        name = downloader.safe_filename("../비디오/" + "한" * 200 + "\n?.mp4")
        self.assertNotIn("/", name)
        self.assertNotIn("\n", name)
        self.assertLessEqual(len(name.encode()), 160)
        self.assertFalse(name.startswith("."))
        self.assertEqual(downloader.safe_filename("CON"), "_CON")

    def test_allowlist_rejects_non_https_credentials_ports_and_lookalikes(self):
        for url in ["http://kaist.ap.panopto.com/video.mp4", "https://127.0.0.1/video.mp4",
                    "https://panopto.com.attacker.test/video.mp4", "file:///tmp/a",
                    "https://user:secret@kaist.ap.panopto.com/a.mp4",
                    "https://kaist.ap.panopto.com:8443/a.mp4", "https://[::1]/a.mp4"]:
            with self.subTest(url=url), self.assertRaises(downloader.DownloadError):
                downloader.validate_media_url(url)
        self.assertEqual(downloader.validate_media_url("https://s-cloudfront.cdn.ap.panopto.com/a.mp4#x"),
                         "https://s-cloudfront.cdn.ap.panopto.com/a.mp4")

    def test_public_dns_check_and_redirects(self):
        private = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]
        with patch.object(socket, "getaddrinfo", return_value=private):
            with self.assertRaises(downloader.DownloadError):
                downloader.validate_media_url("https://kaist.ap.panopto.com/a.mp4", resolve=True)
        with self.assertRaises(downloader.DownloadError):
            downloader.SafeRedirect().redirect_request(None, None, 302, "", {}, "https://127.0.0.1/secret")

    def test_payload_deduplicates_streams_and_validates_origin(self):
        data = payload()
        data["streams"] *= 2
        self.assertEqual(len(downloader.validate_payload(data)["streams"]), 1)
        for bad in ["https://attacker.test/", "https://kaist.ap.panopto.com@attacker.test/"]:
            data["pageUrl"] = bad
            with self.assertRaises(downloader.DownloadError):
                downloader.validate_payload(data)

    def test_other_panopto_tenants_are_supported_without_weakening_origin_validation(self):
        data = payload()
        data["pageUrl"] = "https://university.eu.panopto.com/Panopto/Pages/Viewer.aspx?id=lecture"
        self.assertEqual(downloader.validate_payload(data)["pageUrl"], data["pageUrl"])
        for bad in ["https://university.eu.panopto.com:8443/", "https://user@kaist.ap.panopto.com/",
                    "http://kaist.ap.panopto.com/", "https://panopto.com.attacker.test/"]:
            data["pageUrl"] = bad
            with self.subTest(url=bad), self.assertRaises(downloader.DownloadError):
                downloader.validate_payload(data)

    def test_duration_must_be_finite(self):
        for value in [float("nan"), float("inf"), True, -1, "120"]:
            data = payload()
            data["duration"] = value
            with self.assertRaises(downloader.DownloadError):
                downloader.validate_payload(data)

    def test_token_is_persistent_and_private(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state"
            first = downloader.load_token(path)
            self.assertEqual(first, downloader.load_token(path))
            self.assertEqual((path / "token").stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)


class MirrorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.cancel = threading.Event()
        self.mirror = downloader.MediaMirror(self.directory, self.cancel)

    def tearDown(self):
        self.temporary.cleanup()

    def fake_fetch(self, resources, calls):
        def fetch(url, destination=None, limit=None):
            calls.append(url)
            data = resources[url]
            if destination:
                Path(destination).write_bytes(data)
                return len(data), url
            return data, url
        return fetch

    def test_relative_manifest_query_inheritance(self):
        base = "https://cdn.ap.panopto.com/video/master.m3u8?Policy=secret"
        self.assertEqual(self.mirror.child_url(base, "720/index.m3u8"),
                         "https://cdn.ap.panopto.com/video/720/index.m3u8?Policy=secret")
        self.assertEqual(self.mirror.child_url(base, "720/index.m3u8?own=1"),
                         "https://cdn.ap.panopto.com/video/720/index.m3u8?own=1")
        with self.assertRaises(downloader.DownloadError):
            self.mirror.child_url(base, "https://localhost/secret")

    def test_highest_variant_and_byteranges_fetch_shared_mp4_only_once(self):
        base = "https://cdn.ap.panopto.com/video/"
        master = base + "master.m3u8?Policy=secret"
        high = base + "720/index.m3u8?Policy=secret"
        media = base + "720/fragmented.mp4?Policy=secret"
        resources = {
            master: b'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10\n360/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=20\n720/index.m3u8\n',
            high: b'#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:9\n#EXT-X-MAP:URI="fragmented.mp4",BYTERANGE="100@0"\n#EXTINF:9,\n#EXT-X-BYTERANGE:500@100\nfragmented.mp4\n#EXTINF:9,\n#EXT-X-BYTERANGE:400@600\nfragmented.mp4\n#EXT-X-ENDLIST\n',
            media: b"mock-video" * 200,
        }
        calls = []
        self.mirror.fetch = self.fake_fetch(resources, calls)
        result = self.mirror.prepare(master)
        self.assertTrue(result.exists())
        self.assertEqual(calls, [master, high, media])
        manifests = "\n".join(path.read_text() for path in self.directory.glob("*.m3u8"))
        self.assertIn('BYTERANGE="100@0"', manifests)
        self.assertIn("#EXT-X-BYTERANGE:500@100", manifests)
        self.assertNotIn("https:", manifests)
        self.assertNotIn("Policy=", manifests)

    def test_audio_rendition_is_mirrored(self):
        base = "https://cdn.ap.panopto.com/"
        resources = {
            base + "master.m3u8": b'#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=10,AUDIO="a"\nvideo.m3u8\n',
            base + "video.m3u8": b'#EXTM3U\n#EXTINF:1,\nv.ts\n#EXT-X-ENDLIST\n',
            base + "audio.m3u8": b'#EXTM3U\n#EXTINF:1,\na.aac\n#EXT-X-ENDLIST\n',
            base + "v.ts": b"video",
            base + "a.aac": b"audio",
        }
        calls = []
        self.mirror.fetch = self.fake_fetch(resources, calls)
        result = self.mirror.prepare(base + "master.m3u8")
        self.assertIn("#EXT-X-MEDIA:TYPE=AUDIO", result.read_text())
        self.assertIn(base + "a.aac", calls)

    def test_encrypted_or_live_playlist_fails_before_media_fetch(self):
        url = "https://cdn.ap.panopto.com/master.m3u8"
        for text in [b'#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST\n',
                     b'#EXTM3U\n#EXTINF:1,\na.ts\n']:
            calls = []
            self.mirror.fetch = self.fake_fetch({url: text}, calls)
            with self.assertRaises(downloader.DownloadError):
                self.mirror.prepare(url)
            self.assertEqual(calls, [url])

    def test_cancel_before_network(self):
        self.cancel.set()
        with self.assertRaises(downloader.Cancelled):
            self.mirror.fetch("https://cdn.ap.panopto.com/video.mp4")


class PublishingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.part = self.root / "video.part.mp4"
        self.part.write_bytes(b"verified video" * 100)
        self.destination = self.root / "video.mp4"

    def tearDown(self):
        self.temporary.cleanup()

    def test_unsupported_hardlink_falls_back_to_complete_exclusive_copy(self):
        for code in [errno.EOPNOTSUPP, errno.ENOSYS, errno.EPERM, errno.EXDEV]:
            with self.subTest(errno=code), patch.object(downloader.os, "link", side_effect=OSError(code, "unsupported")):
                downloader.publish_no_overwrite(self.part, self.destination)
            self.assertEqual(self.destination.read_bytes(), self.part.read_bytes())
            self.assertTrue(self.part.exists())
            self.destination.unlink()

    def test_fallback_never_overwrites_or_removes_existing_destination(self):
        self.destination.write_bytes(b"original")
        with patch.object(downloader.os, "link", side_effect=OSError(errno.EOPNOTSUPP, "unsupported")):
            with self.assertRaises(FileExistsError):
                downloader.publish_no_overwrite(self.part, self.destination)
        self.assertEqual(self.destination.read_bytes(), b"original")
        self.assertTrue(self.part.exists())

    def test_failed_copy_removes_only_its_created_destination_and_retains_part(self):
        def partial_copy(source, output, length):
            output.write(b"partial")
            raise OSError(errno.ENOSPC, "full")

        with patch.object(downloader.os, "link", side_effect=OSError(errno.EOPNOTSUPP, "unsupported")), \
                patch.object(downloader.shutil, "copyfileobj", side_effect=partial_copy):
            with self.assertRaises(OSError):
                downloader.publish_no_overwrite(self.part, self.destination)
        self.assertFalse(self.destination.exists())
        self.assertEqual(self.part.read_bytes(), b"verified video" * 100)


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.manager = downloader.DownloadManager(self.root / "output", ffmpeg="mock-ffmpeg", ffprobe="mock-ffprobe",
                                                  start_worker=False, state_dir=self.root / "state")

    def tearDown(self):
        self.manager.close()
        self.temporary.cleanup()

    def test_duplicate_active_submission_reuses_job(self):
        first = self.manager.submit(payload())
        self.assertEqual(self.manager.submit(payload()), first)
        self.assertEqual(len(self.manager.snapshot()), 1)

    def test_refreshed_signed_urls_reuse_active_session_in_same_directory(self):
        first = self.manager.submit(payload())
        refreshed = payload("https://cdn.ap.panopto.com/other/master.m3u8?signature=refreshed")
        self.assertEqual(self.manager.submit(refreshed), first)

    def test_settings_persist_and_each_job_keeps_its_submitted_directory(self):
        original = self.manager.output
        first = self.manager.submit(payload())
        target = self.root / "new downloads"
        settings = self.manager.set_output_directory(str(target))
        second = self.manager.submit(payload())
        self.assertNotEqual(first, second)
        self.assertEqual(self.manager.jobs[first]["outputDir"], str(original))
        self.assertEqual(self.manager.jobs[second]["outputDir"], str(target))
        self.assertEqual(settings["defaultOutputDir"], str(Path.home() / "Downloads"))
        self.assertEqual((self.root / "state" / "settings.json").stat().st_mode & 0o777, 0o600)
        completed = self.run_job_with_mock_media(job=self.manager.jobs[first])
        filename = completed["files"][0]["name"]
        self.assertTrue((original / filename).is_file())
        self.assertFalse((target / filename).exists())
        restored = downloader.DownloadManager(ffmpeg="mock", ffprobe="mock", start_worker=False, state_dir=self.root / "state")
        try:
            self.assertEqual(restored.output, target)
        finally:
            restored.close()

    def test_invalid_directory_does_not_change_settings(self):
        original = self.manager.output
        file = self.root / "regular-file"
        file.write_text("example")
        for value in ["", "relative/path", "~/bad\x00path", "~somebody/Downloads", str(file), None]:
            with self.subTest(value=value), self.assertRaises(downloader.DownloadError):
                self.manager.set_output_directory(value)
        self.assertEqual(self.manager.output, original)

    def test_cancel_queued_job(self):
        job_id = self.manager.submit(payload())
        self.assertTrue(self.manager.cancel(job_id))
        self.assertEqual(self.manager.snapshot()[0]["status"], "cancelled")
        self.assertFalse(self.manager.cancel("missing"))

    def test_cancelled_queued_job_cannot_become_completed_when_worker_enters(self):
        job_id = self.manager.submit(payload())
        self.manager.cancel(job_id)
        with patch.object(downloader.MediaMirror, "prepare") as prepare:
            self.manager.run_job(self.manager.jobs[job_id])
        job = self.manager.snapshot()[0]
        self.assertEqual(job["status"], "cancelled")
        self.assertEqual(job["files"], [])
        self.assertEqual(job["progress"], 0)
        prepare.assert_not_called()

    def run_job_with_mock_media(self, fail=False, cancel=False, job=None):
        if job is None:
            job_id = self.manager.submit(payload("https://cdn.ap.panopto.com/video.mp4"))
            job = self.manager.jobs[job_id]

        def prepare(mirror, url):
            destination = mirror.directory / "source.mp4"
            destination.write_bytes(b"source")
            return destination

        def remux(job, source, part, index, count):
            part.write_bytes(b"video" * 100)
            if fail:
                raise downloader.DownloadError("변환 실패")
            if cancel:
                job["cancel"].set()

        with patch.object(downloader.MediaMirror, "prepare", prepare), \
                patch.object(self.manager, "run_ffmpeg", side_effect=remux), \
                patch.object(self.manager, "verify"):
            self.manager.run_job(job)
        return job

    def test_success_publishes_verified_file_and_clears_signed_urls(self):
        job = self.run_job_with_mock_media()
        self.assertEqual(job["status"], "completed")
        self.assertEqual(len(job["files"]), 1)
        self.assertEqual(job["files"][0]["size"], 500)
        self.assertTrue((self.manager.output / job["files"][0]["name"]).exists())
        self.assertNotIn("cdn.ap", json.dumps(job["payload"]))
        self.assertEqual(list(self.manager.output.glob("*.part.mp4")), [])

    def test_completed_session_is_reused_after_restart_until_its_file_is_removed(self):
        job = self.run_job_with_mock_media()
        metadata = (self.root / "state" / "downloads.json").read_text()
        self.assertNotIn("https:", metadata)
        restored = downloader.DownloadManager(self.manager.output, ffmpeg="mock", ffprobe="mock", start_worker=False,
                                              state_dir=self.root / "state")
        try:
            self.assertEqual(restored.submit(payload()), job["id"])
            (self.manager.output / job["files"][0]["name"]).unlink()
            self.assertNotEqual(restored.submit(payload()), job["id"])
        finally:
            restored.close()

    def test_request_id_is_idempotent_after_terminal_job(self):
        data = payload()
        data["requestId"] = "batch-123:session-456"
        job_id = self.manager.submit(data)
        self.assertEqual(self.manager.snapshot()[0]["requestId"], data["requestId"])
        self.manager.cancel(job_id)
        self.assertEqual(self.manager.submit(data), job_id)
        self.assertEqual(self.manager.snapshot()[0]["requestId"], data["requestId"])

    def test_cancel_request_tombstone_blocks_submit_waiting_on_the_same_lock(self):
        data = payload()
        data["requestId"] = "batch-123:session-456"
        ready = threading.Event()
        outcomes = []

        def submit():
            ready.set()
            try:
                outcomes.append(self.manager.submit(data))
            except downloader.DownloadError as exc:
                outcomes.append(exc)

        with self.manager.lock:
            thread = threading.Thread(target=submit)
            thread.start()
            self.assertTrue(ready.wait(timeout=2))
            result = self.manager.cancel_request(data["requestId"])
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertIsNone(result["job"])
        self.assertIsInstance(outcomes[0], downloader.RequestCancelled)
        self.assertEqual(self.manager.snapshot(), [])

    def test_cancel_request_cancels_an_accepted_canonical_session_alias(self):
        first = payload()
        first["requestId"] = "first-batch:session"
        job_id = self.manager.submit(first)
        second = payload()
        second["requestId"] = "second-batch:session"
        self.assertEqual(self.manager.submit(second), job_id)
        result = self.manager.cancel_request(second["requestId"])
        self.assertEqual(result["requestId"], second["requestId"])
        self.assertEqual(result["job"]["id"], job_id)
        self.assertEqual(result["job"]["status"], "cancelled")
        with self.assertRaises(downloader.RequestCancelled):
            self.manager.submit(second)

    def test_cancel_request_capacity_retains_tombstones_and_allows_idempotent_cancel(self):
        with patch.object(downloader, "MAX_CANCEL_REQUESTS", 1):
            self.assertTrue(self.manager.cancel_request("first-request")["ok"])
            with self.assertRaises(downloader.CancellationLimit):
                self.manager.cancel_request("second-request")
            self.assertTrue(self.manager.cancel_request("first-request")["ok"])
        self.assertEqual(self.manager.cancelled_requests, {"first-request"})
        data = payload()
        data["requestId"] = "first-request"
        with self.assertRaises(downloader.RequestCancelled):
            self.manager.submit(data)

    def test_failed_remux_never_publishes_part_file(self):
        job = self.run_job_with_mock_media(fail=True)
        self.assertEqual(job["status"], "failed")
        self.assertEqual(job["files"], [])
        self.assertEqual(list(self.manager.output.iterdir()), [])

    def test_cancel_during_remux_never_publishes_part_file(self):
        job = self.run_job_with_mock_media(cancel=True)
        self.assertEqual(job["status"], "cancelled")
        self.assertEqual(list(self.manager.output.iterdir()), [])

    def test_existing_final_file_is_never_overwritten(self):
        job_id = self.manager.submit(payload("https://cdn.ap.panopto.com/video.mp4"))
        job = self.manager.jobs[job_id]
        name = downloader.safe_filename(job["title"]) + " [" + job_id + "].mp4"
        destination = self.manager.output / name
        destination.write_bytes(b"original")
        with patch.object(downloader.MediaMirror, "prepare", return_value=Path("/unused/source.mp4")):
            self.manager.run_job(job)
        self.assertEqual(job["status"], "failed")
        self.assertEqual(destination.read_bytes(), b"original")


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        (self.root / "static").mkdir()
        (self.root / "static" / "index.html").write_text('__TOKEN__ <a href="__BOOKMARKLET__">download</a> __OUTPUT_DIR__')
        (self.root / "bookmarklet.js").write_text('alert("__TOKEN__ __BASE_URL__");')
        self.manager = downloader.DownloadManager(self.root / "output", ffmpeg="mock", ffprobe="mock", start_worker=False,
                                                  state_dir=self.root / "state")
        self.token = "t" * 43
        self.server = downloader.LocalServer(("127.0.0.1", 0), self.manager, self.token, root=self.root)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.manager.close()
        self.temporary.cleanup()

    def request(self, method, path, body=None, headers=None):
        client = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        client.request(method, path, body=body, headers=headers or {})
        response = client.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        client.close()
        return result

    def post(self, token=None, origin=downloader.KAIST_ORIGIN):
        body = urlencode({"token": self.token if token is None else token, "payload": json.dumps(payload())})
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        if origin is not None:
            headers["Origin"] = origin
        return self.request("POST", "/download", body, headers)

    def api(self, path, data, origin=None, token=None):
        headers = {"Content-Type": "application/json", "X-Panopto-Token": self.token if token is None else token}
        if origin is not None:
            headers["Origin"] = origin
        return self.request("POST", path, json.dumps(data), headers)

    def test_health_and_template_rendering(self):
        status, headers, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertNotIn(b"__TOKEN__", body)
        self.assertIn(b"javascript:alert%28%22", body)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_job_submit_redirect_and_private_status(self):
        status, headers, body = self.post()
        self.assertEqual(status, 303)
        self.assertTrue(headers["Location"].startswith("/?job="))
        self.assertEqual(self.request("GET", "/api/jobs")[0], 403)
        status, _, body = self.request("GET", "/api/jobs", headers={"X-Panopto-Token": self.token})
        self.assertEqual(status, 200)
        jobs = json.loads(body)["jobs"]
        self.assertEqual(len(jobs), 1)
        self.assertNotIn("payload", jobs[0])
        self.assertNotIn(b"https://cdn", body)

    def test_wrong_token_origin_and_missing_origin_are_rejected(self):
        self.assertEqual(self.post(token="bad")[0], 403)
        self.assertEqual(self.post(origin="https://attacker.test")[0], 403)
        self.assertEqual(self.post(origin=None)[0], 403)
        self.assertEqual(self.manager.snapshot(), [])

    def test_safari_null_origin_requires_valid_token(self):
        self.assertEqual(self.post(origin="null", token="bad")[0], 403)
        self.assertEqual(self.post(origin="null")[0], 303)

    def test_dns_rebinding_host_is_rejected(self):
        self.assertEqual(self.request("GET", "/", headers={"Host": "attacker.test"})[0], 403)

    def test_cancel_requires_token_and_local_or_kaist_origin(self):
        self.post()
        job_id = self.manager.snapshot()[0]["id"]
        path = "/api/jobs/" + job_id + "/cancel"
        self.assertEqual(self.request("POST", path)[0], 403)
        headers = {"X-Panopto-Token": self.token, "Origin": self.server.base_url}
        self.assertEqual(self.request("POST", path, headers=headers)[0], 200)
        self.assertEqual(self.manager.snapshot()[0]["status"], "cancelled")

    def test_oversized_form_is_rejected_before_reading_body(self):
        status, _, _ = self.request("POST", "/download", headers={
            "Content-Type": "application/x-www-form-urlencoded", "Content-Length": str(downloader.MAX_PAYLOAD + 1)})
        self.assertEqual(status, 413)

    def test_extension_cors_preflight_echoes_only_extension_origins(self):
        for origin in ["chrome-extension://" + "a" * 32,
                       "safari-web-extension://12345678-ABCD-1234-ABCD-123456789012"]:
            status, headers, _ = self.request("OPTIONS", "/api/settings", headers={
                "Origin": origin, "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-panopto-token",
                "Access-Control-Request-Private-Network": "true"})
            self.assertEqual(status, 204)
            self.assertEqual(headers["Access-Control-Allow-Origin"], origin)
            self.assertEqual(headers["Vary"], "Origin")
            self.assertEqual(headers["Access-Control-Allow-Private-Network"], "true")
        for origin in [downloader.KAIST_ORIGIN, "https://attacker.test", "chrome-extension://" + "z" * 32,
                       "safari-web-extension://id/path", "safari-web-extension://id:90", "null"]:
            status, headers, _ = self.request("OPTIONS", "/api/settings", headers={
                "Origin": origin, "Access-Control-Request-Method": "POST"})
            self.assertEqual(status, 403)
            self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_json_jobs_require_token_validate_payload_and_do_not_disclose_streams(self):
        origin = "chrome-extension://" + "b" * 32
        self.assertEqual(self.api("/api/jobs", payload(), origin, token="bad")[0], 403)
        self.assertEqual(self.api("/api/jobs", payload(), "https://attacker.test")[0], 403)
        status, headers, body = self.api("/api/jobs", payload(), origin)
        self.assertEqual(status, 201)
        result = json.loads(body)
        self.assertEqual(headers["Access-Control-Allow-Origin"], origin)
        self.assertEqual(result["status"], "queued")
        self.assertEqual(result["outputDir"], str(self.manager.output))
        self.assertNotIn(b"streams", body)
        self.assertEqual(json.loads(self.api("/api/jobs", payload(), origin)[2])["id"], result["id"])
        data = payload()
        data["streams"] = [{"url": "https://localhost/private"}]
        self.assertEqual(self.api("/api/jobs", data, origin)[0], 400)
        self.assertEqual(self.api("/api/jobs", {"title": "empty"}, origin)[0], 400)
        self.assertEqual(self.request("POST", "/api/jobs", "{", {
            "Content-Type": "application/json", "X-Panopto-Token": self.token})[0], 400)

    def test_json_settings_are_authenticated_and_save_for_future_jobs(self):
        self.assertEqual(self.request("GET", "/api/settings")[0], 403)
        target = self.root / "chosen downloads"
        self.assertEqual(self.api("/api/settings", {"outputDir": str(target)}, token="bad")[0], 403)
        self.assertEqual(self.api("/api/settings", {"outputDir": str(target)}, "https://attacker.test")[0], 403)
        status, _, body = self.api("/api/settings", {"outputDir": str(target)})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["outputDir"], str(target))
        status, _, body = self.request("GET", "/api/settings", headers={"X-Panopto-Token": self.token})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["outputDir"], str(target))
        self.assertEqual(self.api("/api/settings", {"outputDir": "relative"})[0], 400)
        self.assertEqual(self.api("/api/settings", {"outputDir": str(target), "extra": True})[0], 400)

    def test_authenticated_job_snapshots_expose_request_id_for_lost_response_recovery(self):
        data = payload("https://cdn.ap.panopto.com/video.mp4?signature=private")
        data["requestId"] = "batch-123:session-456"
        status, _, body = self.api("/api/jobs", data)
        self.assertEqual(status, 201)
        submitted = json.loads(body)
        self.assertEqual(submitted["requestId"], data["requestId"])
        status, _, body = self.request("GET", "/api/jobs", headers={"X-Panopto-Token": self.token})
        self.assertEqual(status, 200)
        recovered = next(job for job in json.loads(body)["jobs"] if job["requestId"] == data["requestId"])
        self.assertEqual(recovered["id"], submitted["id"])
        self.assertNotIn(b"signature=", body)
        self.assertNotIn(b"https://", body)
        self.assertNotIn(self.token.encode(), body)
        self.assertEqual(self.request("GET", "/api/jobs")[0], 403)

    def test_cancel_request_acknowledgement_blocks_a_late_job_post(self):
        data = payload()
        data["requestId"] = "batch-123:late-session"
        status, _, body = self.api("/api/cancel-request", {"requestId": data["requestId"]})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"ok": True, "requestId": data["requestId"], "job": None})
        status, _, body = self.api("/api/jobs", data)
        self.assertEqual(status, 409)
        self.assertIn("error", json.loads(body))
        self.assertEqual(self.manager.snapshot(), [])

    def test_cancel_request_requires_token_trusted_origin_and_valid_identifier(self):
        data = payload()
        data["requestId"] = "batch-123:accepted-session"
        job_id = json.loads(self.api("/api/jobs", data)[2])["id"]
        cancellation = {"requestId": data["requestId"]}
        self.assertEqual(self.api("/api/cancel-request", cancellation, token="bad")[0], 403)
        self.assertEqual(self.api("/api/cancel-request", cancellation, "https://attacker.test")[0], 403)
        self.assertEqual(self.api("/api/cancel-request", {"requestId": "bad/request"})[0], 400)
        self.assertEqual(self.api("/api/cancel-request", {"requestId": data["requestId"], "extra": True})[0], 400)
        self.assertEqual(self.manager.snapshot()[0]["status"], "queued")
        origin = "chrome-extension://" + "c" * 32
        status, headers, body = self.api("/api/cancel-request", cancellation, origin)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], origin)
        self.assertEqual(json.loads(body)["job"]["id"], job_id)
        self.assertEqual(json.loads(body)["job"]["status"], "cancelled")

    def test_json_queue_capacity_returns_retryable_status(self):
        for index in range(downloader.MAX_ACTIVE_JOBS):
            data = payload()
            data["pageUrl"] = "https://kaist.ap.panopto.com/Panopto/Pages/Viewer.aspx?id=%d" % index
            self.assertEqual(self.api("/api/jobs", data)[0], 201)
        status, headers, _ = self.api("/api/jobs", payload())
        self.assertEqual(status, 429)
        self.assertEqual(headers["Retry-After"], "5")


@unittest.skipUnless(downloader.DownloadManager.find_tool("ffmpeg") and downloader.DownloadManager.find_tool("ffprobe"),
                     "ffmpeg and ffprobe are required for the real remux test")
class RealRemuxTests(unittest.TestCase):
    def test_single_file_fmp4_byteranges_are_remuxed_and_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "source"
            media.mkdir()
            subprocess.run([downloader.DownloadManager.find_tool("ffmpeg"), "-hide_banner", "-loglevel", "error",
                            "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=25",
                            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
                            "-t", "2", "-c:v", "libx264", "-c:a", "aac", "-hls_time", "1",
                            "-hls_segment_type", "fmp4", "-hls_flags", "single_file", "-f", "hls",
                            str(media / "index.m3u8")], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           check=True, timeout=30)
            self.assertIn("#EXT-X-BYTERANGE:", (media / "index.m3u8").read_text())
            manager = downloader.DownloadManager(root / "output", start_worker=False, state_dir=root / "state")
            data = payload("https://cdn.ap.panopto.com/index.m3u8?signature=private")
            data["duration"] = 2
            job_id = manager.submit(data)

            def local_fetch(mirror, url, destination=None, limit=None):
                content = (media / Path(urlsplit(url).path).name).read_bytes()
                if destination:
                    Path(destination).write_bytes(content)
                    return len(content), url
                return content, url

            try:
                with patch.object(downloader.MediaMirror, "fetch", local_fetch):
                    manager.run_job(manager.jobs[job_id])
                job = manager.snapshot()[0]
                self.assertEqual(job["status"], "completed", job["error"])
                self.assertEqual(job["progress"], 100)
                self.assertGreater(job["files"][0]["size"], 1000)
                self.assertEqual(len(list(manager.output.iterdir())), 1)
            finally:
                manager.close()


if __name__ == "__main__":
    unittest.main()
