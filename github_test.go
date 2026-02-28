package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os/exec"
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
	cmd := gitClone("https://github.com/o/r", t.TempDir(), "ghu_secret")
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
