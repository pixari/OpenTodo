// Package codesize holds the repository check that keeps the server code
// navigable (OpenSpec change server-code-structure): no function in internal/
// longer than maxFuncLines and no source file longer than maxFileLines.
// Tests are not counted; table tests are long on purpose.
package codesize

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

const (
	// maxFuncLines counts a function from its func line to its closing brace.
	maxFuncLines = 150
	// maxFileLines bounds one non-test source file.
	maxFileLines = 1100
)

// allowFunc lists functions that may stay longer than maxFuncLines, as
// "path/from/internal.go:Recv.Name" (or ":Name") with the reason. Keep it short
// and say why a split would not make the code easier to read.
var allowFunc = map[string]string{}

// allowFile lists files that may stay longer than maxFileLines, with the reason.
var allowFile = map[string]string{}

func TestFunctionAndFileLength(t *testing.T) {
	root := ".."
	fset := token.NewFileSet()
	var long []string
	seenFunc, seenFile := map[string]bool{}, map[string]bool{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if name := d.Name(); name == "testdata" || name == "dist" || name == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel := filepath.ToSlash(strings.TrimPrefix(path, root+string(filepath.Separator)))
		f, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		if lines := fset.File(f.Pos()).LineCount(); lines > maxFileLines {
			seenFile[rel] = true
			if _, ok := allowFile[rel]; !ok {
				long = append(long, rel+" has "+strconv.Itoa(lines)+" lines (limit "+strconv.Itoa(maxFileLines)+")")
			}
		}
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok {
				continue
			}
			n := fset.Position(fn.End()).Line - fset.Position(fn.Pos()).Line + 1
			if n <= maxFuncLines {
				continue
			}
			key := rel + ":" + funcName(fn)
			seenFunc[key] = true
			if _, ok := allowFunc[key]; !ok {
				long = append(long, key+" has "+strconv.Itoa(n)+" lines (limit "+strconv.Itoa(maxFuncLines)+")")
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(long)
	for _, l := range long {
		t.Errorf("%s: split it, or add it to the allow-list with the reason", l)
	}
	// An allow-list entry that no longer applies is removed, so the list only
	// ever shrinks.
	for key := range allowFunc {
		if !seenFunc[key] {
			t.Errorf("allowFunc lists %s, which is no longer over the limit; remove it", key)
		}
	}
	for key := range allowFile {
		if !seenFile[key] {
			t.Errorf("allowFile lists %s, which is no longer over the limit; remove it", key)
		}
	}
}

func funcName(fn *ast.FuncDecl) string {
	if fn.Recv == nil || len(fn.Recv.List) == 0 {
		return fn.Name.Name
	}
	t := fn.Recv.List[0].Type
	if s, ok := t.(*ast.StarExpr); ok {
		t = s.X
	}
	switch x := t.(type) {
	case *ast.IndexExpr:
		t = x.X
	case *ast.IndexListExpr:
		t = x.X
	}
	if id, ok := t.(*ast.Ident); ok {
		return id.Name + "." + fn.Name.Name
	}
	return fn.Name.Name
}
