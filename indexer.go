package main

import (
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

type Symbol struct {
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Line      int    `json:"line"`
	Signature string `json:"signature"`
}

type FileRecord struct {
	ID         uint32   `json:"id"`
	Path       string   `json:"path"`
	Name       string   `json:"name"`
	Directory  string   `json:"directory"`
	Extension  string   `json:"extension"`
	Language   string   `json:"language"`
	Layer      string   `json:"layer"`
	Lines      int      `json:"lines"`
	Bytes      int      `json:"bytes"`
	Complexity int      `json:"complexity"`
	Preview    string   `json:"preview"`
	Symbols    []Symbol `json:"symbols"`
	Imports    []string `json:"imports"`
}

type Edge struct {
	From       uint32 `json:"from"`
	To         uint32 `json:"to"`
	Kind       string `json:"kind"`
	Confidence string `json:"confidence"`
}

type Snapshot struct {
	ID, Name, Source string
	Owner            string // session that created the snapshot
	Files            []FileRecord
	Edges            []Edge
	TotalLines       int
	Definitions      int
	References       int
	Warnings         []string
	Root             string
	lastUsed         time.Time
	delivered        map[uint32][][2]int
	released         map[uint32]bool
}

// Each pattern has a cheap literal prefilter that is a necessary condition for a match,
// so the (much slower) regexp only runs on candidate lines.
type pattern struct {
	kind  string
	maybe func(line string) bool
	re    *regexp.Regexp
}

func containsAny(literals ...string) func(string) bool {
	return func(line string) bool {
		for _, literal := range literals {
			if strings.Contains(line, literal) {
				return true
			}
		}
		return false
	}
}

// callWithBody needs "(", then ")", then "{", "=>" or "throws" after that ")".
func callWithBody(line string) bool {
	open := strings.IndexByte(line, '(')
	if open < 0 {
		return false
	}
	close := strings.IndexByte(line[open:], ')')
	if close < 0 {
		return false
	}
	tail := line[open+close:]
	return strings.Contains(tail, "{") || strings.Contains(tail, "=>") || strings.Contains(tail, "throws")
}

var definitionPatterns = []pattern{
	{"class", containsAny("class", "struct", "enum", "trait", "interface", "record"), regexp.MustCompile(`(?:class|struct|enum|trait|interface|record)\s+([A-Za-z_][A-Za-z0-9_]*)`)},
	{"function", containsAny("fn", "func", "def"), regexp.MustCompile(`(?:fn|func|def|function)\s+([A-Za-z_][A-Za-z0-9_]*)`)},
	{"function", callWithBody, regexp.MustCompile(`(?:public|private|protected|static|async|export|const|let|var|unsafe|pub|virtual|override|inline|final|synchronized|abstract|extern|\s)+\s*([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:\{|=>|throws)`)},
}

var importPatterns = []pattern{
	{"", containsAny("from"), regexp.MustCompile(`from\s+["']?([^"';\s]+)`)},
	{"", containsAny("import"), regexp.MustCompile(`import\s*["']([^"']+)`)},
	{"", containsAny("import"), regexp.MustCompile(`^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)\s*(?:;|$|\bas\b)`)},
	{"", containsAny("import"), regexp.MustCompile(`import\s*\(\s*["']([^"']+)`)},
	{"", containsAny("require"), regexp.MustCompile(`require\s*\(\s*["']([^"']+)`)},
	{"", containsAny("#include"), regexp.MustCompile(`#include\s*[<"]([^>"]+)`)},
	{"", containsAny("use", "mod"), regexp.MustCompile(`(?:use|mod)\s+([A-Za-z_][A-Za-z0-9_:]*)`)},
	{"", containsAny("using"), regexp.MustCompile(`using\s+([A-Za-z_][A-Za-z0-9_.]*)`)},
}

var complexityTokens = []string{" if ", " for ", " while ", " match ", " switch ", "&&", "||"}

const previewBudget = 48 * 1024 * 1024

// indexDirectory walks root and parses files in parallel; IDs follow walk order.
func indexDirectory(root string, progress func(phase string, completed, total int, message string)) (*Snapshot, error) {
	paths, err := walkSource(root)
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("No readable files were found")
	}

	total := len(paths)
	records := make([]*FileRecord, total)
	warnings := make([]string, total)
	var next, done atomic.Int64
	var wg sync.WaitGroup
	for range runtime.GOMAXPROCS(0) {
		wg.Go(func() {
			for {
				i := int(next.Add(1) - 1)
				if i >= total {
					return
				}
				records[i], warnings[i] = parseFile(root, paths[i])
				if n := done.Add(1); n%20 == 1 {
					progress("parsing", int(n-1), total, fmt.Sprintf("Parsing %d of %d", n, total))
				}
			}
		})
	}
	wg.Wait()

	files := make([]FileRecord, 0, total)
	snapshot := &Snapshot{Root: root, Warnings: []string{}, delivered: map[uint32][][2]int{}, released: map[uint32]bool{}}
	for i, record := range records {
		if warnings[i] != "" {
			snapshot.Warnings = append(snapshot.Warnings, warnings[i])
		}
		if record != nil {
			record.ID = uint32(len(files) + 1)
			files = append(files, *record)
		}
	}
	progress("linking", len(files), len(files), "Linking files and symbols…")

	previewBytes := 0
	for i := range files {
		previewBytes += len(files[i].Preview)
	}
	if previewBytes > previewBudget {
		perFile := max(previewBudget/max(len(files), 1), 32)
		for i := range files {
			if p := files[i].Preview; len(p) > perFile {
				end := perFile
				for end > 0 && !utf8.RuneStart(p[end]) {
					end--
				}
				files[i].Preview = p[:end]
			}
		}
	}

	snapshot.Edges = linkFiles(files)
	// Imports are only an indexing intermediate; edges carry what the frontend needs.
	for i := range files {
		files[i].Imports = []string{}
		snapshot.TotalLines += files[i].Lines
		snapshot.Definitions += len(files[i].Symbols)
	}
	snapshot.Files = files
	snapshot.References = len(snapshot.Edges)
	return snapshot, nil
}

// parseFile returns nil for skipped files (binary or >8MB) and a warning for unreadable ones.
func parseFile(root, path string) (*FileRecord, string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Sprintf("%s: %v", path, err)
	}
	if len(data) > 8*1024*1024 || bytes.IndexByte(data[:min(len(data), 4096)], 0) >= 0 {
		return nil, ""
	}
	text := string(data)
	if !utf8.ValidString(text) {
		// ponytail: one U+FFFD per run of invalid bytes (Rust emits one per maximal subpart); only binary-ish previews differ.
		text = strings.ToValidUTF8(text, "�")
	}
	relative, err := filepath.Rel(root, path)
	if err != nil {
		relative = path
	}
	relative = filepath.ToSlash(relative)
	name := filepath.Base(path)
	extension := strings.ToLower(extensionOf(name))

	record := &FileRecord{
		Path:       relative,
		Name:       name,
		Extension:  extension,
		Language:   languageFor(extension),
		Layer:      layerFor(relative),
		Bytes:      len(data),
		Complexity: 1,
		Symbols:    []Symbol{},
	}
	if i := strings.LastIndexByte(relative, '/'); i >= 0 {
		record.Directory = relative[:i]
	}

	preview := make([]string, 0, 60)
	for len(text) > 0 {
		line, rest, found := strings.Cut(text, "\n")
		if found {
			line = strings.TrimSuffix(line, "\r")
		}
		text = rest
		record.Lines++
		if len(preview) < 60 {
			preview = append(preview, line)
		}
		for _, token := range complexityTokens {
			if strings.Contains(line, token) {
				record.Complexity++
			}
		}
		if mayDefine(line) {
			for _, pattern := range definitionPatterns {
				if !pattern.maybe(line) {
					continue
				}
				if m := pattern.re.FindStringSubmatchIndex(line); m != nil && m[2] >= 0 {
					record.Symbols = append(record.Symbols, Symbol{strings.Clone(line[m[2]:m[3]]), pattern.kind, record.Lines, strings.Clone(truncateRunes(strings.TrimSpace(line), 180))})
					break
				}
			}
		}
		if mayImport(line) {
			for _, pattern := range importPatterns {
				if !pattern.maybe(line) {
					continue
				}
				if m := pattern.re.FindStringSubmatchIndex(line); m != nil && m[2] >= 0 {
					record.Imports = append(record.Imports, strings.Clone(line[m[2]:m[3]]))
				}
			}
		}
	}
	record.Lines = max(record.Lines, 1)
	// Enough source for zoomed-in tiles without copying whole repositories into the scene.
	record.Preview = strings.Clone(strings.Join(preview, "\n")) // Join aliases a lone line
	return record, ""
}

func mayDefine(line string) bool {
	return strings.Contains(line, "(") || strings.Contains(line, "class ") || strings.Contains(line, "struct ") ||
		strings.Contains(line, "enum ") || strings.Contains(line, "interface ") || strings.Contains(line, "fn ") ||
		strings.Contains(line, "func ") || strings.Contains(line, "def ") || strings.Contains(line, "function ")
}

func mayImport(line string) bool {
	return strings.Contains(line, "import") || strings.Contains(line, "from ") || strings.Contains(line, "require") ||
		strings.Contains(line, "#include") || strings.Contains(line, "use ") || strings.Contains(line, "mod ") ||
		strings.Contains(line, "using ")
}

func truncateRunes(s string, n int) string {
	for i := range s {
		if n == 0 {
			return s[:i]
		}
		n--
	}
	return s
}

// extensionOf mirrors Rust's Path::extension: dotfiles like ".gitignore" have none.
func extensionOf(name string) string {
	if i := strings.LastIndexByte(name, '.'); i > 0 {
		return name[i+1:]
	}
	return ""
}

var skippedNames = map[string]bool{".git": true, "target": true, "node_modules": true, ".next": true, "dist": true, "build": true}

// walkSource lists regular files in lexical order, honouring .ignore files everywhere
// and .gitignore files inside git checkouts.
func walkSource(root string) ([]string, error) {
	var paths []string
	var rules []ignoreRule
	inGit := false
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entries are skipped, like the ignore crate's walker
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		if path != root {
			if skippedNames[d.Name()] || ignored(rules, rel, d.IsDir()) {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
		}
		if !d.IsDir() {
			if d.Type().IsRegular() {
				paths = append(paths, path)
			}
			return nil
		}
		if _, err := os.Stat(filepath.Join(path, ".git")); err == nil {
			inGit = true
		}
		base := ""
		if path != root {
			base = rel + "/"
		}
		if inGit {
			rules = append(rules, loadIgnoreFile(filepath.Join(path, ".gitignore"), base)...)
		}
		rules = append(rules, loadIgnoreFile(filepath.Join(path, ".ignore"), base)...)
		return nil
	})
	return paths, err
}

type ignoreRule struct {
	re      *regexp.Regexp
	negate  bool
	dirOnly bool
	base    string // slash-terminated directory the rule file lives in, "" for root
	anyDir  bool   // pattern without a slash matches the basename at any depth
}

// ponytail: covers standard gitignore globs (*, ?, **, [], !, trailing /); no global or .git/info/exclude files.
func loadIgnoreFile(path, base string) []ignoreRule {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var rules []ignoreRule
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimRight(strings.TrimSuffix(line, "\r"), " ")
		if line == "" || line[0] == '#' {
			continue
		}
		rule := ignoreRule{base: base}
		if line[0] == '!' {
			rule.negate, line = true, line[1:]
		} else if line[0] == '\\' {
			line = line[1:]
		}
		if strings.HasSuffix(line, "/") {
			rule.dirOnly, line = true, strings.TrimSuffix(line, "/")
		}
		rule.anyDir = !strings.Contains(line, "/")
		line = strings.TrimPrefix(line, "/")
		if line == "" {
			continue
		}
		if re, err := regexp.Compile("^" + globToRegexp(line) + "$"); err == nil {
			rule.re = re
			rules = append(rules, rule)
		}
	}
	return rules
}

func globToRegexp(glob string) string {
	var b strings.Builder
	for i := 0; i < len(glob); i++ {
		switch c := glob[i]; {
		case strings.HasPrefix(glob[i:], "**/"):
			b.WriteString("(?:.*/)?")
			i += 2
		case strings.HasPrefix(glob[i:], "**"):
			b.WriteString(".*")
			i++
		case c == '*':
			b.WriteString("[^/]*")
		case c == '?':
			b.WriteString("[^/]")
		case c == '[':
			if end := strings.IndexByte(glob[i+1:], ']'); end > 0 {
				class := glob[i+1 : i+1+end]
				if class[0] == '!' {
					class = "^" + class[1:]
				}
				b.WriteString("[" + strings.ReplaceAll(class, `\`, `\\`) + "]")
				i += end + 1
			} else {
				b.WriteString(`\[`)
			}
		case c == '\\' && i+1 < len(glob):
			i++
			b.WriteString(regexp.QuoteMeta(glob[i : i+1]))
		default:
			b.WriteString(regexp.QuoteMeta(glob[i : i+1]))
		}
	}
	return b.String()
}

// ignored applies rules in order; later (deeper) rules override earlier ones.
func ignored(rules []ignoreRule, rel string, isDir bool) bool {
	result := false
	for _, rule := range rules {
		if (rule.dirOnly && !isDir) || !strings.HasPrefix(rel, rule.base) {
			continue
		}
		target := rel[len(rule.base):]
		if rule.anyDir {
			target = target[strings.LastIndexByte(target, '/')+1:]
		}
		if rule.re.MatchString(target) {
			result = !rule.negate
		}
	}
	return result
}

func linkFiles(files []FileRecord) []Edge {
	exact := make(map[string]uint32, len(files))
	lookup := make(map[string]uint32, len(files)*4) // 0 marks an ambiguous key
	add := func(key string, id uint32) {
		if old, ok := lookup[key]; ok && old != id {
			lookup[key] = 0
		} else if !ok {
			lookup[key] = id
		}
	}
	for i := range files {
		file := &files[i]
		path := strings.ReplaceAll(file.Path, `\`, "/")
		ext := extensionOf(file.Name)
		extensionless := path
		stem := file.Name
		if ext != "" {
			extensionless = path[:len(path)-len(ext)-1]
			stem = file.Name[:len(file.Name)-len(ext)-1]
		}
		exact[path] = file.ID
		add(path, file.ID)
		add(file.Name, file.ID)
		add(extensionless, file.ID)
		if dir, ok := strings.CutSuffix(extensionless, "/index"); ok {
			add(dir, file.ID)
		}
		for j := range len(path) {
			if path[j] == '/' {
				add(path[j+1:], file.ID)
			}
		}
		for j := range len(extensionless) {
			if extensionless[j] == '/' {
				add(extensionless[j+1:], file.ID)
			}
		}
		if stem != "" {
			add(stem, file.ID)
		}
	}
	resolve := func(key string) uint32 {
		if id, ok := exact[key]; ok {
			return id
		}
		return lookup[key]
	}

	type pair struct{ from, to uint32 }
	seen := map[pair]bool{}
	edges := []Edge{}
	for i := range files {
		file := &files[i]
		for _, imp := range file.Imports {
			imp = strings.ReplaceAll(imp, `\`, "/")
			relativeImport := strings.HasPrefix(imp, ".")
			direct := resolve(normalizePath(file.Directory + "/" + imp))
			if direct == 0 && !relativeImport {
				direct = resolve(normalizePath(imp))
			}
			target := direct
			if target == 0 && !relativeImport {
				module := strings.ReplaceAll(imp, "::", "/")
				if file.Language == "Python" || file.Language == "Java" || file.Language == "C#" {
					module = strings.ReplaceAll(module, ".", "/")
				}
				if target = resolve(module); target == 0 {
					target = lookup[module[strings.LastIndexByte(module, '/')+1:]]
				}
			}
			if target != 0 && target != file.ID && !seen[pair{file.ID, target}] {
				seen[pair{file.ID, target}] = true
				confidence := "inferred"
				if direct != 0 {
					confidence = "known"
				}
				edges = append(edges, Edge{file.ID, target, "import", confidence})
			}
		}
	}
	return edges
}

func normalizePath(path string) string {
	parts := make([]string, 0, 8)
	for part := range strings.SplitSeq(path, "/") {
		switch part {
		case "", ".":
		case "..":
			if len(parts) > 0 {
				parts = parts[:len(parts)-1]
			}
		default:
			parts = append(parts, part)
		}
	}
	return strings.Join(parts, "/")
}

var languages = map[string]string{}

func init() {
	for language, extensions := range map[string]string{
		"JavaScript": "js jsx mjs cjs", "TypeScript": "ts tsx", "Python": "py pyi", "Rust": "rs", "Go": "go",
		"C": "c h", "C++": "cc cpp cxx hpp hh", "Java": "java", "C#": "cs", "F#": "fs fsx", "Kotlin": "kt kts",
		"Swift": "swift", "Scala": "scala sc", "Dart": "dart", "PHP": "php", "Ruby": "rb", "R": "r", "Perl": "pl pm",
		"Lua": "lua", "SQL": "sql", "Elixir": "ex exs", "Erlang": "erl hrl", "Haskell": "hs lhs", "OCaml": "ml mli",
		"Clojure": "clj cljs cljc edn", "Zig": "zig", "Nim": "nim", "Solidity": "sol", "Groovy": "groovy gradle",
		"HTML": "html htm", "Markup": "xml svg vue svelte", "CSS": "css scss sass less",
		"Data": "json jsonc toml yaml yml ini properties", "Docs": "md mdx txt rst", "Shell": "sh zsh bash fish",
	} {
		for ext := range strings.FieldsSeq(extensions) {
			languages[ext] = language
		}
	}
}

func languageFor(extension string) string {
	if language, ok := languages[extension]; ok {
		return language
	}
	return "Other"
}

func layerFor(path string) string {
	lower := strings.ToLower(path)
	has := func(subs ...string) bool {
		for _, s := range subs {
			if strings.Contains(lower, s) {
				return true
			}
		}
		return false
	}
	switch {
	case has("test", "spec", "fixture"):
		return "test"
	case has("vendor", "third_party", "external"):
		return "vendor"
	case has("generated", "gen/") || strings.HasSuffix(lower, ".min.js"):
		return "generated"
	case has("platform", "windows", "linux", "darwin"):
		return "platform"
	case has("lib/", "libs/", "packages/"):
		return "library"
	case has("docs/") || strings.HasSuffix(lower, ".md"):
		return "docs"
	}
	return "application"
}
