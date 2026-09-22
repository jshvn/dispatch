package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPing(t *testing.T) {
	var path, body string
	fails := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fails > 0 {
			fails--
			w.WriteHeader(503)
			return
		}
		b, _ := io.ReadAll(r.Body)
		path, body = r.URL.Path, string(b)
	}))
	defer srv.Close()
	nosleep := func(time.Duration) {}

	must(t, ping(srv.Client(), srv.URL+"/uuid", nil, nosleep))
	if path != "/uuid" || body != "" {
		t.Errorf("clean tick pinged %s with %q", path, body)
	}

	fails = 2
	must(t, ping(srv.Client(), srv.URL+"/uuid", []string{"one", strings.Repeat("x", 20<<10)}, nosleep))
	if path != "/uuid/fail" || !strings.HasPrefix(body, "one\nx") || len(body) != pingLimit {
		t.Errorf("failed tick pinged %s with %d bytes; want /uuid/fail, capped at %d", path, len(body), pingLimit)
	}

	fails = 3
	if err := ping(srv.Client(), srv.URL+"/uuid", nil, nosleep); err == nil || strings.Contains(err.Error(), "uuid") {
		t.Errorf("three refused attempts: %v; want an error that does not carry the URL", err)
	}
	if err := ping(srv.Client(), "http://127.0.0.1:1/uuid", nil, nosleep); err == nil || strings.Contains(err.Error(), "uuid") {
		t.Errorf("unreachable: %v; want an error that does not carry the URL", err)
	}
}
