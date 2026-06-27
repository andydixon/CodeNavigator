package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fakeGitHub(t *testing.T) *httptest.Server {
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/login/oauth/access_token":
			r.ParseForm()
			if r.Form.Get("client_secret") != "secret" || r.Form.Get("code") != "good" {
				json.NewEncoder(w).Encode(map[string]string{"error": "bad_verification_code"})
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"access_token": "ghu_token", "expires_in": 28800})
		case "/user":
			if r.Header.Get("Authorization") != "Bearer ghu_token" {
				w.WriteHeader(401)
				return
			}
			json.NewEncoder(w).Encode(map[string]string{"login": "octocat"})
		case "/repos/o/r/code-scanning/alerts":
			if r.Header.Get("Authorization") != "Bearer ghu_token" {
				w.WriteHeader(401)
				return
			}
			if r.URL.Query().Get("page") == "2" {
				// A next link off the API host must not be followed (it would leak the token).
				w.Header().Set("Link", `<https://evil.example/steal>; rel="next"`)
				json.NewEncoder(w).Encode([]map[string]any{{"html_url": "https://github.com/o/r/security/code-scanning/2", "rule": map[string]any{"id": "go/sql-injection", "severity": "error", "description": "SQL injection"}, "most_recent_instance": map[string]any{"location": map[string]any{"path": "db/query.go", "start_line": 42}}}})
				return
			}
			w.Header().Set("Link", fmt.Sprintf(`<%s/repos/o/r/code-scanning/alerts?page=2>; rel="next", <%s/repos/o/r/code-scanning/alerts?page=2>; rel="last"`, "http://"+r.Host, "http://"+r.Host))
			json.NewEncoder(w).Encode([]map[string]any{{"html_url": "https://github.com/o/r/security/code-scanning/1", "rule": map[string]any{"id": "js/xss", "severity": "warning", "security_severity_level": "critical", "description": "XSS"}, "most_recent_instance": map[string]any{"location": map[string]any{"path": "web/app.js", "start_line": 7}}}})
		case "/repos/o/r/dependabot/alerts":
			w.WriteHeader(403)
		case "/steal":
			t.Error("followed a pagination link to another host")
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(gh.Close)
	return gh
}

func (c client) noRedirects() client {
	jarClient := *c.http
	jarClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return client{c.t, c.url, &jarClient}
}

func (c client) location(path string) *url.URL {
	c.t.Helper()
	res, err := c.http.Get(c.url + path)
	if err != nil {
		c.t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusFound {
		c.t.Fatalf("GET %s = %d, want redirect", path, res.StatusCode)
	}
	loc, _ := url.Parse(res.Header.Get("Location"))
	return loc
}

type githubStatus struct {
	Configured, Connected bool
	Login, InstallURL     string
}

func TestGitHubSignIn(t *testing.T) {
	server, c := newTestServer(t)
	c = c.noRedirects()
	gh := fakeGitHub(t)
	server.github = githubApp{clientID: "client", clientSecret: "secret", slug: "code-nav", webURL: gh.URL, apiURL: gh.URL}

	var status githubStatus
	c.json("GET", "/api/github/status", "", 200, &status)
	if !status.Configured || status.Connected || status.InstallURL != gh.URL+"/apps/code-nav/installations/new" {
		t.Fatalf("status before sign-in = %+v", status)
	}

	login := c.location("/api/github/login")
	state := login.Query().Get("state")
	if login.Path != "/login/oauth/authorize" || login.Query().Get("client_id") != "client" || state == "" {
		t.Fatalf("authorize redirect = %s", login)
	}
	if got := c.location("/api/github/callback?code=good&state=forged").String(); got != "/?github=error" {
		t.Fatalf("forged state redirect = %s", got)
	}
	// State is single use, so the forged attempt burned it.
	if got := c.location("/api/github/callback?code=good&state=" + state).String(); got != "/?github=error" {
		t.Fatalf("reused state redirect = %s", got)
	}

	state = c.location("/api/github/login").Query().Get("state")
	if got := c.stranger().noRedirects().location("/api/github/callback?code=good&state=" + state).String(); got != "/?github=error" {
		t.Fatalf("callback from another session = %s", got)
	}
	state = c.location("/api/github/login").Query().Get("state")
	if got := c.location("/api/github/callback?code=good&state=" + state).String(); got != "/?github=connected" {
		t.Fatalf("callback redirect = %s", got)
	}
	c.json("GET", "/api/github/status", "", 200, &status)
	if !status.Connected || status.Login != "octocat" {
		t.Fatalf("status after sign-in = %+v", status)
	}
	if raw, _ := json.Marshal(status); strings.Contains(string(raw), "ghu_token") {
		t.Fatal("status leaked the token")
	}
	c.stranger().json("GET", "/api/github/status", "", 200, &status)
	if status.Connected {
		t.Fatal("another session sees the sign-in")
	}

	server.expire(time.Now().Add(9 * time.Hour))
	c.json("GET", "/api/github/status", "", 200, &status)
	if status.Connected || len(server.auth) != 0 {
		t.Fatalf("expired token still present: %+v, %d entries", status, len(server.auth))
	}

	state = c.location("/api/github/login").Query().Get("state")
	c.location("/api/github/callback?code=good&state=" + state)
	c.json("POST", "/api/github/logout", "", 200, nil)
	c.json("GET", "/api/github/status", "", 200, &status)
	if status.Connected {
		t.Fatal("still connected after logout")
	}
}

func TestGitHubRoutesWhenUnconfigured(t *testing.T) {
	server, c := newTestServer(t)
	server.github = githubApp{}
	var status githubStatus
	c.json("GET", "/api/github/status", "", 200, &status)
	if status.Configured {
		t.Fatal("reported configured without credentials")
	}
	c.json("GET", "/api/github/login", "", 404, nil)
}

func TestGitCloneKeepsTokenOutOfArgsAndIgnoresHostCredentials(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	cmd := gitClone(t.Context(), "https://github.com/o/r", t.TempDir(), "ghu_secret")
	if strings.Contains(strings.Join(cmd.Args, " "), "ghu_secret") {
		t.Fatal("token appears in git arguments")
	}
	read := func(key string) string {
		probe := exec.Command("git", "config", "--get-all", key)
		probe.Env = cmd.Env
		out, _ := probe.Output()
		return strings.TrimSpace(string(out))
	}
	if got := read("http.https://github.com/.extraheader"); got != "Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2h1X3NlY3JldA==" {
		t.Errorf("extraheader = %q", got)
	}
	if got := read("credential.helper"); got != "" {
		t.Errorf("credential.helper = %q, want empty", got)
	}
}

func TestCloneFailureMessages(t *testing.T) {
	configured := githubApp{clientID: "id", clientSecret: "secret"}
	private := "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
	for _, c := range []struct {
		app      githubApp
		output   string
		signedIn bool
		want     string
	}{
		{configured, private, false, "signin"},
		{configured, "remote: Repository not found.\nfatal: repository 'x' not found", true, "install"},
		{githubApp{}, private, false, ""},
		{configured, "fatal: unable to access: Could not resolve host: github.com", false, ""},
	} {
		message, got := c.app.cloneFailure(c.output, c.signedIn)
		if got != c.want || message == "" {
			t.Errorf("cloneFailure(%q, %v) = %q, %q; want %q", c.output, c.signedIn, message, got, c.want)
		}
	}
}

func TestCloneRepo(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	source := t.TempDir()
	for _, args := range [][]string{{"init", "-q"}, {"-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"}} {
		if out, err := exec.Command("git", append([]string{"-C", source}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	if out, err := cloneRepo(source, filepath.Join(t.TempDir(), "ok"), ""); err != nil {
		t.Fatalf("local clone failed: %v %s", err, out)
	}

	out, err := cloneRepo(filepath.Join(source, "missing-ghu_secret"), filepath.Join(t.TempDir(), "x"), "ghu_secret")
	if err == nil || strings.Contains(out, "timed out") || strings.Contains(out, "ghu_secret") || !strings.Contains(out, "***") {
		t.Fatalf("failed clone = %v %q; want a masked, non-timeout error", err, out)
	}

	defer func(old time.Duration) { cloneTimeout = old }(cloneTimeout)
	cloneTimeout = time.Nanosecond
	if out, err := cloneRepo(source, filepath.Join(t.TempDir(), "slow"), ""); err == nil || !strings.HasPrefix(out, "timed out") {
		t.Fatalf("expired clone = %v %q; want timeout", err, out)
	}
}

func signIn(t *testing.T, server *Server, c client, gh *httptest.Server) {
	t.Helper()
	server.github = githubApp{clientID: "client", clientSecret: "secret", webURL: gh.URL, apiURL: gh.URL}
	nr := c.noRedirects()
	state := nr.location("/api/github/login").Query().Get("state")
	if got := nr.location("/api/github/callback?code=good&state=" + state).String(); got != "/?github=connected" {
		t.Fatalf("sign-in failed: %s", got)
	}
}

func TestSecurityAlerts(t *testing.T) {
	server, c := newTestServer(t)
	gh := fakeGitHub(t)
	_, snapshot := c.indexLocal(map[string]string{"web/app.js": "x"})
	url := "/api/snapshots/" + snapshot + "/alerts"

	var body struct {
		Available    bool
		Reason       string
		CodeScanning alertSet
		Dependabot   alertSet
	}
	c.json("GET", url, "", 200, &body)
	if body.Available || body.Reason != "not-github" {
		t.Fatalf("local snapshot = %+v", body)
	}

	server.snapshotsMu.Lock()
	server.snapshots[snapshot].Repo = "https://github.com/o/r"
	server.snapshotsMu.Unlock()
	server.github = githubApp{clientID: "client", clientSecret: "secret", webURL: gh.URL, apiURL: gh.URL}
	c.json("GET", url, "", 200, &body)
	if body.Available || body.Reason != "signin" {
		t.Fatalf("signed out = %+v", body)
	}

	signIn(t, server, c, gh)
	c.json("GET", url, "", 200, &body)
	if !body.Available || body.CodeScanning.Status != "ok" || len(body.CodeScanning.Alerts) != 2 {
		t.Fatalf("code scanning = %+v", body.CodeScanning)
	}
	first, second := body.CodeScanning.Alerts[0], body.CodeScanning.Alerts[1]
	if first.Path != "web/app.js" || first.Severity != "critical" || first.Line != 7 || second.Path != "db/query.go" || second.Severity != "high" || second.Title != "SQL injection" {
		t.Fatalf("alerts = %+v", body.CodeScanning.Alerts)
	}
	if body.Dependabot.Status != "forbidden" || body.Dependabot.Alerts == nil || len(body.Dependabot.Alerts) != 0 {
		t.Fatalf("dependabot = %+v", body.Dependabot)
	}
	c.stranger().json("GET", url, "", 404, nil)
}

func TestDependabotAlertsMapToManifests(t *testing.T) {
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{
			{"html_url": "https://github.com/o/r/security/dependabot/3", "dependency": map[string]any{"package": map[string]any{"name": "lodash"}, "manifest_path": "web/package-lock.json"}, "security_advisory": map[string]any{"summary": "Prototype pollution", "severity": "HIGH"}},
			{"html_url": "https://github.com/o/r/security/dependabot/4", "dependency": map[string]any{"package": map[string]any{"name": "x"}, "manifest_path": "go.mod"}, "security_advisory": map[string]any{"severity": "weird"}},
		})
	}))
	defer gh.Close()
	set := githubApp{apiURL: gh.URL}.dependabotAlerts("o/r", "t")
	if set.Status != "ok" || len(set.Alerts) != 2 || set.Alerts[0].Path != "web/package-lock.json" || set.Alerts[0].Severity != "high" || set.Alerts[0].Title != "lodash: Prototype pollution" || set.Alerts[1].Severity != "low" {
		t.Fatalf("dependabot = %+v", set)
	}
}
