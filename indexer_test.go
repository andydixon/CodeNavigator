package main

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func record(id uint32, path string, imports ...string) FileRecord {
	dir, name := "", path
	if i := strings.LastIndexByte(path, '/'); i >= 0 {
		dir, name = path[:i], path[i+1:]
	}
	return FileRecord{ID: id, Path: path, Name: name, Directory: dir, Language: "JavaScript", Imports: imports}
}

func edgePairs(edges []Edge) [][2]uint32 {
	pairs := [][2]uint32{}
	for _, e := range edges {
		pairs = append(pairs, [2]uint32{e.From, e.To})
	}
	return pairs
}

func TestResolvesRelativeImportsIncludesAndIndexFiles(t *testing.T) {
	edges := linkFiles([]FileRecord{
		record(1, "src/main.js", "./utils.js", "../include/config.h", "./widgets", "./utils.js"),
		record(2, "src/utils.js"),
		record(3, "include/config.h"),
		record(4, "src/widgets/index.ts"),
		record(5, "elsewhere/utils.js"),
	})
	if got, want := edgePairs(edges), [][2]uint32{{1, 2}, {1, 3}, {1, 4}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("edges = %v, want %v", got, want)
	}
	if edges[0].Confidence != "known" {
		t.Fatalf("relative import confidence = %q", edges[0].Confidence)
	}
}

func TestResolvesHeaderSuffixWithoutGuessingAmbiguousNames(t *testing.T) {
	edges := linkFiles([]FileRecord{
		record(1, "main.c", "config.h", "utils.js", "missing.js"),
		record(2, "include/config.h"),
		record(3, "a/utils.js"),
		record(4, "b/utils.js"),
	})
	if got, want := edgePairs(edges), [][2]uint32{{1, 2}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("edges = %v, want %v", got, want)
	}
}

func TestResolvesDottedModulesAsInferred(t *testing.T) {
	a := record(1, "app/main.py", "app.models.user")
	a.Language = "Python"
	edges := linkFiles([]FileRecord{a, record(2, "app/models/user.py")})
	if len(edges) != 1 || edges[0].To != 2 || edges[0].Confidence != "inferred" {
		t.Fatalf("edges = %+v", edges)
	}
}

func TestExtractsNamedJavaScriptImportTarget(t *testing.T) {
	var imports []string
	for _, p := range importPatterns {
		if m := p.re.FindStringSubmatch("import { render } from './renderer.js';"); m != nil {
			imports = append(imports, m[1])
		}
	}
	if !reflect.DeepEqual(imports, []string{"./renderer.js"}) {
		t.Fatalf("imports = %v", imports)
	}
}

func TestClassifiesLanguagesAndLayers(t *testing.T) {
	for in, want := range map[string]string{"rs": "Rust", "tsx": "TypeScript", "cpp": "C++", "zzz": "Other"} {
		if got := languageFor(in); got != want {
			t.Errorf("languageFor(%q) = %q, want %q", in, got, want)
		}
	}
	for in, want := range map[string]string{"src/widget.test.ts": "test", "vendor/lib.c": "vendor", "a/gen/x.go": "generated", "README.md": "docs", "src/main.go": "application"} {
		if got := layerFor(in); got != want {
			t.Errorf("layerFor(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExtractsCommonSymbols(t *testing.T) {
	for _, line := range []string{"pub fn render_scene() {", "class WindowManager {", "public void run() throws IOException"} {
		matched := false
		for _, p := range definitionPatterns {
			matched = matched || p.re.MatchString(line)
		}
		if !matched {
			t.Errorf("no definition pattern matched %q", line)
		}
	}
}

func TestExtensionOf(t *testing.T) {
	for in, want := range map[string]string{"a.rs": "rs", ".gitignore": "", "a.tar.gz": "gz", "Makefile": ""} {
		if got := extensionOf(in); got != want {
			t.Errorf("extensionOf(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIgnoreRules(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("# c\n*.log\n/out/\n!keep.log\ndocs/**/*.tmp\n"), 0o644)
	rules := loadIgnoreFile(filepath.Join(dir, ".gitignore"), "")
	cases := []struct {
		path  string
		isDir bool
		want  bool
	}{
		{"a.log", false, true}, {"deep/b.log", false, true}, {"keep.log", false, false},
		{"out", true, true}, {"src/out", true, false}, {"out", false, false},
		{"docs/x/y/z.tmp", false, true}, {"docs/z.tmp", false, true}, {"z.tmp", false, false},
	}
	for _, c := range cases {
		if got := ignored(rules, c.path, c.isDir); got != c.want {
			t.Errorf("ignored(%q, %v) = %v, want %v", c.path, c.isDir, got, c.want)
		}
	}
}

func writeTree(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for path, content := range files {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestIndexDirectory(t *testing.T) {
	root := writeTree(t, map[string]string{
		"src/main.js":         "import { util } from './util.js';\r\nfunction main() {\n  if (a && b) { util(); }\n}\n",
		"src/util.js":         "export function util() {\n}\n",
		"node_modules/x.js":   "skipped",
		"build":               "skipped file named build",
		"image.bin":           "\x00\x01binary",
		"ignored.log":         "ignored by .ignore",
		".ignore":             "*.log\n",
		"sub/.gitignore":      "*.js\n", // not a git checkout, so this is not honoured
		"sub/kept.js":         "x\xffy",
		".hidden/visible.txt": "hidden dirs are walked",
	})
	var phases []string
	snapshot, err := indexDirectory(root, func(phase string, _, _ int, _ string) { phases = append(phases, phase) })
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for i, f := range snapshot.Files {
		if f.ID != uint32(i+1) {
			t.Errorf("file %s has id %d, want %d", f.Path, f.ID, i+1)
		}
		paths = append(paths, f.Path)
	}
	want := []string{".hidden/visible.txt", ".ignore", "src/main.js", "src/util.js", "sub/.gitignore", "sub/kept.js"}
	if !reflect.DeepEqual(paths, want) {
		t.Fatalf("paths = %v, want %v", paths, want)
	}
	main := snapshot.Files[2]
	if main.Lines != 4 || main.Complexity != 3 || main.Language != "JavaScript" || main.Directory != "src" || main.Name != "main.js" {
		t.Errorf("main.js record = %+v", main)
	}
	if !strings.HasPrefix(main.Preview, "import { util } from './util.js';\nfunction main() {") {
		t.Errorf("preview = %q", main.Preview)
	}
	if len(main.Symbols) != 2 || main.Symbols[0].Name != "main" || main.Symbols[0].Line != 2 {
		t.Errorf("symbols = %+v", main.Symbols)
	}
	if got := edgePairs(snapshot.Edges); !reflect.DeepEqual(got, [][2]uint32{{3, 4}}) {
		t.Errorf("edges = %v", got)
	}
	if snapshot.Files[5].Preview != "x�y" {
		t.Errorf("invalid UTF-8 preview = %q", snapshot.Files[5].Preview)
	}
	if snapshot.References != 1 || snapshot.Definitions != 3 || phases[len(phases)-1] != "linking" {
		t.Errorf("snapshot totals refs=%d defs=%d phases=%v", snapshot.References, snapshot.Definitions, phases)
	}
}

func TestGitignoreHonouredInsideCheckout(t *testing.T) {
	root := writeTree(t, map[string]string{".git/HEAD": "ref", ".gitignore": "gen/\n", "gen/a.go": "x", "main.go": "package main"})
	paths, err := walkSource(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 2 || !strings.HasSuffix(paths[0], ".gitignore") || !strings.HasSuffix(paths[1], "main.go") {
		t.Fatalf("paths = %v", paths)
	}
}

func TestEmptyDirectoryFails(t *testing.T) {
	if _, err := indexDirectory(t.TempDir(), func(string, int, int, string) {}); err == nil {
		t.Fatal("expected error for empty directory")
	}
}

// BenchmarkIndexDirectory indexes CODENAV_BENCH_DIR, defaulting to the Go standard library source.
func BenchmarkIndexDirectory(b *testing.B) {
	dir := os.Getenv("CODENAV_BENCH_DIR")
	if dir == "" {
		dir = filepath.Join(runtime.GOROOT(), "src")
	}
	if _, err := os.Stat(dir); err != nil {
		b.Skip("no benchmark corpus:", err)
	}
	for b.Loop() {
		if _, err := indexDirectory(dir, func(string, int, int, string) {}); err != nil {
			b.Fatal(err)
		}
	}
}
