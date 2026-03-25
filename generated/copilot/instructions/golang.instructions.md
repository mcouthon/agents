---
applyTo: "**/*.go"
---

# Go Coding Standards

## Code Organization

- Package names: short, lowercase, no underscores, no `util`/`common`/`base`
- One concern per package — if you need a `helpers` package, your design is wrong
- Use `internal/` to prevent external imports of implementation packages
- Exported names need no package prefix: `http.Server` not `http.HTTPServer`
- Avoid `init()` for side effects — prefer explicit initialization functions that return errors

```go
// Good — clear, single-concern package
package user

type Service struct { ... }
func NewService(repo Repository) *Service { ... }

// Bad — grab-bag package
package util

func FormatDate(t time.Time) string { ... }
func HashPassword(pw string) (string, error) { ... }
```

## Error Handling

- Return errors — never panic for expected failure paths
- Wrap with context using `fmt.Errorf("...: %w", err)` to build a chain
- Use sentinel errors (`var ErrNotFound = errors.New(...)`) for conditions callers check
- Use typed errors (custom structs implementing `error`) when callers need structured data
- Check with `errors.Is` (sentinel) or `errors.As` (typed) — never compare strings

```go
// Good — wrapped with context, checkable by caller
var ErrNotFound = errors.New("not found")

func GetUser(id string) (*User, error) {
    u, err := repo.Find(id)
    if err != nil {
        return nil, fmt.Errorf("get user %s: %w", id, err)
    }
    return u, nil
}

// Caller
if errors.Is(err, ErrNotFound) { ... }
```

## Context Propagation

- `ctx context.Context` is always the first parameter
- Propagate context through the call chain — don't store it in structs
- Respect cancellation: check `ctx.Err()` in long loops or before expensive operations
- Use `context.WithTimeout` / `context.WithCancel` to bound operations
- Never pass `nil` context — use `context.Background()` or `context.TODO()`

```go
// Good — context flows through, timeout bounds the call
func (s *Service) Process(ctx context.Context, id string) error {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    data, err := s.repo.Fetch(ctx, id)
    if err != nil {
        return fmt.Errorf("fetch %s: %w", id, err)
    }
    return s.transform(ctx, data)
}
```

## Concurrency

- Every goroutine must have a clear owner that knows when it exits
- Use `sync.WaitGroup` to wait for goroutine completion
- Channels for communication between goroutines, mutexes for protecting shared state
- Mutex rules: keep critical sections small, never hold across I/O or channel ops, embed `sync.Mutex` near the fields it guards
- Never start a goroutine without knowing how it stops

```go
// Good — clear lifecycle, WaitGroup ensures completion
func (s *Service) ProcessAll(ctx context.Context, items []Item) error {
    var wg sync.WaitGroup
    errs := make(chan error, len(items))

    for _, item := range items {
        wg.Add(1)
        go func(it Item) {
            defer wg.Done()
            if err := s.process(ctx, it); err != nil {
                errs <- err
            }
        }(item)
    }

    wg.Wait()
    close(errs)

    for err := range errs {
        return err // return first error
    }
    return nil
}

// Good — mutex near the field it protects
type Cache struct {
    mu    sync.Mutex
    items map[string]Item
}
```

## Generics

- Use generics when behavior is genuinely polymorphic across multiple types
- Always constrain type parameters — `[T comparable]`, `[T cmp.Ordered]`, not `[T any]` when avoidable
- Don't over-genericize for a single concrete type — start concrete, generalize when a second type appears

```go
// Good — genuinely polymorphic
func Map[T, U any](s []T, f func(T) U) []U {
    result := make([]U, len(s))
    for i, v := range s {
        result[i] = f(v)
    }
    return result
}

// Avoid — only ever called with one type
func ProcessItems[T Item](items []T) { ... }
// Just use: func ProcessItems(items []Item) { ... }
```

## Interfaces

- Accept interfaces, return concrete structs
- Keep interfaces small — 1–2 methods is ideal
- Define interfaces at the consumer, not the implementer
- Don't export interfaces just for mocking — that couples tests to implementation

```go
// Good — small interface, defined where it's used
type UserStore interface {
    Find(ctx context.Context, id string) (*User, error)
}

type Service struct {
    store UserStore
}

func NewService(store UserStore) *Service {
    return &Service{store: store}
}
```

## Testing

- Use table-driven tests for multiple cases
- Use `t.Run` for subtests with descriptive names
- Mark helpers with `t.Helper()` for clean failure output
- Use `t.Parallel()` where tests are independent and safe to run concurrently

```go
func TestParseSize(t *testing.T) {
    t.Parallel()

    tests := []struct {
        name    string
        input   string
        want    int64
        wantErr bool
    }{
        {name: "bytes", input: "100B", want: 100},
        {name: "kilobytes", input: "2KB", want: 2048},
        {name: "invalid", input: "abc", wantErr: true},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            t.Parallel()
            got, err := ParseSize(tt.input)
            if (err != nil) != tt.wantErr {
                t.Fatalf("ParseSize(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
            }
            if got != tt.want {
                t.Errorf("ParseSize(%q) = %d, want %d", tt.input, got, tt.want)
            }
        })
    }
}
```

## Common Patterns

### Functional Options

```go
type Option func(*Server)

func WithPort(port int) Option {
    return func(s *Server) { s.port = port }
}

func NewServer(opts ...Option) *Server {
    s := &Server{port: 8080} // sensible default
    for _, o := range opts {
        o(s)
    }
    return s
}
```

### Defer for Cleanup

```go
func ReadConfig(path string) (*Config, error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, fmt.Errorf("open config: %w", err)
    }
    defer f.Close()

    var cfg Config
    if err := json.NewDecoder(f).Decode(&cfg); err != nil {
        return nil, fmt.Errorf("decode config: %w", err)
    }
    return &cfg, nil
}
```

### Struct Embedding

- Embed for behavior reuse, not polymorphism
- Prefer composition over deep embedding hierarchies
- Embedded methods are promoted — be intentional about the exported API surface

```go
// Good — embedding for reuse, clear intent
type Server struct {
    http.Server
    logger *slog.Logger
}

// Avoid — embedding just to get a single method
type Client struct {
    sync.Mutex // promotes Lock/Unlock — is that really your API?
}
```

### Zero-Value Usefulness

Design structs so the zero value is valid and ready to use:

```go
// Good — zero value is a usable, unbuffered writer
type LineWriter struct {
    buf bytes.Buffer
}
```
