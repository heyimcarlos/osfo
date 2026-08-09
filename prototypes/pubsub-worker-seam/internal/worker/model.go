package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const MatchedOpenRouterModel = "openai/gpt-5-nano"
const MatchedSystemPrompt = "Reply with exactly OK and no other text."
const MatchedUserMessage = "Load characterization message."

type ModelExecutor interface {
	BindingRef() string
	Execute(context.Context, time.Duration) error
}

type SyntheticModelExecutor struct{}

func (SyntheticModelExecutor) BindingRef() string {
	return "benchmark/deterministic-binding-v1"
}

func (SyntheticModelExecutor) Execute(ctx context.Context, workload time.Duration) error {
	timer := time.NewTimer(workload)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

type OpenRouterModelExecutor struct {
	APIKey string
	Client *http.Client
	Model  string
	URL    string
}

func NewOpenRouterModelExecutor(apiKey, model string) OpenRouterModelExecutor {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConns = 256
	transport.MaxIdleConnsPerHost = 256
	transport.MaxConnsPerHost = 256
	return OpenRouterModelExecutor{
		APIKey: apiKey,
		Client: &http.Client{Timeout: 60 * time.Second, Transport: transport},
		Model:  model,
		URL:    "https://openrouter.ai/api/v1/chat/completions",
	}
}

func (executor OpenRouterModelExecutor) BindingRef() string {
	return "openrouter.chat-completions." + strings.ReplaceAll(executor.Model, "/", ".") + ".v1"
}

func (executor OpenRouterModelExecutor) Execute(ctx context.Context, _ time.Duration) error {
	payload, err := json.Marshal(map[string]any{
		"max_tokens": 8,
		"messages": []map[string]string{
			{"content": MatchedSystemPrompt, "role": "system"},
			{"content": MatchedUserMessage, "role": "user"},
		},
		"model": executor.Model,
	})
	if err != nil {
		return fmt.Errorf("encode OpenRouter request: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, executor.URL, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("create OpenRouter request: %w", err)
	}
	request.Header.Set("authorization", "Bearer "+executor.APIKey)
	request.Header.Set("content-type", "application/json")
	response, err := executor.Client.Do(request)
	if err != nil {
		return fmt.Errorf("execute OpenRouter request: %w", err)
	}
	defer response.Body.Close()
	responseBody, readErr := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if readErr != nil {
		return fmt.Errorf("read OpenRouter response: %w", readErr)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("OpenRouter status %d: %s", response.StatusCode, strings.TrimSpace(string(responseBody)))
	}
	return nil
}
