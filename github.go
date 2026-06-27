package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// GitHub App user authorization: the browser is sent to GitHub, the callback exchanges the
// code for a user token held in memory against the session, and clones use that token.
type githubApp struct {
	clientID, clientSecret string
	slug                   string // optional; enables the "grant access to more repositories" link
	webURL, apiURL         string // github.com endpoints, overridden in tests
}

type githubAuth struct {
	token        string
	login        string
	expires      time.Time
	state        string
	stateExpires time.Time
}

var githubClient = &http.Client{Timeout: 15 * time.Second}

func githubAppFromEnv() githubApp {
	return githubApp{
		clientID:     os.Getenv("GITHUB_CLIENT_ID"),
		clientSecret: os.Getenv("GITHUB_CLIENT_SECRET"),
		slug:         os.Getenv("GITHUB_APP_SLUG"),
		webURL:       "https://github.com",
		apiURL:       "https://api.github.com",
	}
}

func (g githubApp) configured() bool { return g.clientID != "" && g.clientSecret != "" }

func (g githubApp) installURL() string {
	if g.slug == "" {
		return ""
	}
	return g.webURL + "/apps/" + url.PathEscape(g.slug) + "/installations/new"
}

func (s *Server) githubRoute(w http.ResponseWriter, r *http.Request, action string) {
	switch {
	case action == "status" && r.Method == http.MethodGet:
		auth := s.githubAuthFor(sessionID(nil, r))
		writeJSON(w, 200, map[string]any{
			"configured": s.github.configured(),
			"connected":  auth.token != "",
			"login":      auth.login,
			"installUrl": s.github.installURL(),
		})
	case !s.github.configured():
		writeError(w, 404, "GitHub sign-in is not configured")
	case action == "login" && r.Method == http.MethodGet:
		sid := sessionID(w, r)
		state := rand.Text()
		s.authMu.Lock()
		auth := s.auth[sid]
		if auth == nil {
			auth = &githubAuth{}
			s.auth[sid] = auth
		}
		auth.state, auth.stateExpires = state, time.Now().Add(10*time.Minute)
		s.authMu.Unlock()
		query := url.Values{"client_id": {s.github.clientID}, "state": {state}}
		http.Redirect(w, r, s.github.webURL+"/login/oauth/authorize?"+query.Encode(), http.StatusFound)
	case action == "callback" && r.Method == http.MethodGet:
		http.Redirect(w, r, "/?github="+s.githubCallback(r), http.StatusFound)
	case action == "logout" && r.Method == http.MethodPost:
		s.authMu.Lock()
		delete(s.auth, sessionID(nil, r))
		s.authMu.Unlock()
		writeJSON(w, 200, map[string]bool{"ok": true})
	default:
		writeError(w, 404, "Unknown GitHub route")
	}
}

// githubCallback completes sign-in and returns the outcome shown to the frontend.
func (s *Server) githubCallback(r *http.Request) string {
	sid, query := sessionID(nil, r), r.URL.Query()
	s.authMu.Lock()
	auth := s.auth[sid]
	valid := auth != nil && auth.state != "" && time.Now().Before(auth.stateExpires) &&
		subtle.ConstantTimeCompare([]byte(auth.state), []byte(query.Get("state"))) == 1
	if auth != nil {
		auth.state = "" // single use
	}
	s.authMu.Unlock()
	if !valid {
		return "error"
	}
	if query.Get("code") == "" {
		return "denied"
	}

	token, lifetime, err := s.github.exchangeCode(query.Get("code"))
	if err != nil {
		return "error"
	}
	login, err := s.github.userLogin(token)
	if err != nil {
		return "error"
	}
	s.authMu.Lock()
	s.auth[sid] = &githubAuth{token: token, login: login, expires: time.Now().Add(lifetime)}
	s.authMu.Unlock()
	return "connected"
}

func (g githubApp) exchangeCode(code string) (string, time.Duration, error) {
	form := url.Values{"client_id": {g.clientID}, "client_secret": {g.clientSecret}, "code": {code}}
	req, _ := http.NewRequest("POST", g.webURL+"/login/oauth/access_token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	res, err := githubClient.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer res.Body.Close()
	var body struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		Error       string `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return "", 0, err
	}
	if body.AccessToken == "" {
		return "", 0, errors.New("token exchange failed: " + body.Error)
	}
	lifetime := time.Duration(body.ExpiresIn) * time.Second
	if lifetime <= 0 {
		lifetime = 8 * time.Hour // apps with token expiry disabled; still forget it eventually
	}
	return body.AccessToken, lifetime, nil
}

func (g githubApp) userLogin(token string) (string, error) {
	req, _ := http.NewRequest("GET", g.apiURL+"/user", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	res, err := githubClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var body struct{ Login string }
	if res.StatusCode != 200 || json.NewDecoder(res.Body).Decode(&body) != nil || body.Login == "" {
		return "", errors.New("could not read GitHub user")
	}
	return body.Login, nil
}

// githubAuthFor returns a copy of the session's GitHub sign-in; token is "" when absent or expired.
func (s *Server) githubAuthFor(sid string) githubAuth {
	s.authMu.Lock()
	defer s.authMu.Unlock()
	auth := s.auth[sid]
	if sid == "" || auth == nil || auth.token == "" || time.Now().After(auth.expires) {
		return githubAuth{}
	}
	return *auth
}

// gitClone builds the clone command. The token travels in environment-provided git config,
// never in the URL or arguments, so it cannot leak through process lists or error output.
func gitClone(ctx context.Context, repoURL, dest, token string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", "clone", "--depth=1", "--single-branch", "--quiet", "--", repoURL, dest)
	// Ignore the host's git config and credential helpers: only the visitor's own token may
	// ever authenticate a clone.
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=credential.helper", "GIT_CONFIG_VALUE_0=")
	if token != "" {
		basic := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + token))
		cmd.Env = append(cmd.Env,
			"GIT_CONFIG_COUNT=2",
			"GIT_CONFIG_KEY_1=http.https://github.com/.extraHeader",
			"GIT_CONFIG_VALUE_1=Authorization: Basic "+basic)
	}
	return cmd
}

// cloneRepo clones with a timeout and returns git's output with the token masked.
func cloneRepo(repoURL, dest, token string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), cloneTimeout)
	defer cancel()
	output, err := gitClone(ctx, repoURL, dest, token).CombinedOutput()
	text := string(output)
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		text = "timed out after " + cloneTimeout.String()
	}
	if token != "" {
		text = strings.ReplaceAll(text, token, "***")
	}
	return text, err
}

// cloneFailure turns git output into a user-facing message and whether signing in (or
// granting the app access) could fix it.
func (g githubApp) cloneFailure(output string, signedIn bool) (message string, authRequired string) {
	lower := strings.ToLower(output)
	needsAuth := false
	for _, hint := range []string{"could not read username", "authentication failed", "repository not found", "terminal prompts disabled", "returned error: 403", "returned error: 401"} {
		needsAuth = needsAuth || strings.Contains(lower, hint)
	}
	switch {
	case !needsAuth:
		return "git clone failed: " + strings.TrimSpace(output), ""
	case !g.configured():
		return "Repository not found. It may be private; load it with Open local folder instead.", ""
	case !signedIn:
		return "This repository is private or does not exist. Sign in with GitHub to open private repositories.", "signin"
	default:
		return "Your GitHub account cannot open this repository through CodeNavigator. Grant the app access to it, then try again.", "install"
	}
}

// Security alert on a file, normalised across code scanning and Dependabot.
type securityAlert struct {
	Path     string `json:"path"`
	Title    string `json:"title"`
	Severity string `json:"severity"` // critical, high, medium or low
	URL      string `json:"url"`
	Line     int    `json:"line,omitempty"`
}

type alertSet struct {
	Status string          `json:"status"` // ok, forbidden (no permission or feature off), unavailable
	Alerts []securityAlert `json:"alerts"`
}

// serveAlerts reports open code scanning and Dependabot alerts for a snapshot's repository,
// fetched with the viewer's own GitHub token so they only ever see what they are allowed to.
func (s *Server) serveAlerts(w http.ResponseWriter, r *http.Request, repo string) {
	ownerRepo, ok := strings.CutPrefix(repo, "https://github.com/")
	if !ok || repo == "" {
		writeJSON(w, 200, map[string]any{"available": false, "reason": "not-github"})
		return
	}
	token := s.githubAuthFor(sessionID(nil, r)).token
	if !s.github.configured() || token == "" {
		writeJSON(w, 200, map[string]any{"available": false, "reason": "signin"})
		return
	}
	var codeScanning, dependabot alertSet
	var wg sync.WaitGroup
	wg.Go(func() { codeScanning = s.github.codeScanningAlerts(ownerRepo, token) })
	wg.Go(func() { dependabot = s.github.dependabotAlerts(ownerRepo, token) })
	wg.Wait()
	writeJSON(w, 200, map[string]any{"available": true, "codeScanning": codeScanning, "dependabot": dependabot})
}

type codeScanningAlert struct {
	HTMLURL string `json:"html_url"`
	Rule    struct {
		ID                    string `json:"id"`
		Severity              string `json:"severity"`
		SecuritySeverityLevel string `json:"security_severity_level"`
		Description           string `json:"description"`
	} `json:"rule"`
	Instance struct {
		Location struct {
			Path      string `json:"path"`
			StartLine int    `json:"start_line"`
		} `json:"location"`
	} `json:"most_recent_instance"`
}

func (g githubApp) codeScanningAlerts(ownerRepo, token string) alertSet {
	raw, status := fetchPages[codeScanningAlert](g, "/repos/"+ownerRepo+"/code-scanning/alerts?state=open&per_page=100", token)
	set := alertSet{Status: status, Alerts: []securityAlert{}}
	for _, a := range raw {
		severity := strings.ToLower(a.Rule.SecuritySeverityLevel)
		if severity == "" {
			severity = map[string]string{"error": "high", "warning": "medium", "note": "low"}[strings.ToLower(a.Rule.Severity)]
		}
		title := a.Rule.Description
		if title == "" {
			title = a.Rule.ID
		}
		set.Alerts = append(set.Alerts, securityAlert{a.Instance.Location.Path, title, orLow(severity), a.HTMLURL, a.Instance.Location.StartLine})
	}
	return set
}

type dependabotAlert struct {
	HTMLURL    string `json:"html_url"`
	Dependency struct {
		Package struct {
			Name string `json:"name"`
		} `json:"package"`
		ManifestPath string `json:"manifest_path"`
	} `json:"dependency"`
	Advisory struct {
		Summary  string `json:"summary"`
		Severity string `json:"severity"`
	} `json:"security_advisory"`
}

func (g githubApp) dependabotAlerts(ownerRepo, token string) alertSet {
	raw, status := fetchPages[dependabotAlert](g, "/repos/"+ownerRepo+"/dependabot/alerts?state=open&per_page=100", token)
	set := alertSet{Status: status, Alerts: []securityAlert{}}
	for _, a := range raw {
		title := a.Dependency.Package.Name
		if a.Advisory.Summary != "" {
			title += ": " + a.Advisory.Summary
		}
		set.Alerts = append(set.Alerts, securityAlert{a.Dependency.ManifestPath, title, orLow(strings.ToLower(a.Advisory.Severity)), a.HTMLURL, 0})
	}
	return set
}

func orLow(severity string) string {
	switch severity {
	case "critical", "high", "medium", "low":
		return severity
	}
	return "low"
}

// fetchPages decodes every page of a GitHub list endpoint, following Link rel="next" only while it
// stays on the API host, up to 10 pages. Status is ok, forbidden (no permission or feature off) or
// unavailable (404, network or decode failure).
func fetchPages[T any](g githubApp, path, token string) ([]T, string) {
	var all []T
	next := g.apiURL + path
	for page := 0; next != "" && page < 10; page++ {
		req, _ := http.NewRequest("GET", next, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		res, err := githubClient.Do(req)
		if err != nil {
			return all, "unavailable"
		}
		var items []T
		decodeErr := json.NewDecoder(io.LimitReader(res.Body, 32<<20)).Decode(&items)
		res.Body.Close()
		switch {
		case res.StatusCode == 401 || res.StatusCode == 403:
			return all, "forbidden"
		case res.StatusCode != 200 || decodeErr != nil:
			return all, "unavailable"
		}
		all = append(all, items...)
		if next = nextLink(res.Header.Get("Link")); !strings.HasPrefix(next, g.apiURL+"/") {
			next = ""
		}
	}
	return all, "ok"
}

func nextLink(header string) string {
	for part := range strings.SplitSeq(header, ",") {
		target, rel, ok := strings.Cut(part, ";")
		if ok && strings.Contains(rel, `rel="next"`) {
			return strings.Trim(strings.TrimSpace(target), "<>")
		}
	}
	return ""
}
