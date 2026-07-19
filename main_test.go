package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestDeliveryRangesMergeBeforeSourceIsReleased(t *testing.T) {
	var ranges [][2]int
	var done bool
	for _, step := range []struct {
		start, end int
		want       bool
	}{{600, 1000, false}, {0, 400, false}, {350, 550, false}, {500, 700, true}} {
		if ranges, done = recordDelivery(ranges, step.start, step.end, 1000); done != step.want {
			t.Fatalf("recordDelivery(%d,%d) = %v, want %v", step.start, step.end, done, step.want)
		}
	}
	if !reflect.DeepEqual(ranges, [][2]int{{0, 1000}}) {
		t.Fatalf("ranges = %v", ranges)
	}
}

func TestEmptyOrDuplicateDeliveryDoesNotFakeCoverage(t *testing.T) {
	var ranges [][2]int
	var done bool
	for _, end := range []int{0, 5, 5} {
		if ranges, done = recordDelivery(ranges, 0, end, 10); done {
			t.Fatalf("coverage reported after [0,%d)", end)
		}
	}
	if !reflect.DeepEqual(ranges, [][2]int{{0, 5}}) {
		t.Fatalf("ranges = %v", ranges)
	}
}

func TestGithubURLValidation(t *testing.T) {
	for in, want := range map[string]string{
		"https://github.com/makepad/makepad":  "https://github.com/makepad/makepad",
		" https://github.com/a/b.git/ ":       "https://github.com/a/b",
		"https://example.com/a/b":             "",
		"https://github.com/a/b/tree/main":    "",
		"https://github.com/a/b;rm -rf":       "",
		"https://github.com/-/--upload-pack=": "",
	} {
		if got := cleanGithubURL(in); got != want {
			t.Errorf("cleanGithubURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPathValidation(t *testing.T) {
	for in, ok := range map[string]bool{"src/main.rs": true, "a/./b": true, "../secret": false, "a/../../b": false, "/etc/passwd": false, "./a": false, "": false, ".": false} {
		if _, got := safeRelativePath(in); got != ok {
			t.Errorf("safeRelativePath(%q) ok = %v, want %v", in, got, ok)
		}
	}
}

type client struct {
	t    *testing.T
	url  string
	http *http.Client
}

// stranger is a different browser session against the same server.
func (c client) stranger() client {
	jar, _ := cookiejar.New(nil)
	return client{c.t, c.url, &http.Client{Jar: jar}}
}

func (c client) do(method, path, body string) (int, []byte) {
	c.t.Helper()
	req, _ := http.NewRequest(method, c.url+path, strings.NewReader(body))
	res, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	return res.StatusCode, data
}

func (c client) json(method, path, body string, wantStatus int, out any) {
	c.t.Helper()
	status, data := c.do(method, path, body)
	if status != wantStatus {
		c.t.Fatalf("%s %s = %d %s, want %d", method, path, status, data, wantStatus)
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			c.t.Fatalf("%s %s: %v in %s", method, path, err, data)
		}
	}
}

func newTestServer(t *testing.T) (*Server, client) {
	server := NewServer(filepath.Join(t.TempDir(), "codenavigator"))
	server.showLocal = true // most tests index local folders
	ts := httptest.NewServer(server)
	t.Cleanup(ts.Close)
	return server, client{t, ts.URL, nil}.stranger()
}

func TestLocalJobLifecycle(t *testing.T) {
	server, c := newTestServer(t)
	var created struct{ JobID string }
	c.json("POST", "/api/jobs", `{"kind":"local","name":"demo"}`, 201, &created)

	sources := map[string]string{
		"src/app.js":    "import { helper } from './helper.js';\nfunction start() {\n  helper();\n}\n",
		"src/helper.js": "export function helper() {\n  return '<ok>';\n}\n",
	}
	for path, content := range sources {
		c.json("POST", "/api/jobs/"+created.JobID+"/files?path="+strings.ReplaceAll(path, "/", "%2F"), content, 200, nil)
	}
	c.json("POST", "/api/jobs/"+created.JobID+"/files?path=..%2Fescape.js", "x", 400, nil)
	c.json("POST", "/api/jobs/"+created.JobID+"/commit", "", 202, nil)

	res, err := c.http.Get(c.url + "/api/jobs/" + created.JobID + "/events")
	if err != nil {
		t.Fatal(err)
	}
	if ct := res.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("events content type = %q", ct)
	}
	var job Job
	scanner := bufio.NewScanner(res.Body)
	for scanner.Scan() {
		if data, ok := strings.CutPrefix(scanner.Text(), "data: "); ok {
			job = Job{}
			json.Unmarshal([]byte(data), &job)
		}
	}
	res.Body.Close()
	if job.SnapshotID == nil || job.Phase != "ready" {
		t.Fatalf("final job event = %+v", job)
	}
	snapshotURL := "/api/snapshots/" + *job.SnapshotID

	other := c.stranger()
	other.json("GET", "/api/jobs/"+created.JobID, "", 404, nil)
	other.json("POST", "/api/jobs/"+created.JobID+"/files?path=evil.js", "x", 404, nil)
	other.json("GET", snapshotURL+"/scene", "", 404, nil)
	other.json("GET", snapshotURL+"/entities/1/source", "", 404, nil)

	var summary map[string]any
	c.json("GET", snapshotURL, "", 200, &summary)
	if summary["fileCount"] != 2.0 || summary["references"] != 1.0 || summary["name"] != "demo" {
		t.Fatalf("summary = %v", summary)
	}

	status, raw := c.do("GET", snapshotURL+"/scene", "")
	if status != 200 || !strings.Contains(string(raw), `'<ok>'`) {
		t.Fatalf("scene = %d %s (previews must not be HTML-escaped)", status, raw)
	}
	var scene struct {
		Files []sceneFile
		Edges []Edge
	}
	json.Unmarshal(raw, &scene)
	if len(scene.Files) != 2 || scene.Files[0].Path != "src/app.js" || scene.Files[0].SymbolCount != 1 || len(scene.Edges) != 1 {
		t.Fatalf("scene = %+v", scene)
	}
	if server.snapshots[*job.SnapshotID].Files[0].Preview != "" {
		t.Fatal("previews should be released after the scene is delivered")
	}

	var hits []searchHit
	c.json("GET", snapshotURL+"/search?q=HELP", "", 200, &hits)
	if len(hits) != 2 || hits[0].Kind != "file" || hits[1].Name != "helper" || hits[1].Line != 1 {
		t.Fatalf("hits = %+v", hits)
	}
	c.json("GET", snapshotURL+"/search?q=h", "", 200, &hits)
	if len(hits) != 0 {
		t.Fatalf("single-character search returned %v", hits)
	}

	var entity FileRecord
	c.json("GET", snapshotURL+"/entities/1", "", 200, &entity)
	if entity.Path != "src/app.js" || entity.Imports == nil || len(entity.Symbols) != 1 {
		t.Fatalf("entity = %+v", entity)
	}
	c.json("GET", snapshotURL+"/entities/99", "", 404, nil)
	c.json("GET", snapshotURL+"/entities/1/nope", "", 404, nil)

	root := server.snapshots[*job.SnapshotID].Root
	var chunk struct {
		Start, TotalLines int
		Lines             []string
	}
	c.json("GET", snapshotURL+"/entities/1/source?start=2&limit=5", "", 200, &chunk)
	if chunk.Start != 2 || chunk.TotalLines != 4 || !reflect.DeepEqual(chunk.Lines, []string{"  helper();", "}"}) {
		t.Fatalf("chunk = %+v", chunk)
	}
	if _, err := os.Stat(filepath.Join(root, "src/app.js")); err != nil {
		t.Fatal("partially delivered source was released early")
	}
	c.json("GET", snapshotURL+"/entities/1/source?start=0&limit=2", "", 200, &chunk)
	if _, err := os.Stat(filepath.Join(root, "src/app.js")); !os.IsNotExist(err) {
		t.Fatal("fully delivered source should be deleted")
	}
	c.json("GET", snapshotURL+"/entities/2/source", "", 200, &chunk)
	if _, err := os.Stat(filepath.Dir(root)); !os.IsNotExist(err) {
		t.Fatal("workspace should be removed once every source is delivered")
	}
	c.json("GET", snapshotURL+"/entities/2/source", "", 404, nil)
}

func TestRoutesAndHeaders(t *testing.T) {
	_, c := newTestServer(t)
	var health map[string]any
	c.json("GET", "/api/health", "", 200, &health)
	if health["ok"] != true {
		t.Fatalf("health = %v", health)
	}
	c.json("POST", "/api/jobs", `not json`, 400, nil)
	c.json("POST", "/api/jobs", `{"kind":"github"}`, 400, nil)
	c.json("POST", "/api/jobs", `{"kind":"github","url":"https://evil.example/a/b"}`, 400, nil)
	c.json("GET", "/api/jobs/missing", "", 404, nil)
	c.json("POST", "/api/jobs/missing/commit", "", 404, nil)
	c.json("GET", "/api/snapshots/missing/scene", "", 404, nil)
	c.json("GET", "/api/unknown", "", 404, nil)

	res, err := http.DefaultClient.Do(must(http.NewRequest("OPTIONS", c.url+"/api/jobs", nil)))
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 204 || res.Header.Get("Access-Control-Allow-Origin") != "*" || !strings.Contains(res.Header.Get("Access-Control-Allow-Headers"), "ngrok-skip-browser-warning") {
		t.Fatalf("preflight = %d %v", res.StatusCode, res.Header)
	}

	for path, contentType := range map[string]string{"/": "text/html", "/api.mjs": "text/javascript", "/styles.css": "text/css", "/config.js": "text/javascript", "/fonts/archivo-black.woff2": "font/woff2"} {
		res, err := http.Get(c.url + path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), contentType) {
			t.Errorf("GET %s = %d %s", path, res.StatusCode, res.Header.Get("Content-Type"))
		}
	}
}

func TestFailedIndexReportsErrorAndCleansUp(t *testing.T) {
	server, c := newTestServer(t)
	var created struct{ JobID string }
	c.json("POST", "/api/jobs", `{"kind":"local"}`, 201, &created)
	server.indexJob(created.JobID, filepath.Join(server.workspace, created.JobID, "files"))
	var job Job
	c.json("GET", "/api/jobs/"+created.JobID, "", 200, &job)
	if job.Phase != "error" || job.Error == nil || job.Name != "Local codebase" {
		t.Fatalf("job = %+v", job)
	}
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(fmt.Sprint(err))
	}
	return v
}

func TestSessionCookieFlags(t *testing.T) {
	_, c := newTestServer(t)
	req, _ := http.NewRequest("POST", c.url+"/api/jobs", strings.NewReader(`{"kind":"local"}`))
	req.Header.Set("X-Forwarded-Proto", "https")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	cookie := res.Header.Get("Set-Cookie")
	for _, want := range []string{sessionCookie + "=", "HttpOnly", "Secure", "SameSite=Lax", "Path=/"} {
		if !strings.Contains(cookie, want) {
			t.Errorf("Set-Cookie %q missing %q", cookie, want)
		}
	}
}

// indexLocal uploads files as a local job and waits for the snapshot.
func (c client) indexLocal(files map[string]string) (jobID, snapshotID string) {
	c.t.Helper()
	var created struct{ JobID string }
	c.json("POST", "/api/jobs", `{"kind":"local"}`, 201, &created)
	for path, content := range files {
		c.json("POST", "/api/jobs/"+created.JobID+"/files?path="+path, content, 200, nil)
	}
	c.json("POST", "/api/jobs/"+created.JobID+"/commit", "", 202, nil)
	status, raw := c.do("GET", "/api/jobs/"+created.JobID+"/events", "")
	var job Job
	for line := range strings.Lines(string(raw)) {
		if data, ok := strings.CutPrefix(line, "data: "); ok {
			json.Unmarshal([]byte(data), &job)
		}
	}
	if status != 200 || job.SnapshotID == nil {
		c.t.Fatalf("job did not finish: %d %+v", status, job)
	}
	return created.JobID, *job.SnapshotID
}

func TestSessionsKeepIndependentSnapshots(t *testing.T) {
	server, alice := newTestServer(t)
	bob := alice.stranger()
	_, aliceFirst := alice.indexLocal(map[string]string{"a.go": "package a"})
	_, bobSnapshot := bob.indexLocal(map[string]string{"b.go": "package b"})
	_, aliceSecond := alice.indexLocal(map[string]string{"c.go": "package c"})

	alice.json("GET", "/api/snapshots/"+aliceFirst, "", 404, nil)
	alice.json("GET", "/api/snapshots/"+aliceSecond, "", 200, nil)
	bob.json("GET", "/api/snapshots/"+bobSnapshot, "", 200, nil)
	if len(server.snapshots) != 2 {
		t.Fatalf("snapshots = %d, want 2", len(server.snapshots))
	}
}

func TestExpireDropsIdleSnapshotsAndAbandonedUploads(t *testing.T) {
	server, c := newTestServer(t)
	_, snapshot := c.indexLocal(map[string]string{"a.go": "package a"})
	var pending struct{ JobID string }
	c.json("POST", "/api/jobs", `{"kind":"local"}`, 201, &pending)
	c.json("POST", "/api/jobs/"+pending.JobID+"/files?path=b.go", "package b", 200, nil)
	snapshotRoot := server.snapshots[snapshot].Root
	pendingRoot := server.jobs[pending.JobID].root

	server.expire(time.Now())
	c.json("GET", "/api/snapshots/"+snapshot, "", 200, nil)

	server.expire(time.Now().Add(idleExpiry + time.Minute))
	c.json("GET", "/api/snapshots/"+snapshot, "", 404, nil)
	c.json("GET", "/api/jobs/"+pending.JobID, "", 404, nil)
	for _, root := range []string{snapshotRoot, pendingRoot} {
		if _, err := os.Stat(root); !os.IsNotExist(err) {
			t.Errorf("workspace %s should be deleted", root)
		}
	}
	if len(server.jobs) != 0 {
		t.Errorf("jobs left: %d", len(server.jobs))
	}
}

func TestSnapshotCapEvictsLeastRecentlyUsed(t *testing.T) {
	server, first := newTestServer(t)
	_, oldest := first.indexLocal(map[string]string{"a.go": "package a"})
	for i := range maxSnapshots {
		first.stranger().indexLocal(map[string]string{"a.go": fmt.Sprint("package p", i)})
	}
	if len(server.snapshots) != maxSnapshots {
		t.Fatalf("snapshots = %d, want %d", len(server.snapshots), maxSnapshots)
	}
	first.json("GET", "/api/snapshots/"+oldest, "", 404, nil)
}

func TestIndexingQueuesBeyondConcurrencyLimit(t *testing.T) {
	server, c := newTestServer(t)
	for range maxIndexing {
		server.indexSlots <- struct{}{}
	}
	var created struct{ JobID string }
	c.json("POST", "/api/jobs", `{"kind":"local"}`, 201, &created)
	c.json("POST", "/api/jobs/"+created.JobID+"/files?path=a.go", "package a", 200, nil)
	c.json("POST", "/api/jobs/"+created.JobID+"/commit", "", 202, nil)
	var job Job
	for range 100 {
		if c.json("GET", "/api/jobs/"+created.JobID, "", 200, &job); job.Phase == "queued" {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if job.Phase != "queued" {
		t.Fatalf("phase = %q, want queued", job.Phase)
	}
	<-server.indexSlots
	for range 200 {
		if c.json("GET", "/api/jobs/"+created.JobID, "", 200, &job); job.SnapshotID != nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("job never finished after a slot was freed: %+v", job)
}

func TestProgressStreamSendsKeepAlivesWhileQueued(t *testing.T) {
	defer func(old time.Duration) { sseKeepAlive = old }(sseKeepAlive)
	sseKeepAlive = 300 * time.Millisecond
	server, c := newTestServer(t)
	for range maxIndexing {
		server.indexSlots <- struct{}{}
	}
	var created struct{ JobID string }
	c.json("POST", "/api/jobs", `{"kind":"local"}`, 201, &created)
	c.json("POST", "/api/jobs/"+created.JobID+"/files?path=a.go", "package a", 200, nil)
	c.json("POST", "/api/jobs/"+created.JobID+"/commit", "", 202, nil)

	res, err := c.http.Get(c.url + "/api/jobs/" + created.JobID + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	lines := bufio.NewScanner(res.Body)
	deadline := time.After(5 * time.Second)
	for {
		select {
		case <-deadline:
			t.Fatal("no keep-alive before the deadline")
		default:
		}
		if !lines.Scan() {
			t.Fatal("stream closed while job was queued")
		}
		if lines.Text() == ": keep-alive" {
			break
		}
	}
	<-server.indexSlots
	var job Job
	for lines.Scan() {
		if data, ok := strings.CutPrefix(lines.Text(), "data: "); ok {
			json.Unmarshal([]byte(data), &job)
		}
	}
	if job.SnapshotID == nil {
		t.Fatalf("stream ended without a snapshot: %+v", job)
	}
}

func TestLocalFoldersDisabledByDefault(t *testing.T) {
	t.Setenv("SHOW_LOCAL", "")
	server := NewServer(filepath.Join(t.TempDir(), "codenavigator"))
	ts := httptest.NewServer(server)
	defer ts.Close()
	c := client{t, ts.URL, nil}.stranger()
	var health map[string]any
	c.json("GET", "/api/health", "", 200, &health)
	if health["localFolders"] != false {
		t.Fatalf("health = %v", health)
	}
	c.json("POST", "/api/jobs", `{"kind":"local"}`, 403, nil)
	c.json("POST", "/api/jobs", `{"kind":"mystery"}`, 400, nil)

	t.Setenv("SHOW_LOCAL", "true")
	enabled := httptest.NewServer(NewServer(filepath.Join(t.TempDir(), "codenavigator")))
	defer enabled.Close()
	on := client{t, enabled.URL, nil}.stranger()
	on.json("GET", "/api/health", "", 200, &health)
	if health["localFolders"] != true {
		t.Fatalf("health with SHOW_LOCAL=true = %v", health)
	}
	on.json("POST", "/api/jobs", `{"kind":"local"}`, 201, nil)
}
