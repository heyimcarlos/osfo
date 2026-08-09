package worker

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestOpenRouterModelExecutorUsesMatchedRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("authorization") != "Bearer secret" {
			t.Fatal("missing bearer token")
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		payload := string(body)
		for _, expected := range []string{MatchedOpenRouterModel, MatchedSystemPrompt, MatchedUserMessage, `"max_tokens":8`} {
			if !strings.Contains(payload, expected) {
				t.Fatalf("request does not contain %q: %s", expected, payload)
			}
		}
		response.Header().Set("content-type", "application/json")
		_, _ = response.Write([]byte(`{"choices":[{"message":{"content":"OK"}}]}`))
	}))
	defer server.Close()

	executor := NewOpenRouterModelExecutor("secret", MatchedOpenRouterModel)
	if executor.BindingRef() != "openrouter.chat-completions.openai.gpt-5-nano.v1" {
		t.Fatalf("binding ref = %q", executor.BindingRef())
	}
	executor.Client = server.Client()
	executor.URL = server.URL
	if err := executor.Execute(context.Background(), time.Millisecond); err != nil {
		t.Fatal(err)
	}
}
