package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

//go:embed web
var webFiles embed.FS

type Job struct {
	ID         string   `json:"id"`
	SourceKind string   `json:"sourceKind"`
	Name       string   `json:"name"`
	Phase      string   `json:"phase"`
	Completed  int      `json:"completed"`
	Total      int      `json:"total"`
	Message    string   `json:"message"`
	SnapshotID *string  `json:"snapshotId"`
	Error      *string  `json:"error"`
	Warnings   []string `json:"warnings"`
	// AuthRequired is "signin" or "install" when GitHub access would fix a failed clone.
	AuthRequired string `json:"authRequired,omitempty"`
	root         string
	owner        string    // session that created the job
	updated      time.Time // last progress, used to expire abandoned jobs
}

const (
	idleExpiry   = time.Hour // snapshots unused and jobs untouched for this long are dropped
	maxSnapshots = 8         // ponytail: fixed caps sized for the 2GB container; make them configurable if memory changes
	maxIndexing  = 2         // concurrent index runs; each already uses every CPU
)

type Server struct {
	jobsMu      sync.Mutex
	jobs        map[string]*Job
	snapshotsMu sync.Mutex
	snapshots   map[string]*Snapshot
	workspace   string // parent of every job directory; only paths under it are ever removed
	cors        string
	static      http.Handler
	indexSlots  chan struct{}
	github      githubApp
	authMu      sync.Mutex
	auth        map[string]*githubAuth // by session ID
}

func NewServer(workspace string) *Server {
	cors := os.Getenv("CORS_ORIGIN")
	if cors == "" || strings.ContainsAny(cors, "\r\n") {
		cors = "*"
	}
	web, _ := fs.Sub(webFiles, "web")
	return &Server{
		jobs:       map[string]*Job{},
		snapshots:  map[string]*Snapshot{},
		workspace:  workspace,
		cors:       cors,
		static:     http.FileServerFS(web),
		indexSlots: make(chan struct{}, maxIndexing),
		github:     githubAppFromEnv(),
		auth:       map[string]*githubAuth{},
	}
}

func main() {
	port := 4177
	if p, err := strconv.Atoi(os.Getenv("PORT")); err == nil {
		port = p
	}
	flag.IntVar(&port, "port", port, "listening port (default $PORT or 4177)")
	open := flag.Bool("open", false, "open the viewer in a browser")
	flag.Parse()

	handler := NewServer(filepath.Join(os.TempDir(), "codenavigator"))
	server := &http.Server{
		Addr:              fmt.Sprintf("0.0.0.0:%d", port),
		Handler:           handler,
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	go func() {
		for now := range time.Tick(time.Minute) {
			handler.expire(now)
		}
	}()
	log.Printf("CodeNavigator listening on http://127.0.0.1:%d", port)
	if *open {
		_ = exec.Command("xdg-open", fmt.Sprintf("http://127.0.0.1:%d", port)).Start()
	}
	log.Fatal(server.ListenAndServe())
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Access-Control-Allow-Origin", s.cors)
	h.Set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Content-Type, ngrok-skip-browser-warning")
	h.Set("Access-Control-Max-Age", "86400")

	path := r.URL.Path
	switch {
	case r.Method == http.MethodOptions:
		w.WriteHeader(http.StatusNoContent)
	case path == "/api/health" && r.Method == http.MethodGet:
		writeJSON(w, 200, map[string]any{"ok": true, "version": "0.1.0"})
	case path == "/api/jobs" && r.Method == http.MethodPost:
		s.createJob(w, r)
	case strings.HasPrefix(path, "/api/jobs/"):
		s.jobRoute(w, r, strings.Split(strings.TrimPrefix(path, "/api/jobs/"), "/"))
	case strings.HasPrefix(path, "/api/github/"):
		s.githubRoute(w, r, strings.TrimPrefix(path, "/api/github/"))
	case strings.HasPrefix(path, "/api/snapshots/"):
		s.snapshotRoute(w, r, strings.Split(strings.TrimPrefix(path, "/api/snapshots/"), "/"))
	case !strings.HasPrefix(path, "/api/") && (r.Method == http.MethodGet || r.Method == http.MethodHead):
		s.static.ServeHTTP(w, r)
	default:
		writeError(w, 404, "Not found")
	}
}

func (s *Server) createJob(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Kind string  `json:"kind"`
		Name *string `json:"name"`
		URL  *string `json:"url"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&request); err != nil || request.Kind == "" {
		writeError(w, 400, "Invalid job request")
		return
	}
	owner := sessionID(w, r)
	url := ""
	if request.Kind == "github" {
		if request.URL == nil {
			writeError(w, 400, "Missing GitHub URL")
			return
		}
		if url = cleanGithubURL(*request.URL); url == "" {
			writeError(w, 400, "Use a public github.com owner/repository URL")
			return
		}
	}
	id := uniqueID("job")
	root := filepath.Join(s.workspace, id)
	if err := os.MkdirAll(root, 0o755); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	job := &Job{ID: id, SourceKind: request.Kind, Name: "Local codebase", Phase: "receiving", Message: "Waiting for files…", Warnings: []string{}, root: root, owner: owner, updated: time.Now()}
	if request.Name != nil {
		job.Name = *request.Name
	}
	if request.Kind == "github" {
		job.Phase, job.Message = "cloning", "Cloning repository…"
	}
	s.jobsMu.Lock()
	s.jobs[id] = job
	s.jobsMu.Unlock()

	if request.Kind == "github" {
		token := s.githubAuthFor(owner).token
		go func() {
			checkout := filepath.Join(root, "repo")
			output, err := gitClone(url, checkout, token).CombinedOutput()
			if err != nil {
				text := string(output)
				if token != "" {
					text = strings.ReplaceAll(text, token, "***")
				}
				message, authRequired := s.github.cloneFailure(text, token != "")
				s.failJob(id, message, authRequired)
				s.removeWorkspace(root)
				return
			}
			s.indexJob(id, checkout)
		}()
	}
	writeJSON(w, 201, map[string]string{"jobId": id})
}

func (s *Server) jobRoute(w http.ResponseWriter, r *http.Request, parts []string) {
	id, action := parts[0], ""
	if len(parts) > 1 {
		action = parts[1]
	}
	if job, ok := s.jobSnapshot(id); !ok || job.owner != sessionID(nil, r) {
		writeError(w, 404, "Unknown job")
		return
	}
	switch {
	case r.Method == http.MethodGet && action == "":
		if job, ok := s.jobSnapshot(id); ok {
			writeJSON(w, 200, job)
		} else {
			writeError(w, 404, "Unknown job")
		}
	case r.Method == http.MethodGet && action == "events":
		s.streamJobEvents(w, r, id)
	case r.Method == http.MethodPost && action == "files":
		relative, ok := safeRelativePath(r.URL.Query().Get("path"))
		if !ok {
			writeError(w, 400, "Unsafe file path")
			return
		}
		root, ok := s.localJobRoot(id)
		if !ok {
			writeError(w, 404, "Unknown local job")
			return
		}
		output := filepath.Join(root, "files", relative)
		if err := writeUpload(output, http.MaxBytesReader(w, r.Body, 64<<20)); err != nil {
			writeError(w, 400, "Could not store file")
			return
		}
		s.jobsMu.Lock()
		if job := s.jobs[id]; job != nil {
			job.Completed++
			job.Total = job.Completed
			job.Message = fmt.Sprintf("Received %d files", job.Completed)
			job.updated = time.Now()
		}
		s.jobsMu.Unlock()
		writeJSON(w, 200, map[string]bool{"ok": true})
	case r.Method == http.MethodPost && action == "commit":
		s.jobsMu.Lock()
		job := s.jobs[id]
		if job == nil || job.SourceKind != "local" {
			s.jobsMu.Unlock()
			writeError(w, 404, "Unknown local job")
			return
		}
		job.Phase, job.Message = "scanning", "Scanning files…"
		root := filepath.Join(job.root, "files")
		s.jobsMu.Unlock()
		go s.indexJob(id, root)
		writeJSON(w, 202, map[string]bool{"ok": true})
	default:
		writeError(w, 404, "Unknown job route")
	}
}

func writeUpload(output string, body io.Reader) error {
	if err := os.MkdirAll(filepath.Dir(output), 0o755); err != nil {
		return err
	}
	file, err := os.Create(output)
	if err != nil {
		return err
	}
	_, err = io.Copy(file, body)
	return errors.Join(err, file.Close())
}

func (s *Server) snapshotRoute(w http.ResponseWriter, r *http.Request, parts []string) {
	part := func(i int) string {
		if i < len(parts) {
			return parts[i]
		}
		return ""
	}
	id, action := part(0), part(1)
	s.snapshotsMu.Lock()
	snapshot := s.snapshots[id]
	if snapshot == nil || snapshot.Owner != sessionID(nil, r) {
		s.snapshotsMu.Unlock()
		writeError(w, 404, "Unknown snapshot")
		return
	}
	snapshot.lastUsed = time.Now()
	switch action {
	case "":
		body := map[string]any{
			"id": snapshot.ID, "name": snapshot.Name, "source": snapshot.Source, "fileCount": len(snapshot.Files),
			"totalLines": snapshot.TotalLines, "definitions": snapshot.Definitions, "references": snapshot.References,
			"edges": len(snapshot.Edges), "warnings": snapshot.Warnings,
		}
		s.snapshotsMu.Unlock()
		writeJSON(w, 200, body)
	case "scene":
		body := sceneJSON(snapshot)
		s.snapshotsMu.Unlock()
		if sendJSON(w, 200, body) == nil {
			// The response owned the bytes; release the duplicate previews.
			s.snapshotsMu.Lock()
			for i := range snapshot.Files {
				snapshot.Files[i].Preview = ""
			}
			s.snapshotsMu.Unlock()
		}
	case "search":
		hits := search(snapshot, r.URL.Query().Get("q"))
		s.snapshotsMu.Unlock()
		writeJSON(w, 200, hits)
	case "entities":
		entityID, err := strconv.ParseUint(part(2), 10, 32)
		if err != nil || entityID == 0 || int(entityID) > len(snapshot.Files) {
			s.snapshotsMu.Unlock()
			writeError(w, 404, "Unknown entity")
			return
		}
		file := &snapshot.Files[entityID-1]
		switch part(3) {
		case "":
			body := marshal(file)
			s.snapshotsMu.Unlock()
			sendJSON(w, 200, body)
		case "source":
			s.serveSource(w, r, snapshot, file) // unlocks
		default:
			s.snapshotsMu.Unlock()
			writeError(w, 404, "Unknown entity route")
		}
	default:
		s.snapshotsMu.Unlock()
		writeError(w, 404, "Unknown snapshot route")
	}
}

// serveSource is called with snapshotsMu held and releases it before writing.
func (s *Server) serveSource(w http.ResponseWriter, r *http.Request, snapshot *Snapshot, file *FileRecord) {
	query := r.URL.Query()
	start, err := strconv.Atoi(query.Get("start"))
	if err != nil || start < 0 {
		start = 0
	}
	start = min(start, file.Lines)
	limit, err := strconv.Atoi(query.Get("limit"))
	if err != nil || limit < 0 {
		limit = 600
	}
	limit = min(max(limit, 1), 4096)
	fileID, totalLines := file.ID, file.Lines
	relative, ok := safeRelativePath(file.Path)
	if !ok {
		s.snapshotsMu.Unlock()
		writeError(w, 400, "Unsafe file path")
		return
	}
	sourcePath := filepath.Join(snapshot.Root, relative)
	lines, err := readLines(sourcePath, start, limit)
	s.snapshotsMu.Unlock()
	if err != nil {
		writeError(w, 404, "Source unavailable")
		return
	}
	body := marshal(map[string]any{"start": start, "lines": lines, "totalLines": totalLines})
	if sendJSON(w, 200, body) != nil {
		return
	}

	s.snapshotsMu.Lock()
	defer s.snapshotsMu.Unlock()
	if snapshot.released[fileID] {
		return
	}
	ranges, complete := recordDelivery(snapshot.delivered[fileID], start, start+len(lines), totalLines)
	snapshot.delivered[fileID] = ranges
	if complete {
		snapshot.released[fileID] = true
		os.Remove(sourcePath)
		if len(snapshot.released) == len(snapshot.Files) {
			s.removeWorkspace(snapshot.Root)
		}
	}
}

// readLines returns up to limit lines after skipping start, stopping at the first
// invalid UTF-8 line like Rust's BufRead::lines.
func readLines(path string, start, limit int) ([]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 9*1024*1024)
	lines := []string{}
	for index := 0; len(lines) < limit && scanner.Scan(); index++ {
		if index < start {
			continue
		}
		if !utf8.Valid(scanner.Bytes()) {
			break
		}
		lines = append(lines, scanner.Text())
	}
	return lines, nil
}

type sceneFile struct {
	ID          uint32 `json:"id"`
	Path        string `json:"path"`
	Name        string `json:"name"`
	Directory   string `json:"directory"`
	Extension   string `json:"extension"`
	Language    string `json:"language"`
	Layer       string `json:"layer"`
	Lines       int    `json:"lines"`
	Bytes       int    `json:"bytes"`
	Complexity  int    `json:"complexity"`
	Preview     string `json:"preview"`
	SymbolCount int    `json:"symbolCount"`
}

func sceneJSON(snapshot *Snapshot) []byte {
	files := make([]sceneFile, len(snapshot.Files))
	for i, f := range snapshot.Files {
		files[i] = sceneFile{f.ID, f.Path, f.Name, f.Directory, f.Extension, f.Language, f.Layer, f.Lines, f.Bytes, f.Complexity, f.Preview, len(f.Symbols)}
	}
	return marshal(struct {
		ID          string      `json:"id"`
		Name        string      `json:"name"`
		Source      string      `json:"source"`
		Files       []sceneFile `json:"files"`
		Edges       []Edge      `json:"edges"`
		TotalLines  int         `json:"totalLines"`
		Definitions int         `json:"definitions"`
		References  int         `json:"references"`
	}{snapshot.ID, snapshot.Name, snapshot.Source, files, snapshot.Edges, snapshot.TotalLines, snapshot.Definitions, snapshot.References})
}

type searchHit struct {
	EntityID uint32 `json:"entityId"`
	Path     string `json:"path"`
	Name     string `json:"name"`
	Line     int    `json:"line"`
	Kind     string `json:"kind"`
	Preview  string `json:"preview"`
}

func search(snapshot *Snapshot, query string) []searchHit {
	const maxHits = 180
	needle := strings.ToLower(query)
	hits := []searchHit{}
	if len(needle) < 2 {
		return hits
	}
	for _, file := range snapshot.Files {
		if len(hits) >= maxHits {
			break
		}
		if strings.Contains(strings.ToLower(file.Path), needle) {
			firstLine, _, _ := strings.Cut(file.Preview, "\n")
			hits = append(hits, searchHit{file.ID, file.Path, file.Name, 1, "file", strings.TrimSuffix(firstLine, "\r")})
		}
		for _, symbol := range file.Symbols {
			if len(hits) >= maxHits {
				break
			}
			if strings.Contains(strings.ToLower(symbol.Name), needle) {
				hits = append(hits, searchHit{file.ID, file.Path, symbol.Name, symbol.Line, "definition", symbol.Signature})
			}
		}
	}
	return hits
}

func (s *Server) streamJobEvents(w http.ResponseWriter, r *http.Request, id string) {
	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(200)
	if flusher != nil {
		flusher.Flush()
	}
	last := ""
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()
	for range 1200 {
		job, ok := s.jobSnapshot(id)
		if !ok {
			return
		}
		encoded := marshal(job)
		if string(encoded) != last {
			if _, err := fmt.Fprintf(w, "event: progress\ndata: %s\n\n", encoded); err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
			last = string(encoded)
		}
		if job.SnapshotID != nil || job.Error != nil {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Server) jobSnapshot(id string) (Job, bool) {
	s.jobsMu.Lock()
	defer s.jobsMu.Unlock()
	job := s.jobs[id]
	if job == nil {
		return Job{}, false
	}
	return *job, true
}

func (s *Server) localJobRoot(id string) (string, bool) {
	s.jobsMu.Lock()
	defer s.jobsMu.Unlock()
	job := s.jobs[id]
	if job == nil || job.SourceKind != "local" {
		return "", false
	}
	return job.root, true
}

func (s *Server) indexJob(id, root string) {
	select {
	case s.indexSlots <- struct{}{}:
	default:
		s.updateJob(id, "queued", 0, 0, "Waiting for other indexing to finish…")
		s.indexSlots <- struct{}{}
	}
	defer func() { <-s.indexSlots }()
	s.updateJob(id, "scanning", 0, 0, "Discovering source files…")
	snapshot, err := indexDirectory(root, func(phase string, completed, total int, message string) {
		s.updateJob(id, phase, completed, total, message)
	})
	if err != nil {
		s.removeWorkspace(root)
		s.failJob(id, err.Error(), "")
		return
	}
	s.jobsMu.Lock()
	if job := s.jobs[id]; job != nil {
		snapshot.Name, snapshot.Source, snapshot.Owner = job.Name, job.SourceKind, job.owner
	}
	s.jobsMu.Unlock()
	snapshot.ID = uniqueID("snapshot")

	// Each session keeps only its latest snapshot; its older workspaces are deleted.
	s.snapshotsMu.Lock()
	var oldRoots []string
	for key, old := range s.snapshots {
		if old.Owner == snapshot.Owner {
			oldRoots = append(oldRoots, old.Root)
			delete(s.snapshots, key)
		}
	}
	snapshot.lastUsed = time.Now()
	s.snapshots[snapshot.ID] = snapshot
	for len(s.snapshots) > maxSnapshots {
		oldest := snapshot
		for _, candidate := range s.snapshots {
			if candidate.lastUsed.Before(oldest.lastUsed) {
				oldest = candidate
			}
		}
		oldRoots = append(oldRoots, oldest.Root)
		delete(s.snapshots, oldest.ID)
	}
	s.snapshotsMu.Unlock()
	for _, old := range oldRoots {
		if old != root {
			s.removeWorkspace(old)
		}
	}

	s.jobsMu.Lock()
	if job := s.jobs[id]; job != nil {
		job.Phase, job.Message = "ready", "Landscape ready"
		job.updated = time.Now()
		job.SnapshotID = &snapshot.ID
		job.Completed = max(job.Total, job.Completed)
	}
	s.jobsMu.Unlock()
}

// expire drops snapshots idle since before now-idleExpiry, finished jobs, and uploads
// that were abandoned before commit, deleting their workspaces.
func (s *Server) expire(now time.Time) {
	cutoff := now.Add(-idleExpiry)
	var roots []string
	s.snapshotsMu.Lock()
	for id, snapshot := range s.snapshots {
		if snapshot.lastUsed.Before(cutoff) {
			roots = append(roots, snapshot.Root)
			delete(s.snapshots, id)
		}
	}
	s.snapshotsMu.Unlock()
	s.jobsMu.Lock()
	for id, job := range s.jobs {
		finished := job.SnapshotID != nil || job.Error != nil
		if job.updated.Before(cutoff) && (finished || job.Phase == "receiving") {
			if job.Phase == "receiving" {
				roots = append(roots, job.root)
			}
			delete(s.jobs, id)
		}
	}
	s.jobsMu.Unlock()
	s.authMu.Lock()
	for sid, auth := range s.auth {
		if now.After(auth.expires) && now.After(auth.stateExpires) {
			delete(s.auth, sid)
		}
	}
	s.authMu.Unlock()
	for _, root := range roots {
		s.removeWorkspace(root)
	}
}

func (s *Server) updateJob(id, phase string, completed, total int, message string) {
	s.jobsMu.Lock()
	defer s.jobsMu.Unlock()
	if job := s.jobs[id]; job != nil {
		job.Phase, job.Completed, job.Total, job.Message = phase, completed, total, message
		job.updated = time.Now()
	}
}

func (s *Server) failJob(id, message, authRequired string) {
	s.jobsMu.Lock()
	defer s.jobsMu.Unlock()
	if job := s.jobs[id]; job != nil {
		job.Phase, job.Message, job.Error = "error", "Indexing failed", &message
		job.AuthRequired = authRequired
		job.updated = time.Now()
	}
}

// removeWorkspace deletes a checkout and its now-empty job directory, never leaving the workspace.
func (s *Server) removeWorkspace(root string) {
	if !strings.HasPrefix(root, s.workspace+string(filepath.Separator)) {
		return
	}
	os.RemoveAll(root)
	if parent := filepath.Dir(root); parent != s.workspace && strings.HasPrefix(parent, s.workspace) {
		os.Remove(parent)
	}
}

// recordDelivery merges [start,end) into ranges and reports whether [0,total) is fully covered.
func recordDelivery(ranges [][2]int, start, end, total int) ([][2]int, bool) {
	if end > start {
		ranges = append(ranges, [2]int{start, min(end, total)})
		slices.SortFunc(ranges, func(a, b [2]int) int { return a[0] - b[0] })
		merged := ranges[:1]
		for _, r := range ranges[1:] {
			if last := &merged[len(merged)-1]; r[0] <= last[1] {
				last[1] = max(last[1], r[1])
			} else {
				merged = append(merged, r)
			}
		}
		ranges = merged
	}
	return ranges, total == 0 || (len(ranges) > 0 && ranges[0][0] == 0 && ranges[0][1] >= total)
}

// cleanGithubURL returns the normalised https://github.com/owner/repo URL, or "" if invalid.
func cleanGithubURL(value string) string {
	clean := strings.TrimSuffix(strings.TrimRight(strings.TrimSpace(value), "/"), ".git")
	rest, ok := strings.CutPrefix(clean, "https://github.com/")
	if !ok {
		return ""
	}
	owner, repo, ok := strings.Cut(rest, "/")
	if !ok || !slug(owner) || !slug(repo) {
		return ""
	}
	return clean
}

func slug(s string) bool {
	return s != "" && strings.Trim(s, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.") == ""
}

func safeRelativePath(value string) (string, bool) {
	if value == "" || strings.HasPrefix(value, "/") || strings.HasPrefix(value, "./") || value == "." {
		return "", false
	}
	var clean []string
	for part := range strings.SplitSeq(value, "/") {
		switch part {
		case "", ".":
		case "..":
			return "", false
		default:
			clean = append(clean, part)
		}
	}
	if len(clean) == 0 {
		return "", false
	}
	return filepath.Join(clean...), true
}

const sessionCookie = "codenav_session"

// sessionID returns the caller's session, issuing a cookie when w is non-nil and none exists.
// Jobs and snapshots are only visible to the session that created them. Without w a
// missing session returns "", which never matches an owner.
func sessionID(w http.ResponseWriter, r *http.Request) string {
	if cookie, err := r.Cookie(sessionCookie); err == nil && len(cookie.Value) >= 26 && len(cookie.Value) <= 64 {
		return cookie.Value
	}
	if w == nil {
		return ""
	}
	id := rand.Text()
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    id,
		Path:     "/",
		HttpOnly: true,
		Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
		SameSite: http.SameSiteLaxMode,
	})
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: id}) // later lookups in this request see it
	return id
}

// uniqueID is unguessable: IDs are the capability that grants access to a job or snapshot.
func uniqueID(prefix string) string {
	return prefix + "-" + rand.Text()
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	sendJSON(w, status, marshal(value))
}

// marshal skips HTML escaping: source previews are full of < > & and the payloads are large.
func marshal(value any) []byte {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(value) != nil {
		return []byte(`{"error":"serialization failed"}`)
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
}

func sendJSON(w http.ResponseWriter, status int, body []byte) error {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, err := w.Write(body)
	return err
}
